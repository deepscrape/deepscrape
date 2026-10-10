import { Timestamp } from "@angular/fire/firestore"
import { CrawlOperationStatus } from "../enum"
import { convertKeysToSnakeCase } from "../functions"
import { Author } from "./firestore.interface"
import { AIModel } from "./global.interface"

export interface BrowserConfig {
    /**
     * The type of browser to launch. Supported values: "chromium", "firefox", "webkit".
     * Default: "chromium".
     */
    browserType: 'chromium' | 'firefox' | 'webkit'

    /**
     * Whether to run the browser in headless mode (no visible GUI).
     * Default?: true.
     */
    headless?: boolean

    /**
     * Launch the browser using a managed approach (e.g., via CDP), allowing advanced manipulation.
     * Default?: false.
     */
    useManagedBrowser?: boolean

    /**
     * Port for the browser debugging protocol. Default?: 9222.
     */
    debuggingPort?: number

    /**
     * Use a persistent browser context (like a persistent profile).
     * Automatically sets useManagedBrowser=true. Default?: false.
     */
    usePersistentContext?: boolean

    /**
     * Path to a user data directory for persistent sessions. If null, a temporary directory may be used.
     * Default?: null.
     */
    userDataDir?: string | null

    /**
     * The Chrome channel to launch (e.g., "chrome", "msedge"). Only applies if browserType is "chromium".
     * Default?: "chromium".
     */
    chromeChannel?: string

    /**
     * The channel to launch (e.g., "chromium", "chrome", "msedge"). Only applies if browserType is "chromium".
     * Default?: "chromium".
     */
    channel?: string

    /**
     * Proxy server URL (e.g., "http://username:password@proxy:port"). If null, no proxy is used.
     * Default?: null.
     */
    proxy?: string | null

    /**
     * Detailed proxy configuration, e.g. {"server"?: "...", "username"?: "..."}.
     * If null, no additional proxy config. Default?: null.
     */
    proxyConfig?: { [key: string]: string } | null

    /**
     * Default viewport width for pages. Default: 1080.
     */
    viewportWidth?: number

    /**
     * Default viewport height for pages. Default?: 600.
     */
    viewportHeight?: number

    /**
     * Enable verbose logging. Default?: true.
     */
    verbose?: boolean

    /**
     * Whether to allow file downloads. If true, requires a downloadsPath.
     * Default?: false.
     */
    acceptDownloads?: boolean

    /**
     * Directory to store downloaded files. If null and acceptDownloads is true, a default path will be created.
     * Default?: null.
     */
    downloadsPath?: string | null

    /**
     * Path or object describing storage state (cookies, localStorage). Default?: null.
     */
    storageState?: string | { [key: string]: string } | null

    /**
     * Ignore HTTPS certificate errors. Default?: true.
     */
    ignoreHttpsErrors?: boolean

    /**
     * Enable JavaScript execution in pages. Default?: true.
     */
    javaScriptEnabled?: boolean

    /**
     * List of cookies to add to the browser context. Each cookie is a dictionary with fields like
     * {"name": "...", "value": "...", "url": "..."}. Default: [].
     */
    cookies?: { [key: string]: string }[]

    /**
     * Extra HTTP headers to apply to all requests in this context. Default: {}.
     */
    headers?: { [key: string]: string }

    /**
     * Custom User-Agent string to use. Default: "Mozilla/5.0 (Macintosh Intel Mac OS X 10_15_7) "
     * "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36".
     */
    userAgent?: string

    /**
     * Mode for generating the user agent (e.g., "random"). If null, use the provided userAgent as-is.
     * Default?: null.
     */
    userAgentMode?: 'random' | null

    /**
     * Configuration for user agent generation if userAgentMode is set. Default?: null.
     */
    userAgentGeneratorConfig?: { [key: string]: string } | null

    /**
     * If true, disables images and other rich content for potentially faster load times.
     * Default?: false.
     */
    textMode?: boolean

    /**
     * Disables certain background features for performance gains. Default?: false.
     */
    lightMode?: boolean

    /**
     * Additional command-line arguments passed to the browser. Default?: [].
     */
    extraArgs?: string[]
}

export class BrowserConfigurationImpl implements BrowserConfig {
    browserType: 'chromium' | 'firefox' | 'webkit' = 'chromium'
    headless: boolean = true
    useManagedBrowser: boolean = false
    debuggingPort: number = 9222
    usePersistentContext: boolean = false
    userDataDir: string | null = null
    chromeChannel: string = 'chromium'
    channel: string = 'chromium'
    proxy: string | null = null
    proxyConfig: { [key: string]: string } | null = null
    viewportWidth: number = 1080
    viewportHeight: number = 600
    verbose: boolean = true
    acceptDownloads: boolean = false
    downloadsPath: string | null = null
    storageState: string | { [key: string]: string } | null = null
    ignoreHttpsErrors: boolean = true
    javaScriptEnabled: boolean = true
    cookies: { [key: string]: string }[] = []
    headers: { [key: string]: string } = {}
    userAgent: string = 'Mozilla/5.0 (Macintosh Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
    userAgentMode: 'random' | null = null
    userAgentGeneratorConfig: { [key: string]: string } | null = null
    textMode: boolean = false
    lightMode: boolean = false
    extraArgs: string[] = []
}

