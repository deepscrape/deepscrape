import { FormGroup } from "@angular/forms"
import { BrowserType, CrawlCachingMode, CrawlOperationStatus } from "../enum"
import { CrawlPack, DropDownOption, Serializable } from "../types"

export function crawlOperationStatusColor(status: CrawlOperationStatus) {
    let color = 'gray'
    switch (status) {
        case CrawlOperationStatus.IN_PROGRESS:
            color = 'cyan'
            break
        case CrawlOperationStatus.FAILED:
            color = 'red'
            break
        case CrawlOperationStatus.CANCELED:
            color = 'deep-orange'
            break
        case CrawlOperationStatus.SCHEDULED:
            color = 'emerald'
            break
        case CrawlOperationStatus.COMPLETED:
            color = 'green'
            break
        case CrawlOperationStatus.STARTED:
            color = 'blue'
            break
        case CrawlOperationStatus.READY:
            color = color
            break
        default:
            break
    }
    //` bg-${color}-600/[.8]` + ` hover:bg-${color}-600/[0.5]` + ` focus:bg-${color}-900/[0.8]`
    // ' bg-' + color + '-600/[.8] hover:bg-' + color + '-600/[0.5] focus:bg-' + color + '-900/[0.8] '
    return color
}


export function setOperationStatusList(statusList: DropDownOption[]) {
    const list = [
        { name: 'Save', code: CrawlOperationStatus.READY },
        { name: 'Run', code: CrawlOperationStatus.STARTED },
        { name: 'Schedule', code: CrawlOperationStatus.SCHEDULED }
    ]
    statusList.push(...list)
}

export function setCacheModeList(cacheModeList: DropDownOption[]) {
    const list = [
        { name: CrawlCachingMode.ENABLED.toUpperCase(), code: CrawlCachingMode.ENABLED.toLowerCase() },
        { name: CrawlCachingMode.DISABLED.toUpperCase(), code: CrawlCachingMode.DISABLED.toLowerCase() },
        { name: CrawlCachingMode.BYPASS.toUpperCase(), code: CrawlCachingMode.BYPASS.toLowerCase() },
        { name: CrawlCachingMode.NONE.toUpperCase(), code: CrawlCachingMode.NONE.toLowerCase() },
        { name: CrawlCachingMode.WRITE_ONLY.toUpperCase(), code: CrawlCachingMode.WRITE_ONLY.toLowerCase() },
        { name: CrawlCachingMode.READ_ONLY.toUpperCase(), code: CrawlCachingMode.READ_ONLY.toLowerCase() },
    ]
    cacheModeList.push(...list)
}

export function setBrowserTypeList(browserTypeList: DropDownOption[]) {
    const list = [
        { name: BrowserType.Chromium.toUpperCase(), code: BrowserType.Chromium.toLowerCase() },
        { name: BrowserType.Firefox.toUpperCase(), code: BrowserType.Firefox.toLowerCase() },
        { name: BrowserType.Webkit.toUpperCase(), code: BrowserType.Webkit.toLowerCase() },
    ]

    browserTypeList.push(...list)
}

export function setCrawlPackList(pack: CrawlPack[], crawlConfigPackList: DropDownOption[]) {
    const list = pack.map(config => ({ name: config.title, code: config.id }))
    crawlConfigPackList.push(...list);
}

export function validateForm(configForm: FormGroup<any>): boolean {
    if (configForm.invalid) {
        Object.keys(configForm.controls).forEach(key => {
            const control = configForm.get(key)
            if (control?.invalid) {
                console.log(`${key} is invalid: `, control.errors)
            }
        })
        return false
    }
    return true
}

export function getOffsetTop(element: HTMLElement | null): number {
    let offsetTop = 0;
    while (element) {
        offsetTop += element.offsetTop;
        element = element.offsetParent as HTMLElement
    }
    return offsetTop;
}


