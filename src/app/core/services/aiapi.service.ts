import { HttpClient, HttpDownloadProgressEvent, HttpErrorResponse, HttpEvent, HttpEventType, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs/internal/Observable';
import { throwError } from 'rxjs/internal/observable/throwError';
import { catchError } from 'rxjs/internal/operators/catchError';
import { map } from 'rxjs/internal/operators/map';
import { tap } from 'rxjs/internal/operators/tap';
import { anthropicTools, arrayBufferToString, customUrlEncoder, openaiTools, sanitizeJSON, vendorForModel, type AiToolSpec } from '../functions';
import { API_ANTHROPIC, API_CUSTOM, API_DEEPSEEK, API_FIREWORKS, API_GEMINI, API_GROQAI, API_JINAAI, API_KIMI, API_MODELS, API_OPENAI, API_OPENROUTER, API_QWEN, DEFAULT_SYSTEM_PROMPT } from '../variables';
import { scan } from 'rxjs/internal/operators/scan';
import { ModelCatalogue, ModelFacts, OpenAiChatVendor, claudeAiApiStreamData, CrawlPack, CrawlTask, JinaOptions } from '../types';
import { filter } from 'rxjs/internal/operators/filter';
import { of } from 'rxjs/internal/observable/of';
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

  private jinaAiEndpoint: string

  /**
   * Where each OpenAI-compatible vendor's chat completion goes.
   *
   * A table keyed by the vendor union rather than a chain of ternaries: a vendor added to
   * the catalogue and forgotten here is a compile error, whereas a fallback chain would
   * have quietly posted the caller's request to whichever vendor came first. `anthropic`
   * is absent because it has its own method and its own path, and is not this protocol.
   */
  private readonly chatEndpoints: Readonly<Record<OpenAiChatVendor, string>> = {
    openai: `${API_OPENAI}/chat/completions`,
    groq: `${API_GROQAI}/chat/completions`,
    deepseek: `${API_DEEPSEEK}/chat/completions`,
    fireworks: `${API_FIREWORKS}/chat/completions`,
    qwen: `${API_QWEN}/chat/completions`,
    kimi: `${API_KIMI}/chat/completions`,
    openrouter: `${API_OPENROUTER}/chat/completions`,
    gemini: `${API_GEMINI}/chat/completions`,
    // The caller's own endpoint: the same wire protocol, at a URL the platform never chose.
    custom: `${API_CUSTOM}/chat/completions`,
  }

  private subjectClaudeAI = new Subject<claudeAiApiStreamData>()
  private subjectOpenAI = new Subject<{ content: string, usage: any | null, role: any | null }>()

  constructor(private http: HttpClient, private authService: AuthService) {

    this.claudeAiEndpoint = `${API_ANTHROPIC}/messages`
    this.jinaAiEndpoint = `${API_JINAAI}/`

    // initialize auth state
    // this.authService.initAuth()
  }

  /**
   * The endpoint a model call goes to.
   *
   * The caller's vendor wins when supplied; otherwise the name is resolved, which can only
   * work for the two vendors `vendorForModel` knows. Passing the vendor explicitly is what
   * the chat does, because a picker that lists a vendor's live models is the only place
   * that actually knows which vendor a model id came from.
   * @param {string} modelName The model id, for the name-based fallback.
   * @param {OpenAiChatVendor} vendor The vendor, when the caller knows it.
   * @return {string} The path to post to.
   */
  private endpointFor(modelName: string, vendor?: OpenAiChatVendor): string {
    return this.chatEndpoints[vendor ?? vendorForModel(modelName)]
  }

  /**
   * A vendor's catalogue: the model ids it publishes, plus the facts the platform could
   * attach to them.
   *
   * Never errors. A vendor that is down, unconfigured or not entitled answers an empty list,
   * and the caller keeps its static fallback -- so the signature carries an empty catalogue
   * rather than an error the picker would have to branch on for a case that has a perfectly
   * good answer.
   *
   * The facts ride on the same reply rather than a request of their own: the picker already
   * calls this once per vendor, so describing the models it just returned is free here. An
   * empty `facts` is the ordinary outcome for a vendor the registry does not cover, which is
   * why the caller treats it as "no better answer available" rather than as a failure.
   * @param {OpenAiChatVendor | 'anthropic'} vendor The vendor whose catalogue to read.
   * @return {Observable<ModelCatalogue>} The ids and facts, empty when unavailable.
   */
  fetchModels(vendor: OpenAiChatVendor | 'anthropic'): Observable<ModelCatalogue> {
    return this.http.get<{ models?: unknown; facts?: unknown }>(`${API_MODELS}/${vendor}`, {
      headers: new HttpHeaders({
        // The CALLER's token, in the header `isJwtAuth` reads. The provider key is the
        // BFF's to resolve with `keyFor`, exactly as on the chat path.
        'Authorization': `Bearer ${this.authService.token}`,
      }),
    }).pipe(
      map(body => ({
        models: Array.isArray(body?.models)
          ? body.models.filter((id): id is string => typeof id === 'string')
          : [],
        facts: this.readFacts(body?.facts),
      })),
      catchError(() => of({ models: [], facts: {} })),
    )
  }

  /**
   * The `facts` member of a catalogue reply, as a record.
   *
   * Guarded rather than cast: the reply comes from a route that also proxies a third party,
   * and a `facts` that is not an object would feed `undefined` prices into the cost
   * arithmetic. An empty record is the same answer as a registry outage, which the caller
   * already handles, so there is nothing to report.
   * @param {unknown} value The raw member.
   * @return {Record<string, ModelFacts>} The facts, or an empty record.
   */
  private readFacts(value: unknown): Record<string, ModelFacts> {
    return value !== null && typeof value === 'object' ? value as Record<string, ModelFacts> : {}
  }

  sendToJinaAI(url: string, options: JinaOptions, cookies?: string): Observable<string> {

    // Always encoded, because the BFF ALWAYS decodes (`customUrlDecoder` in `jinaAICrawl`).
    //
    // This used to branch on `environment.JINAAI_API_KEY`, and both halves of that were wrong.
    // It read a PROVIDER KEY's presence in the browser, which is the class of thing the header
    // work in this file removed: the browser has no business reasoning about which provider keys
    // the deployment holds. And the branch was inverted -- with a key configured it sent the RAW
    // url, which the BFF then handed to a base64+reverse+Caesar decoder, so it would have
    // mangled the target. It never fired only because the key is blank in every environment file.
    const encodedUrl = customUrlEncoder(url);
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
   * The vendor is resolved the same way `sendToOpenAI` resolves it -- from the caller when
   * it is given, otherwise from the model name -- so a Groq model offered a tool reaches
   * Groq rather than OpenAI. They speak the same wire protocol, so endpoint and key are
   * the whole difference.
   *
   * `tools` is omitable rather than sent empty on the answering round: an empty
   * array is rejected by some providers, and offering tools there would invite
   * another call rather than an answer.
   * @param {Array} messages The conversation, system turn included by the caller.
   * @param {string} modelName The model id.
   * @param {Array} tools The specs to offer; omit for the answering round.
   * @param {OpenAiChatVendor} vendor The vendor, when the caller knows it.
   * @return {Observable<unknown>} The parsed response body.
   */
  askOpenAiOnce(
    messages: { role: string, content: unknown }[],
    modelName: string,
    tools?: readonly AiToolSpec[],
    vendor?: OpenAiChatVendor
  ): Observable<unknown> {
    const apiEndpoint = this.endpointFor(modelName, vendor)

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

  sendToClaudeAI(content: string | { role: string, content: unknown }[], modelName: string = 'claude-3-5-sonnet-20241022', sys?: string, tools?: readonly AiToolSpec[]): Observable<{ content: string, role: any, usage: any | null, event?: unknown, toolCalls?: unknown }> {
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

    // No prompt from the caller means the platform default, not the recipe extractor this
    // used to fall back to. `DEFAULT_SYSTEM_PROMPT` records why that was wrong.
    const system = sys || DEFAULT_SYSTEM_PROMPT



    const messages = Array.isArray(content) ? content : [
      { "role": "user", "content": `${content}` }
    ];

    const body = {
      model, //  claude-3-5-sonnet-20240620
      "max_tokens": 4096,
      system,
      "messages": messages,
      // Omitted rather than sent empty, for the reason `askClaudeOnce` gives: an
      // empty array is rejected, and re-offering tools on the answering round
      // would invite another call instead of an answer.
      ...(tools && tools.length > 0 ? { tools: anthropicTools(tools) } : {}),
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

        // Tool traffic is passed through UNTOUCHED rather than interpreted: the
        // accumulators in `ai-tools.fun.ts` own assembly, and a `partial_json`
        // fragment is not something this layer can usefully read. Discarding these
        // events is what made streaming and tools look incompatible. Read through a
        // cast because the emitted union does not name the tool event types.
        const eventType = (chunk as { type?: string })?.type
        if (
          eventType === 'content_block_start' ||
          eventType === 'content_block_stop' ||
          (eventType === 'content_block_delta' &&
            !(chunk as { delta?: { text?: unknown } })?.delta?.text)
        ) {
          return { content: '', role: null, usage, event: chunk }
        }

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

  sendToOpenAI(content: string | { role: string, content: unknown }[], modelName: string = 'gpt-4o-mini', sys?: string, tools?: readonly AiToolSpec[], vendor?: OpenAiChatVendor): Observable<{ content: string, role: any, usage: any | null, event?: unknown, toolCalls?: unknown }> {

    // Every OpenAI-compatible vendor speaks the same wire protocol, so the vendor is the
    // whole decision: it picks the endpoint and the key, and nothing else. Taken from the
    // caller when given -- a model id read out of a vendor's live catalogue is only
    // attributable to the vendor it was read from -- and otherwise resolved from the name,
    // which can only work for the two vendors `vendorForModel` knows.
    const model = modelName
    const resolved = vendor ?? vendorForModel(modelName)
    const apiEndpoint = this.chatEndpoints[resolved]
    // Kept: `chooseUsage` below reads it to pick which vendor's `usage` field to parse, and
    // Groq nests that field differently from everyone else.
    const apiName = resolved === 'groq' ? 'groqai' : 'openai'

    const headers = new HttpHeaders({
      // The CALLER's token, in the header `isJwtAuth` reads. The provider key is the
      // BFF's to resolve -- see `sendToClaudeAI`.
      'Authorization': `Bearer ${this.authService.token}`,
      'content-type': 'application/json',
    })

    // Same default as the Claude path, from the one constant -- see `DEFAULT_SYSTEM_PROMPT`.
    const system = sys || DEFAULT_SYSTEM_PROMPT

    const messages = Array.isArray(content) ? content : [
      { "role": "system", "content": system },
      { "role": "user", "content": `${content}` }
    ];

    const body = {
      model,
      "max_tokens": 8000,
      "temperature": 0,
      "messages": messages,
      // Omitted rather than sent empty -- see the Claude path above.
      ...(tools && tools.length > 0 ? { tools: openaiTools(tools) } : {}),
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
        const parsed = JSON.parse(line)

        const choices = parsed?.choices?.length || 0
        const content = choices ? parsed?.choices[0].delta?.content : undefined

        const chooseUsage = (apiName === 'openai' ? parsed?.usage : parsed?.x_groq?.usage)
        const usage = chooseUsage // !choices ? chooseUsage : null

        // Surfaced, not consumed here. A streamed tool call arrives as these
        // fragments and `finishToolCalls` assembles them; discarding the field is
        // what made streaming and tools look incompatible.
        const toolCalls = choices ? parsed?.choices[0].delta?.tool_calls : undefined

        return { content, usage, role: choices ? parsed?.choices[0].delta?.role : null, toolCalls }
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