export type ExtractionStrategy = NoExtractionStrategy | CosineStrategyStrategy | RegexExtractionStrategy | JsonCssExtractionStrategy
    | JsonLxmlExtractionStrategy | JsonXPathExtractionStrategy | LLMExtractionStrategy

export interface CrawlerRunConfig {
    // Content Processing Parameters
    wordCountThreshold?: number
    extractionStrategy?: any | null // ExtractionStrategy
    chunkingStrategy?: any// ChunkingStrategy
    markdownGenerator?: any | null // MarkdownGenerator
    contentFilter?: any | null //RelevantContentFilter
    onlyText?: boolean
    cssSelector?: string | null
    excludedTags?: string[] | null
    excludedSelector?: string | null
    keepDataAttributes?: boolean
    removeForms?: boolean
    prettify?: boolean
    parserType?: string

    // Caching Parameters
    cacheMode?: any | null //CacheMode
    sessionId?: string | null
    bypassCache?: boolean
    disableCache?: boolean
    noCacheRead?: boolean
    noCacheWrite?: boolean

    // Page Navigation and Timing Parameters
    waitUntil?: string
    pageTimeout?: number
    waitFor?: string | null
    waitForImages?: boolean
    checkRobotsTxt?: boolean
    delayBeforeReturnHtml?: number
    meanDelay?: number
    maxRange?: number
    semaphoreCount?: number

    // Page Interaction Parameters
    jsCode?: string | string[] | null
    jsOnly?: boolean
    ignoreBodyVisibility?: boolean
    scanFullPage?: boolean
    scrollDelay?: number
    processIframes?: boolean
    removeOverlayElements?: boolean
    simulateUser?: boolean
    overrideNavigator?: boolean
    magic?: boolean
    adjustViewportToContent?: boolean

    // Media Handling Parameters
    screenshot?: boolean
    screenshotWaitFor?: number | null
    screenshotHeightThreshold?: number
    pdf?: boolean
    imageDescriptionMinWordThreshold?: number
    imageScoreThreshold?: number
    excludeExternalImages?: boolean

    // Link and Domain Handling Parameters
    excludeSocialMediaDomains?: string[]
    excludeExternalLinks?: boolean
    excludeSocialMediaLinks?: boolean
    excludeDomains?: string[]

    // Debugging and Logging Parameters
    verbose?: boolean
    logConsole?: boolean
}

export class CrawlerRunConfigImpl implements CrawlerRunConfig {
    wordCountThreshold: number = 200
    extractionStrategy: ExtractionStrategy | null = null // ExtractionStrategy
    chunkingStrategy: any = null // ChunkingStrategy
    markdownGenerator: any | null = null
    contentFilter: any | null = null
    onlyText: boolean = false
    cssSelector: string | null = null
    excludedTags: string[] | null = null
    excludedSelector: string | null = null
    keepDataAttributes: boolean = false
    removeForms: boolean = false
    prettify: boolean = false
    parserType: string = 'lxml'

    cacheMode: any | null = null //CacheMode
    sessionId: string | null = null
    bypassCache: boolean = false
    disableCache: boolean = false
    noCacheRead: boolean = false
    noCacheWrite: boolean = false

    waitUntil: string = 'domcontentloaded'
    pageTimeout: number = 60000
    waitFor: string | null = null
    waitForImages: boolean = false
    delayBeforeReturnHtml: number = 0.1
    meanDelay: number = 0.1
    maxRange: number = 0.3
    semaphoreCount: number = 5

    jsCode: string | string[] | null = null
    jsOnly: boolean = false
    ignoreBodyVisibility: boolean = true
    scanFullPage: boolean = false
    scrollDelay: number = 0.2
    processIframes: boolean = false
    removeOverlayElements: boolean = false
    simulateUser: boolean = false
    overrideNavigator: boolean = false
    magic: boolean = false
    adjustViewportToContent: boolean = false

    screenshot: boolean = false
    screenshotWaitFor: number | null = null
    screenshotHeightThreshold: number = 20000
    pdf: boolean = false
    imageDescriptionMinWordThreshold: number = 50
    imageScoreThreshold: number = 3
    excludeExternalImages: boolean = false

