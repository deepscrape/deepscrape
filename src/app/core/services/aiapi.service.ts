import { HttpClient, HttpDownloadProgressEvent, HttpErrorResponse, HttpEvent, HttpEventType, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs/internal/Observable';
import { throwError } from 'rxjs/internal/observable/throwError';
import { catchError } from 'rxjs/internal/operators/catchError';
import { map } from 'rxjs/internal/operators/map';
import { tap } from 'rxjs/internal/operators/tap';
import { environment } from 'src/environments/environment';
import { anthropicTools, arrayBufferToString, customUrlEncoder, isGroqModel, openaiTools, sanitizeJSON, type AiToolSpec } from '../functions';
import { API_ANTHROPIC, API_GROQAI, API_JINAAI, API_OPENAI } from '../variables';
import { scan } from 'rxjs/internal/operators/scan';
import { claudeAiApiStreamData, CrawlPack, CrawlTask, JinaOptions } from '../types';
import { filter } from 'rxjs/internal/operators/filter';
import { Subject } from 'rxjs/internal/Subject';
import { from } from 'rxjs/internal/observable/from';
import { mergeMap } from 'rxjs/internal/operators/mergeMap';
import { switchMap } from 'rxjs/internal/operators/switchMap';
import { AuthService } from './auth.service';

@Injectable({
  providedIn: 'root'
})
export class AiAPIService {

  private claudeAiEndpoint: string
  private openAiEndpoint: string

  private groqAiEndpoint: string

  private jinaAiEndpoint: string


  private subjectClaudeAI = new Subject<claudeAiApiStreamData>()
  private subjectOpenAI = new Subject<{ content: string, usage: any | null, role: any | null }>()

  constructor(private http: HttpClient, private authService: AuthService) {

    // Replace with actual AI API endpoint each model
    this.claudeAiEndpoint = API_ANTHROPIC + '/messages'  // Updated URL
    this.openAiEndpoint = API_OPENAI + '/chat/completions' // Updated URL
    this.groqAiEndpoint = API_GROQAI + '/chat/completions' // Updated URL
    this.jinaAiEndpoint = API_JINAAI + '/'// Updated URL

    // initialize auth state
    // this.authService.initAuth()
  }

  sendToJinaAI(url: string, options: JinaOptions, cookies?: string): Observable<string> {

    const encodedUrl = environment.JINAAI_API_KEY !== '' ? url : customUrlEncoder(url);
    console.log("encodedUrl: ", encodedUrl)
    const jinaAiReaderEndpoint: string = this.jinaAiEndpoint + encodedUrl
    const cookie = options.forwardCookies && cookies && cookies?.length ? { "X-Set-Cookie": cookies } : null // If cookies are provided, append them to the headers, )
    const headers = new HttpHeaders({
      // The BFF's `/api/jina/:url` route is behind `isJwtAuth`, which reads the
      // `authorization` header — so the CALLER's Firebase token belongs there.
      //
      // This used to send `Authorization: Bearer 'JINAAI_API_KEY'` — the literal
      // quoted string, not the value of any variable — from the browser. Since
      // the route is `isJwtAuth`-guarded, every call was a 401. The provider key
      // itself must never come from the browser anyway: `jinaAICrawl` holds it
      // server-side (`env.JINAAI_API_KEY`) and is the only thing that dials
      // r.jina.ai.
      'Authorization': `Bearer ${this.authService.token}`,
      'Accept': 'application/json',
      // "X-With-Links-Summary": "true",
      "X-With-Iframe": options.iframe,
      "X-Return-Format": "markdown",
      "X-Target-Selector": "body",
      "X-With-Generated-Alt": "true",
      ...cookie
    })
    return this.http.get(jinaAiReaderEndpoint, { headers/* , transferCache: true */, responseType: 'arraybuffer' })
      .pipe(
        map((response: ArrayBuffer) => JSON.parse(arrayBufferToString(response))),
        tap((response: any) => {

          const data = {
            code: response.code,
            title: response.data.title,
            status: response.status,
            url: response.data.url,
            tokens: response.data.usage?.tokens
          }
          console.log('Response data:', data)
        }),
        map((response: any) => response.data.content),
        catchError(error => {
          console.error('Error in Jina AI API call:', error)
          throw error
        })

      )
  }

  /**
   * One Claude round WITH tools, non-streaming, returning the parsed reply.
   *
   * Why not the streaming path beside it
   * -----------------------------------
   * A tool call has to be read whole before anything runs, and Anthropic streams
   * one as `input_json_delta` fragments while the streaming methods here emit
   * decoded TEXT. Accumulating those fragments would mean a second stream parser
   * for a reply that is not text. `stream` is simply absent from the body, so the
   * reply arrives parsed and `anthropicToolCalls` can read it.
   *
   * Only the tool round loses streaming. The caller renders the FINAL answer,
   * which this returns whole.
   * @param {Array} messages The conversation, as the streaming methods take it.
   * @param {string} modelName The model id.
   * @param {string} system The system prompt.
   * @param {Array} tools The specs to offer, from `availableTools()`.
   * @return {Observable<unknown>} The parsed response body.
   */
  askClaudeOnce(
    messages: { role: string, content: unknown }[],
    modelName: string,
    system: string,
    tools: readonly AiToolSpec[]
  ): Observable<unknown> {
    return this.http.post(this.claudeAiEndpoint, {
      model: modelName,
      max_tokens: 4096,
      system,
      messages,
      tools: anthropicTools(tools),
    }, {
      headers: new HttpHeaders({
        // The CALLER's token, in the header the BFF's `isJwtAuth` actually reads.
        // The provider key is never sent from here: the BFF resolves it itself with
        // `keyFor(req, vendor, env.KEY)`, preferring the caller's own stored key.
        'Authorization': `Bearer ${this.authService.token}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      }),
    })
  }

  /**
   * One OpenAI-shaped round WITH tools, non-streaming, returning the parsed reply.
   *
   * The vendor is decided by `isGroqModel` exactly as `sendToOpenAI` decides it, so
   * a Groq model offered a tool reaches Groq rather than OpenAI. They speak the same
   * wire protocol, so endpoint and key are the whole difference.
   *
   * `tools` is omitable rather than sent empty on the answering round: an empty
   * array is rejected by some providers, and offering tools there would invite
   * another call rather than an answer.
   * @param {Array} messages The conversation, system turn included by the caller.
   * @param {string} modelName The model id.
   * @param {Array} tools The specs to offer; omit for the answering round.
   * @return {Observable<unknown>} The parsed response body.
   */
  askOpenAiOnce(
    messages: { role: string, content: unknown }[],
    modelName: string,
    tools?: readonly AiToolSpec[]
  ): Observable<unknown> {
    const apiEndpoint = isGroqModel(modelName)
      ? this.groqAiEndpoint
      : this.openAiEndpoint

    return this.http.post(apiEndpoint, {
      model: modelName,
      max_tokens: 8000,
      temperature: 0,
      messages,
      ...(tools && tools.length > 0 ? { tools: openaiTools(tools) } : {}),
    }, {
      headers: new HttpHeaders({
        // The CALLER's token, not a provider key. See `askClaudeOnce`.
        'Authorization': `Bearer ${this.authService.token}`,
        'content-type': 'application/json',
      }),
    })
  }

  sendToClaudeAI(content: string | { role: string, content: string }[], modelName: string = 'claude-3-5-sonnet-20241022', sys?: string): Observable<{ content: string, role: string, usage: any | null }> {
    // The provider is not a decision on this path -- the method IS Claude. The old
    // switch call returned these same two fields unchanged, and the fourth element
    // of its tuple was never read here.
    const model = modelName
    const apiEndpoint = this.claudeAiEndpoint
    const headers = new HttpHeaders({
      // The CALLER's token, in the header `isJwtAuth` reads. Nothing else: a provider
      // key must never come from the browser, and the BFF resolves it with `keyFor`.
      'Authorization': `Bearer ${this.authService.token}`,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      "anthropic-dangerous-direct-browser-access": "true",
    })

    const system = sys || `You are a helpful assistant.Extract all recipe information from website content also clean unnecessary special characters
    recipe details like image video link steps or any usage data and return in JSON format. If a field is missing, use null.
    Do not say anything else.`/* `extract all product information from website content also clean unnecessary special characters
                     products details as an array and return in JSON format with four keys:
                     code: number, price (number), title (string), productLink (string), discount (number). If a field is missing, use null.
                     Do not say anything else.` */



    const messages = Array.isArray(content) ? content : [
      { "role": "user", "content": `${content}` }
    ];

    const body = {
      model, //  claude-3-5-sonnet-20240620
      "max_tokens": 4096,
      system,
      "messages": messages,
      stream: true
    }


    let previousText = '';
    let usage: { "prompt_tokens": number, "completion_tokens": number } = { prompt_tokens: 0, completion_tokens: 0 }

    return this.http.post(apiEndpoint, body, {
      headers,
      observe: 'events',
      responseType: 'text',
      reportProgress: true, withCredentials: true
    }).pipe(
      /* tap((event: HttpEvent<string>) => {
  
        switch (event.type) {
          case HttpEventType.DownloadProgress:
            // console.log('Uploaded ' + event.loaded + ' out of ' + event.total + ' bytes', Math.round((100 * event.loaded) / event.total!));
            break
          case HttpEventType.Response:
            console.log('Finished uploading!');
            break
          default:
            console.log(`event.type`, event.type)
            break
        }
      }),
       */
      filter(event => event.type === HttpEventType.DownloadProgress || event.type === HttpEventType.Response),
      map(event => {
        const fullText = (event as HttpDownloadProgressEvent).partialText || ''
        const newText = fullText.slice(previousText.length)
        previousText = fullText
        // Process the chunk to handle boundaries and send as JSON
        let buffer = newText;
        let boundary: number;
        let result = '';
        while ((boundary = buffer.indexOf('\n')) !== -1) {
          const jsonChunk = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 1);

          if (jsonChunk) {
            result += `${jsonChunk}\n`; // Add the chunked data to the result
          }
        }

        return result;
      }),
      // tap((text: string) => { console.log(`event.type`, text.split('\n')[0]) }),
      mergeMap((text: string) => from(text.split('\n'))),
      filter(line => line.startsWith('data: ')),
      map(line => line.slice(5).trim()),
      map((text: string) => {
        const newText = text?.replace(/^data:\s*/, '')
        // Fix any structural issues (e.g., mismatched brackets)
        return newText
      }),
      map((line: string) => {
        // console.log('line', line)
        const parsed = JSON.parse(line)
        if (parsed?.type === 'message_stop') {
          return '{}'
        }
        return parsed
      }),

      // filter((response): response is claudeAiApiStreamData => response !== null),
      catchError(error => {
        console.error('Error in Claude AI API call:', error)
        throw error
      })

    ).pipe(
      scan((acc: any, chunk: claudeAiApiStreamData) => {

        if (chunk.type === 'content_block_delta' && chunk.delta && chunk.delta.text) {
          // console.log(`chunk type: `, chunk.type, ' role: ' + chunk?.message?.role, 'chunk text: ', chunk.delta?.text, 'chunk usage', chunk?.usage)
          // const newText = typeof acc?.content === 'string' ? acc?.content + chunk.delta?.text : chunk.delta?.text
          return { content: chunk.delta?.text, role: chunk?.message?.role, usage: chunk?.usage }
        } else if (chunk.type === 'message_delta') {
          usage.completion_tokens = chunk?.usage?.output_tokens
          return {
            content: chunk.delta?.text, role: chunk?.usage, usage
          }
        } else if (acc?.type === 'message_start') {
          usage.prompt_tokens = acc?.message?.usage?.input_tokens || 0
          usage.completion_tokens = acc?.message?.usage?.output_tokens || 0
          return { content: '', role: acc?.message?.role, usage }
        } else if (acc?.type === 'message_start') {
          return acc
        }

      }),
      map((response: { content: string, role: string, usage: any | null }) => ({
        content: response?.content,
        role: response?.role,
        usage: response?.usage
      }))
    )/* .subscribe({
      next: (parsedChunks: any) => {
        this.subjectClaudeAI.next(parsedChunks)
      },
      error: (error) => {
        // console.error('Error:', error)
        return this.subjectClaudeAI.error(error)
      },
      complete: () => {
        // console.log('Stream completed')
        return this.subjectClaudeAI.complete()
      }
    }) */
    // return this.subjectClaudeAI.asObservable()
  }

  sendToOpenAI(content: string | { role: string, content: string }[], modelName: string = 'gpt-4o-mini', sys?: string): Observable<{ content: string, usage: any | null, role: any | null }> {

    // Groq and OpenAI speak the same wire protocol, so the model name is the whole
    // decision: it picks the endpoint and the key, and nothing else.
    const model = modelName
    const isGroq = isGroqModel(modelName)
    const apiEndpoint = isGroq ? this.groqAiEndpoint : this.openAiEndpoint
    // Kept: `chooseUsage` below reads it to pick which vendor's `usage` field to
    // parse, and Groq nests that field differently.
    const apiName = isGroq ? 'groqai' : 'openai'

    const headers = new HttpHeaders({
      // The CALLER's token, in the header `isJwtAuth` reads. The provider key is the
      // BFF's to resolve -- see `sendToClaudeAI`.
      'Authorization': `Bearer ${this.authService.token}`,
      'content-type': 'application/json',
    })

    const system = sys || `You are a helpful assistant.Extract all recipe information from website content also clean unnecessary special characters
    recipe details like image video link steps or any usage data and return in JSON format. If a field is missing, use null.
    Do not say anything else.` /* `extract all product information from website content also clean unnecessary special characters
    products details as an array and return in JSON format with four keys:
    code: number, price (number), title (string), productLink (string), discount (number). If a field is missing, use null.
    Do not say anything else.` */

    const messages = Array.isArray(content) ? content : [
      { "role": "system", "content": system },
      { "role": "user", "content": `${content}` }
    ];

    const body = {
      model,
      "max_tokens": 8000,
      "temperature": 0,
      "messages": messages,
      "stream": true,
      "stream_options": {
        "include_usage": true
      },
      "stop": null,
      "top_p": 1,
    }

    let previousText = '';

    return this.http.post(apiEndpoint, body, {
      headers,
      observe: 'events',
      responseType: 'text',
      reportProgress: true, withCredentials: true
    }).pipe(
      /* tap((event: HttpEvent<string>) => {
        switch (event.type) {
          case HttpEventType.DownloadProgress:
            // console.log('Uploaded ' + event.loaded + ' out of ' + event.total + ' bytes', Math.round((100 * event.loaded) / event.total!))
            break
          case HttpEventType.Response:
            console.log('Finished uploading!');
            break
          default:
            // console.log(`event.type`, event.type)
            break
        }
      }), */
      filter(event => event.type === HttpEventType.DownloadProgress || event.type === HttpEventType.Response),
      map(event => {
        const fullText = (event as HttpDownloadProgressEvent).partialText || ''
        const newText = fullText.slice(previousText.length)
        previousText = fullText
        // Process the chunk to handle boundaries and send as JSON
        let buffer = newText;
        let boundary: number;
        let result = '';
        while ((boundary = buffer.indexOf('\n')) !== -1) {
          const jsonChunk = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 1);

          if (jsonChunk) {
            result += `${jsonChunk}\n`; // Add the chunked data to the result
          }
        }

        return result;
      }),
      // tap((text: string) => { console.log(`event.type`, text.split('\n')[0]) }),
      switchMap((text: string) => text.split('\n')),
      filter(line => line.startsWith('data: ')),
      map(line => line.slice(5).trim()),
      map((text: string) => {
        const newText = text?.replace(/^data:\s*/, '')
        if (newText === '[DONE]') {
          return '{}'
        }
        // Fix any structural issues (e.g., mismatched brackets)
        return newText
      }),
      map((line: string) => {
        // console.log('line', line)
        const parsed = JSON.parse(line)

        const choices = parsed?.choices?.length || 0
        const content = choices ? parsed?.choices[0].delta?.content : undefined


        const chooseUsage = (apiName === 'openai' ? parsed?.usage : parsed?.x_groq?.usage)
        const usage = chooseUsage // !choices ? chooseUsage : null

        return { content, usage, role: choices ? parsed?.choices[0].delta?.role : null }
      }),
      // filter((text: any) => text?.role !== "assistant" ? text?.content?.trim() !== '' : true), // Filter out assistant responses
      catchError((error) => {
        console.log('Error in Open AI API call:', error)
        return throwError(() => error)
      })
    )
    // takeWhile((text: string) => text?.length < 10000))
    /* .subscribe({
      next: (parsedChunks: any) => {
        this.subjectOpenAI.next(parsedChunks)
      },
      error: (error: any) => {
        console.error('Error in Open AI API call:', error)
        this.subjectOpenAI.error(error)
      },
      complete: () => {
        this.subjectOpenAI.complete()
      }
    }) */
    // return this.subjectOpenAI.asObservable()
  }

  ngOnDestroy(): void {
    //Called once, before the instance is destroyed.
    //Add 'implements OnDestroy' to the class.
    this.subjectClaudeAI?.unsubscribe()
    this.subjectOpenAI?.unsubscribe()
  }
}