export function getErrorLabel(configForm: FormGroup<any>, controlName: string): string {

    if (!configForm.get(controlName) || configForm.get(controlName)?.errors === null)
        return ''

    const max = configForm.get(controlName)?.errors?.['max']?.max
    const min = configForm.get(controlName)?.errors?.['min']?.min

    const actual = parseInt(configForm.get(controlName)?.value, 10);

    // console.log(actual, max)
    if (actual > max) {
        console.log('invalid value, the maximum value is ' + max)
        return 'invalid value, the maximum value is ' + max
    }

    if (configForm.get(controlName)?.errors?.['required']) {
        return 'This field is required';
    } else if (configForm.get(controlName)?.errors?.['min']) {
        return 'invalid value, the minimum value is ' + min;
    } else if (configForm.get(controlName)?.errors?.['pattern']) {
        return 'invalid input, use only numbers'
    } else if (configForm.get(controlName)?.errors?.[controlName]) {
        return configForm.get(controlName)?.errors?.[controlName]
    }
    return 'invalid input'
}


export function switchPackageIcon(packKey: string, browserType: string = 'playwright') {
    switch (packKey) {
        case 'browserProfile':
            return browserType
        case 'crawlConfig':
            return 'spider-crawl-config'
        case 'crawlResultConfig':
            return 'crawl_logo'
        default:
            return 'crawl_logo'
    }

}

/**
 * A gate the crawler could not pass. The worker reports this on every navigate;
 * `null`/absent means the page loaded. `captcha` covers the interactive widgets
 * (Turnstile / reCAPTCHA / hCaptcha) that only a real Chrome profile can claim.
 */
export type CrawlChallenge = 'cloudflare_challenge' | 'blocked' | 'captcha'

/** What a crawl result actually IS, as opposed to what it contains. */
export type CrawlOutcome = 'ok' | 'empty' | 'challenge' | 'failed'

/**
 * The minimal shape the classifier reads.
 *
 * Deliberately structural rather than typed against a `CrawlResult`: this repo
 * declares `CrawlResult` in both `crawl.interface.ts` and `crawl-result.type.ts`
 * and re-exports both from the types barrel, so which definition a caller gets
 * depends on barrel order. Reading fields keeps this correct either way, and
 * keeps the new state from having to be added to every duplicate.
 */
export interface CrawlOutcomeInput {
    challenge?: CrawlChallenge | string | null
    success?: boolean
    status_code?: number
    error_message?: string
    markdown?: string | Record<string, unknown> | null
    cleaned_html?: string | null
    html?: string | null
    fit_html?: string | null
}

/**
 * Tells "the site blocked us" apart from "the site returned nothing".
 *
 * The challenge check runs FIRST and outranks any body in the same response: a
 * Cloudflare interstitial is valid HTML with a real title and markdown, so every
 * body-based test reads it as a successful scrape. That is the failure this
 * exists to prevent — a gate must never be extracted as content.
 *
 * Any non-empty `challenge` counts as a gate, not just the three known values: a
 * new value from the worker should degrade to "blocked", never to "ok".
 *
 * ponytail: with the field absent (a crawl4ai-shaped response) a 403 reads as
 * `failed` rather than `challenge`. The worker only populates the field itself,
 * so the discriminator is authoritative exactly when it is set; calling a 403 a
 * gate on the provider path would be a guess.
 */
export function crawlOutcome(result: CrawlOutcomeInput | null | undefined): CrawlOutcome {
    if (!result) {
        return 'failed'
    }

    if (typeof result.challenge === 'string' && result.challenge.length > 0) {
        return 'challenge'
    }

    if (result.success === false || (result.error_message ?? '') !== '' || (result.status_code ?? 0) >= 400) {
        return 'failed'
    }

    // `markdown` is a STRING on the crawl4ai-shaped result but an OBJECT on
    // `CrawlResults` ({raw_markdown, markdown_with_citations, ...}), which
    // `CrawlOutcomeInput` already allowed for. Reading it as a body and comparing
    // to '' therefore missed the object case entirely: an object is never '', so a
    // result whose markdown had been stripped to empty reported `ok` — the false
    // positive the `empty` state exists to prevent. Collect the candidates and ask
    // whether ANY of them carries text.
    const markdown = result.markdown
    const bodies: unknown[] = [
        typeof markdown === 'object' && markdown !== null
            ? (markdown as Record<string, unknown>)['raw_markdown']
            : markdown,
        result.cleaned_html,
        result.html,
        result.fit_html,
    ]

    if (bodies.some((candidate) => typeof candidate === 'string' && candidate.length > 0)) {
        return 'ok'
    }

    return 'empty'
}