    excludeSocialMediaDomains: string[] = []
    excludeExternalLinks: boolean = false
    excludeSocialMediaLinks: boolean = false
    excludeDomains: string[] = []

    verbose: boolean = true
    logConsole: boolean = false
}

// Define the interface for the Crawler Results
interface MediaType {
    [key: string]: { [key: string]: any }[] | string
}


/**
 * Represents an SSL certificate with key properties as defined in Crawl4AI's SSLCertificate.
 */
export interface SSLCertificate {
    /**
     * The issuer's distinguished name (DN) as a dictionary of components.
     * Example: { "CN": "My Root CA", "O": "Organization" }
     */
    issuer: Record<string, string>;

    /**
     * The subject's distinguished name (DN) as a dictionary of components.
     * Example: { "CN": "example.com", "O": "ExampleOrg" }
     */
    subject: Record<string, string>;

    /**
     * The certificate's NotBefore date/time, typically in ASN.1/UTC format.
     * Example: "2023-01-01T00:00:00Z"
     */
    valid_from: string;

    /**
     * The certificate's NotAfter date/time, typically in ASN.1/UTC format.
     * Example: "2024-01-01T00:00:00Z"
     */
    valid_until: string;

    /**
     * The SHA-256 fingerprint of the certificate in lowercase hexadecimal.
     * Example: "d14d2e..."
     */
    fingerprint: string;
}

export type MarkdownGenerationResult = {
    raw_markdown?: string
    markdown_with_citations?: string
    references_markdown?: string
    fit_markdown?: string
    fit_html?: string
}


export interface CrawlResult {
    id?: string

    title: string
    created_At?: number
    url?: string
    success?: boolean
    html?: string
    cleaned_html?: string
    media?: MediaType
    links?: MediaType

    downloaded_files?: string[]
    screenshot?: string
    pdf?: Blob // or Buffer or Uint8Array

    markdown?: string | MarkdownGenerationResult
    extracted_content?: string // stored as JSON string or other text format
    metadata?: any // keep on eye
    error_message?: string
    session_id?: string

    response_headers?: { [key: string]: any } // HTTP response headers, if captured.
    status_code?: number // HTTP status code (e.g., 200 for OK).
    ssl_certificate?: SSLCertificate
}

export type CrawlStatus = {
    task_id: string;
    status: string;
    error?: string
    result?: {status: string, message: string}
    created_at: number;
    urls: string[];
    _links: {
        self: { href: string };
        refresh: { href: string };
    }
}


// Define the interface for the proxy config
export type ProxyConfig = {
    server: string
    port: number | null
    username: string
    password: string
}

export type Cookies = {
    domain: string
    expirationDate: number
    hostOnly: boolean
    httpOnly: boolean
    name: string
    path: string
    sameSite: 'None' | 'Lax' | 'Strict'
    secure: boolean
    session: boolean
    storeId: string
    value: string
}

export type Headers = {
    key: string
    value: string
}

export type BrowserProfile = {
    id?: string,
    uid?: string,
    title: string,
    config: BrowserConfig,
    created_At: number
    updated_At?: number
}

export type CrawlConfig = {
    id?: string,
    uid?: string,
    title: string,
    config: CrawlerRunConfig,
    created_At: number
    updated_At?: number
}

export type CrawlResultConfig = {
    id?: string,
    uid?: string,
    title: string,
    config: CrawlResult,
    created_At: number
    updated_At?: number
}

export type CrawlStorageMetadata = {
    created_At: number
    updated_At?: number
    file_compressed_size: number
    file_size: number
    file_name: string
    key_name: string
}


export type CrawlStorage = {
    error: string | null
    metadata: CrawlStorageMetadata
    url: string
}
export type Serializable = string | number | boolean | null | undefined | Serializable[] | { [key: string]: Serializable }
export type CrawlPackRef = Record<string, CrawlerRunConfig | BrowserConfig | CrawlResult /* | ExtractionStrategy */>
export type CrawlOperation = {

    id?: string
    task_id?: string
    urls: string[]
    author: Author,
    name: string
    type: CrawlJobType
    urlPath?: string
    color: string
    modelAI?: AIModel
    created_At: number
    updated_At?: number
    scheduled_At?: number
    prompt?: string
    status: CrawlOperationStatus
    metadataId?: string | null // CrawlPack
    metrics?: CrawlOperationMetrics
    // Crawl Operation Metadata Results
    error?: string | null
    storage?: CrawlStorage[]
}

export type CrawlOperationMetrics = {

    id?: string
    duration: number
    machine_id: string
    peak_memory: number
    memory_used: number
    timestamp: Date
    urls_processed: number
}

export type CrawlJobType = 'playground' | 'operation'