export function toSerializableDict(obj: any, ignoreDefaultValue: boolean = false): Serializable {
    if (obj === null || obj === undefined) {
        return null;
    }

    // Handle basic types
    if (typeof obj === "string" || typeof obj === "number" || typeof obj === "boolean") {
        return obj;
    }

    // Handle Enum (assuming enums are represented as objects with `name` and `value`)
    if (obj.constructor && obj.constructor.name === "Object" && "name" in obj && "value" in obj) {
        return { type: obj.constructor.name, params: obj.value };
    }

    // Handle Date objects
    if (obj instanceof Date) {
        return obj.toISOString();
    }

    // Handle arrays
    if (Array.isArray(obj)) {
        return obj.map(item => toSerializableDict(item));
    }

    // Handle plain objects
    if (typeof obj === "object" && obj.constructor === Object) {
        const result: { [key: string]: Serializable } = {};
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                result[key] = toSerializableDict(obj[key]);
            }
        }
        return { type: "dict", value: result };
    }

    // Handle class instances
    if (obj.constructor && obj.constructor.name) {
        const currentValues: { [key: string]: Serializable } = {};
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                const value = obj[key];
                if (!ignoreDefaultValue || value !== undefined) {
                    currentValues[key] = toSerializableDict(value);
                }
            }
        }
        return { type: obj.constructor.name, params: currentValues };
    }

    return String(obj);
}

export function fromSerializableDict(data: Serializable): any {
    if (data === null || data === undefined) {
        return null;
    }

    // Handle basic types
    if (typeof data === "string" || typeof data === "number" || typeof data === "boolean") {
        return data;
    }

    // Handle typed data
    if (typeof data === "object" && data !== null && "type" in data) {
        const typedData = data as { type: string; params?: any; value?: any };

        // Handle plain dictionaries
        if (typedData.type === "dict" && typedData.value) {
            const result: { [key: string]: any } = {};
            for (const key in typedData.value) {
                if (typedData.value.hasOwnProperty(key)) {
                    result[key] = fromSerializableDict(typedData.value[key]);
                }
            }
            return result;
        }

        // Handle class instances (assuming classes are globally available)
        if (typedData.params) {
            const cls = (globalThis as any)[typedData.type];
            if (cls) {
                return new cls(...Object.values(typedData.params));
            }
        }
    }

    // Handle arrays
    if (Array.isArray(data)) {
        return data.map(item => fromSerializableDict(item));
    }

    return data;
}

function isEmptyValue(value: any): boolean {
    if (value === null || value === undefined) {
        return true;
    }
    if (typeof value === "string" && value.trim().length === 0) {
        return true;
    }
    if (Array.isArray(value) && value.length === 0) {
        return true;
    }
    if (typeof value === "object" && Object.keys(value).length === 0) {
        return true;
    }
    return false;
}


export function convertKeysToSnakeCase(obj: any, exceptFromKeys: string[] = []): any {
    if (typeof obj !== 'object' || obj === null) {
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map(item => convertKeysToSnakeCase(item, exceptFromKeys));
    }

    const newObj: any = {};
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            const newKey = exceptFromKeys.includes(key) ? key : key.replace(/([A-Z])/g, '_$1').toLowerCase();
            newObj[newKey] = exceptFromKeys.includes(key) ? obj[key] : convertKeysToSnakeCase(obj[key], exceptFromKeys);
        }
    }
    return newObj;
}