/**
 * The engine that executes a pack.
 *
 * `crawl4ai` is the original provider; `webrain` is the platform's own engine and
 * is now a builtin alongside it. This name exists so that a provider is a
 * deliberate choice: the cart used to take the provider as a parameter DEFAULT of
 * `'crawl4ai'`, so any call site that omitted it was silently branded crawl4ai.
 *
 * `crawlagent` is deliberately absent. It is legacy and may return, but nothing in
 * this codebase executes it today and a union entry would imply otherwise.
 */
export type CrawlProvider = 'crawl4ai' | 'webrain'

/** Iterable form, for a picker. Keep in step with {@link CrawlProvider}. */
export const CRAWL_PROVIDERS: readonly CrawlProvider[] = ['crawl4ai', 'webrain']

/**
 * A pack's kind. Wider than {@link CrawlProvider} on purpose: pack documents already
 * exist that carry `spider`, which this union has to keep accepting.
 */
export type CrawlPackType = CrawlProvider | 'spider'

export type CrawlPackConfigs = {
    crawlResultconfig?: CrawlResult
    crawlConfig?: CrawlerRunConfig
    browserProfile?: BrowserProfile
    /**
     * Compiled extraction schema, owned by the Extraction Strategies tab.
     *
     * Its own key rather than a field inside `crawlConfig`, matching how the
     * other three tabs each own one disjoint key and write none of the others'
     * -- so filling in a schema cannot clobber a form the user is mid-edit in.
     */
    extractionStrategy?: JsonCssExtractionStrategy
}
export type CartPack = {
    uid: string,
    title: string,
    type: CrawlPackType,
    crawlResultconfig: CrawlResult
    crawlConfig: CrawlerRunConfig
    browserProfile: BrowserProfile
}

export type CrawlPack = {
    id: string
    uid: string
    title: string
    type: CrawlPackType
    created_at: Date
    updated_at?: Date
    config: {
        type: string[]
        value: any // this is the main json object where request to api server 
    }
}

export type CrawlTask = {
    id: string, 
    status: CrawlOperationStatus,
    // tempTaskId: string,
    operationId: string,
    _links: {
        self: { href: string },
        status: { href: string },
        cancel: {href: string}
    },

 }
/** #######################################################
 *  # Chunking Strategy                                    #
 *  #######################################################
 */

/**
 * Initialize the RegexChunking object.
 * 
 * Args 
 ** @patterns : list
 * A list of regular expression patterns to split text.
 */

export type RegexChunking = {
    pattern: any | null
}

/** #######################################################
 *  # Strategies using clustering for text data extraction #
 *  #######################################################
 */

export type LLMConfig = {
    provider: string;
    apiToken?: string;
    baseUrl?: string;
    modelName: string
    temperature?: number
    maxTokens?: number
    topP?: number
    frequencyPenalty?: number
    presencePenalty?: number
    stop?: string[]
    toJson?(): Function
}


export interface NoExtractionStrategy {
    inputFormat: "fit_html" | "html" | "markdown" | "text"
    toJson?(): Function
}

/**
 * Interface for the CosineStrategyConfig
 */

export interface CosineStrategyStrategy {
    semanticFilter?: string;
    wordCountThreshold?: number;
    simThreshold?: number;
    maxDist?: number;
    linkageMethod?: 'ward' | 'single' | 'complete' | 'average';
    topK?: number;
    modelName?: string;
    verbose?: boolean;

    toJson?(): Function
}

/**
 * #######################################################
 * # Strategies using LLM-based extraction for text data #
 * ####################################################### 
 */
export interface LLMExtractionStrategy {
    llmConfig: LLMConfig; // The LLM configuration object.
    instruction: string; // The instruction to use for the LLM model.
    schema: any; // Pydantic model schema for structured data.
    extractionType: "block" | "schema";
    chunkTokenThreshold: number; // Maximum tokens per chunk.
    overlapRate: number; // Overlap between chunks.
    wordTokenRate: number; // Word to token conversion rate.
    applyChunking: boolean; // Whether to apply chunking.
    inputFormat: "markdown" | "html" | "fit_markdown"; // Content format to use for extraction. Options: "markdown" (default), "html", "fit_markdown"
    forceJsonResponse: boolean; // Whether to force a JSON response from the LLM.
    verbose: boolean; // Whether to print verbose output.
    toJson?(): Function
}




export interface RegexExtractionStrategy {

    pattern: any | null
    custom?: { [x: string]: string }
    inputFormat: "fit_html" | "html" | "markdown" | "text"
    toJson?(): Function
}

export interface JsonCssExtractionStrategy {
    schema: { [key: string]: any }

}

export interface JsonLxmlExtractionStrategy {
    schema: { [key: string]: any }
}

export interface JsonXPathExtractionStrategy {
    schema: { [key: string]: any }
}


export const interfaceAttrToJson = (inteface: any): any => convertKeysToSnakeCase(inteface)