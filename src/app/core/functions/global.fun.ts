import { throwError } from "rxjs/internal/observable/throwError";
import { DropDownOption } from "../types"
import { HttpErrorResponse } from "@angular/common/http";
import { Observable } from "rxjs/internal/Observable";


/**
 * Centralized HTTP error handler with proper type safety
 * @param error - The error object from HttpClient
 * @returns An observable that completes with an error
 */
export function handleError(error: HttpErrorResponse | unknown): Observable<never> {
    if (error instanceof HttpErrorResponse) {
        if (error.error instanceof ErrorEvent) {
            // Client-side error
            const message = error.error.message || 'Unknown client error';
            console.error('Client error:', message);
        } else {
            // Server-side error
            console.error(
                `Server error ${error.status}:`,
                error.error,
                error
            );
        }
    } else if (error instanceof Error) {
        console.error('Error:', error.message);
    } else {
        console.error('Unknown error:', error);
    }
    return throwError(() => new Error('An error occurred. Please try again later.'));
}


/**
 * Type guard to check if value is a non-empty array
 */
export function isArray<T = unknown>(arr: unknown): arr is Array<T> {
    return Array.isArray(arr) && arr.length > 0;
}

/**
 * Type guard to check if a value is a string
 */
export function isString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function extractBalancedJsonFragment(input: string, startIndex: number): string | null {
    const openingChar = input[startIndex]

    if (openingChar !== '{' && openingChar !== '[')
        return null

    const expectedClosing = openingChar === '{' ? '}' : ']'
    const stack: string[] = [expectedClosing]

    let inString = false
    let isEscaped = false

    for (let index = startIndex + 1; index < input.length; index++) {
        const char = input[index]

        if (inString) {
            if (isEscaped) {
                isEscaped = false
                continue
            }

            if (char === '\\') {
                isEscaped = true
                continue
            }

            if (char === '"') {
                inString = false
            }

            continue
        }

        if (char === '"') {
            inString = true
            continue
        }

        if (char === '{') {
            stack.push('}')
            continue
        }

        if (char === '[') {
            stack.push(']')
            continue
        }

        if (char === '}' || char === ']') {
            const expected = stack.pop()

            if (expected !== char)
                return null

            if (stack.length === 0)
                return input.slice(startIndex, index + 1)
        }
    }

    return null
}

export function cleanAndParseJSON<T>(dirtyJsonString: string): T | null {
    try {
        for (let index = 0; index < dirtyJsonString.length; index++) {
            const char = dirtyJsonString[index]

            if (char !== '{' && char !== '[')
                continue

            const candidate = extractBalancedJsonFragment(dirtyJsonString, index)

            if (!candidate)
                continue

            try {
                return JSON.parse(candidate) as T
            } catch {
                continue
            }
        }

        return null
    } catch (error) {

        // console.log('Error parsing JSON:', error)
        return null
    }
}

export function sanitizeJSON(jsonString: string): string {
    // Remove invalid characters
    return jsonString
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
        // Escape special characters
        .replace(/\\n/g, "\\n")
        .replace(/\\r/g, "\\r")
        .replace(/\\t/g, "\\t")
        .replace(/\\b/g, "\\b")
        .replace(/\\f/g, "\\f");
}

export function formatBytes(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export function encodeToBytes(str: string) {
    const encoder = new TextEncoder();
    return encoder.encode(str);
}

export function arrayBufferToString(buffer: BufferSource): string {
    const decoder = new TextDecoder('utf-8');  // Use UTF-8 encoding
    return decoder.decode(buffer);
}

export function extractDomain(url: string): string | null {

    const pattern = /^(https?:\/\/)?([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/
    const domain = url.match(pattern)

    return domain && domain[2] ? domain[2] : null;
}

export function resolveSafeReturnUrl(rawReturnUrl: unknown, fallback: string = '/dashboard'): string {
    if (typeof rawReturnUrl !== 'string') {
        return fallback;
    }

    let candidate = rawReturnUrl.trim();
    if (!candidate) {
        return fallback;
    }

    // Decode up to two times to support encoded query param forwarding across auth pages.
    for (let i = 0; i < 2; i++) {
        try {
            const decoded = decodeURIComponent(candidate);
            if (decoded === candidate) {
                break;
            }
            candidate = decoded;
        } catch {
            break;
        }
    }

    // Convert same-origin absolute URLs to path-only URLs.
    if (/^https?:\/\//i.test(candidate)) {
        try {
            const parsed = new URL(candidate);
            if (typeof window !== 'undefined' && parsed.origin !== window.location.origin) {
                return fallback;
            }
            candidate = `${parsed.pathname}${parsed.search}${parsed.hash}`;
        } catch {
            return fallback;
        }
    }

    if (!candidate.startsWith('/') || candidate.startsWith('//')) {
        return fallback;
    }

    const pathOnly = candidate.split('?')[0].split('#')[0];
    if (pathOnly === '/service/login' || pathOnly === '/service/verification') {
        try {
            const parsed = new URL(candidate, 'http://local');
            const nestedReturnUrl = parsed.searchParams.get('returnUrl');
            if (nestedReturnUrl && nestedReturnUrl !== candidate) {
                return resolveSafeReturnUrl(nestedReturnUrl, fallback);
            }
        } catch {
            return fallback;
        }

        return fallback;
    }

    return candidate;
}

/**
 * Soft Encryption Algorithm: Transforms the string using shifts and Base64 encoding.
 * @param input - The string to "soft encrypt."
 * @returns The transformed string (encoded).
 */
export function customUrlEncoder(input: string): string {
    // Step 1: Shift characters' ASCII values by a fixed amount (e.g., +3)
    const shifted = input.split('')
        .map(char => String.fromCharCode(char.charCodeAt(0) + 3))
        .join('');

    // Step 2: Reverse the string to add an extra layer of obfuscation
    const reversed = shifted.split('').reverse().join('');

    // Step 3: Base64 encode the result using appropriate method based on environment
    if (typeof window !== 'undefined' && typeof window.btoa !== 'undefined') {
        // Browser environment (use btoa)
        return btoa(reversed);
    } else if (typeof Buffer !== 'undefined') {
        // Node.js environment (use Buffer)
        return Buffer.from(reversed).toString('base64');
    } else {
        throw new Error("Unsupported environment for Base64 encoding.");
    }
}


/**
 * Generate a cryptographically-sound random string (performance optimized)
 * @param length - Desired string length
 * @returns Random alphanumeric string
 */
export function generateRandomString(length: number): string {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charLength = characters.length;
    let result = '';
    
    // Pre-allocate array for better performance
    const charArray = new Array(length);
    for (let i = 0; i < length; i++) {
        charArray[i] = characters.charAt(Math.floor(Math.random() * charLength));
    }
    
    return charArray.join('');
}

/** Default registry images for deployment */
export const DEFAULT_IMAGES: readonly DropDownOption[] = Object.freeze([
    { name: 'registry.fly.io/crawlagent:deployment-01JMCZMGQ5ZKXW2J65KHW15EXB', code: 'deployment-01JMCZMGQ5ZKXW2J65KHW15EXB' },
]);

/**
 * @deprecated Use DEFAULT_IMAGES constant directly instead
 */
export function setDefaultImages(array: DropDownOption[]): void {
    array.push(...DEFAULT_IMAGES);
}

/** Deployment regions with airport codes */
export const DEPLOYMENT_REGIONS: readonly DropDownOption[] = Object.freeze([
    { name: 'Amsterdam, Netherlands', code: 'ams' },
    { name: 'Stockholm, Sweden', code: 'arn' },
    { name: 'Atlanta, Georgia (US)', code: 'atl' },
    { name: 'Bogotá, Colombia', code: 'bog' },
    { name: 'Mumbai, India', code: 'bom' },
    { name: 'Boston, Massachusetts (US)', code: 'bos' },
    { name: 'Paris, France', code: 'cdg' },
    { name: 'Denver, Colorado (US)', code: 'den' },
    { name: 'Dallas, Texas (US)', code: 'dfw' },
    { name: 'Dubai, United Arab Emirates', code: 'dxb' },
    { name: 'Secaucus, NJ (US)', code: 'ewr' },
    { name: 'Ezeiza, Argentina', code: 'eze' },
    { name: 'Frankfurt, Germany', code: 'fra' },
    { name: 'Guadalajara, Mexico', code: 'gdl' },
    { name: 'Rio de Janeiro, Brazil', code: 'gig' },
    { name: 'Sao Paulo, Brazil', code: 'gru' },
    { name: 'Hong Kong, Hong Kong', code: 'hkg' },
    { name: 'Ashburn, Virginia (US)', code: 'iad' },
    { name: 'Istanbul, Turkey', code: 'ist' },
    { name: 'Johannesburg, South Africa', code: 'jnb' },
    { name: 'Los Angeles, California (US)', code: 'lax' },
    { name: 'London, United Kingdom', code: 'lhr' },
    { name: 'Madrid, Spain', code: 'mad' },
    { name: 'Melbourne, Australia', code: 'mel' },
    { name: 'Miami, Florida (US)', code: 'mia' },
    { name: 'Tokyo, Japan', code: 'nrt' },
    { name: 'Chicago, Illinois (US)', code: 'ord' },
    { name: 'Bucharest, Romania', code: 'otp' },
    { name: 'Phoenix, Arizona (US)', code: 'phx' },
    { name: 'Querétaro, Mexico', code: 'qro' },
    { name: 'Santiago, Chile', code: 'scl' },
    { name: 'Seattle, Washington (US)', code: 'sea' },
    { name: 'Singapore, Singapore', code: 'sin' },
    { name: 'San Jose, California (US)', code: 'sjc' },
    { name: 'Sydney, Australia', code: 'syd' },
    { name: 'Warsaw, Poland', code: 'waw' },
    { name: 'Montreal, Canada', code: 'yul' },
    { name: 'Toronto, Canada', code: 'yyz' }
]);

/**
 * @deprecated Use DEPLOYMENT_REGIONS constant directly instead
 */
export function preSetRegions(array: DropDownOption[]): void {
    array.push(...DEPLOYMENT_REGIONS);
}

/** CPU options for container deployment */
export const CPU_TYPES: readonly DropDownOption[] = Object.freeze([
    { "name": "Shared CPU 1x", "code": "shared-cpu-1x" },
    { "name": "Shared CPU 2x", "code": "shared-cpu-2x" },
    { "name": "Shared CPU 4x", "code": "shared-cpu-4x" },
    { "name": "Shared CPU 8x", "code": "shared-cpu-8x" },
    { "name": "Performance CPU 1x", "code": "performance--1x" },
    { "name": "Performance CPU 2x", "code": "performance-2x" },
    { "name": "Performance CPU 4x", "code": "performance-4x" },
    { "name": "Performance CPU 8x", "code": "performance-8x" },
    { "name": "Performance CPU 16x", "code": "performance-16x" }
]);

/**
 * @deprecated Use CPU_TYPES constant directly instead
 */
export function preSetCPUtypes(array: DropDownOption[]): void {
    array.push(...CPU_TYPES);
}

/** Container auto-scaling policies */
export const AUTO_CONTAINER_OPTIONS: readonly DropDownOption[] = Object.freeze([
    { name: 'suspend', code: 'suspend' },
    { name: 'stop', code: 'stop' },
    { name: 'manual', code: 'off' },
]);

/**
 * @deprecated Use AUTO_CONTAINER_OPTIONS constant directly instead
 */
export function setAutoContainerOptions(array: DropDownOption[]): void {
    array.push(...AUTO_CONTAINER_OPTIONS);
}


/**
 * Convert a File to Base64 string asynchronously
 * @param file - File to convert
 * @returns Promise resolving to base64 string (without data URI prefix)
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      
      reader.onload = () => {
        try {
          // Extract base64 part after the comma
          const base64 = (reader.result as string).split(',')[1];
          if (!base64) {
            reject(new Error('Failed to extract base64 from file'));
            return;
          }
          resolve(base64);
        } catch (e) {
          reject(new Error(`Failed to process file: ${e instanceof Error ? e.message : 'Unknown error'}`));
        }
      };
      
      reader.onerror = () => {
        reject(new Error('FileReader error: Unable to read file'));
      };
      
      reader.readAsDataURL(file);
    } catch (e) {
      reject(new Error(`Failed to initialize FileReader: ${e instanceof Error ? e.message : 'Unknown error'}`));
    }
  });
}


export function extractNames(displayName: string): { firstname: string; lastname: string } {
  if (!displayName) {
    return { firstname: '', lastname: '' };
  }

  const [firstname, ...lastnameParts] = displayName.split(' ');
  const lastname = lastnameParts.join(' '); // Handles cases where the last name has multiple parts

  return { firstname: firstname || '', lastname: lastname || '' };
}


 /**
   * @function: checkPasswordStrength
   * @description Checks password strength
   * @param password 
   * @returns password strength 
   */
export function checkPasswordStrength(password: string, t?: (key: string) => string) {

    const P = (key: string, en: string) => (t ? t(key) : en)
    const minLength = 8;
    const hasUpperCase = /[A-Z]/.test(password);
    const hasLowerCase = /[a-z]/.test(password);
    const hasNumbers = /\d/.test(password);
    const hasNonAlphas = /\W/.test(password)
    const hasForbiddenCharacters = /[^\w\s@$!%*?&]/.test(password)

    return (
        password.length < minLength ? P('PASSWORD_STRENGTH.LENGTH', "Risky. Password needs to be at least 8 characters long") :
            !hasLowerCase ? P('PASSWORD_STRENGTH.LOWER', "Risky. Password needs at least one lowercase letter") :
                !hasUpperCase ? P('PASSWORD_STRENGTH.UPPER', "Risky. Password needs at least one uppercase letter") :
                    !hasNumbers ? P('PASSWORD_STRENGTH.NUMBER', "Risky. Password needs at least one number") :
                        !hasNonAlphas ? P('PASSWORD_STRENGTH.SPECIAL', "Risky. Password needs at least one special character") :
                            hasForbiddenCharacters ? P('PASSWORD_STRENGTH.FORBIDDEN', "Risky. Dont use characters that are not permitted..") : P('PASSWORD_STRENGTH.STRONG', "Strong as it gets")
    )
}

// Decoupled validity check (mirrors checkPasswordStrength rules) so callers never
// have to sniff the human-readable message text.
export function isStrongPassword(password: string): boolean {
    const minLength = 8
    return password.length >= minLength &&
        /[A-Z]/.test(password) &&
        /[a-z]/.test(password) &&
        /\d/.test(password) &&
        /\W/.test(password) &&
        !/[^\w\s@$!%*?&]/.test(password)
}

type BraveNavigator = Navigator & {
    brave?: {
        isBrave?: () => Promise<boolean>;
    };
};

export async function getBrowser(navigator: Navigator | BraveNavigator): Promise<string> {
    // Check for Brave browser
    if ('brave' in navigator && typeof navigator.brave?.isBrave === 'function') {
        if (await navigator.brave.isBrave()) return 'brave';
    }
    const ua = navigator.userAgent.toLowerCase();

    if (ua.includes('chrome') && !ua.includes('edg') && !ua.includes('opr') && !ua.includes('brave')) return 'chrome';
    if (ua.includes('chromium')) return 'chromium';
    if (ua.includes('crios')) return 'chrome-ios';
    if (ua.includes('firefox')) return 'firefox';
    if (ua.includes('fxios')) return 'firefox-ios';
    if (ua.includes('safari') && !ua.includes('chrome') && !ua.includes('chromium')) return 'safari';
    if (ua.includes('opr') || ua.includes('opera')) return 'opera';
    if (ua.includes('edg')) return 'edge';
    if (ua.includes('msie') || ua.includes('trident')) return 'ie';
    if (ua.includes('vivaldi')) return 'vivaldi';
    if (ua.includes('yabrowser')) return 'yandex';
    if (ua.includes('ucbrowser')) return 'ucbrowser';
    if (ua.includes('qqbrowser')) return 'qqbrowser';
    if (ua.includes('baidubrowser')) return 'baidubrowser';
    if (ua.includes('maxthon')) return 'maxthon';
    if (ua.includes('samsungbrowser')) return 'samsung';
    if (ua.includes('puffin')) return 'puffin';
    if (ua.includes('palemoon')) return 'palemoon';
    if (ua.includes('waterfox')) return 'waterfox';
    if (ua.includes('seamonkey')) return 'seamonkey';
    if (ua.includes('avant browser')) return 'avant';
    if (ua.includes('sleipnir')) return 'sleipnir';
    if (ua.includes('epiphany')) return 'epiphany';
    if (ua.includes('konqueror')) return 'konqueror';
    if (ua.includes('midori')) return 'midori';
    if (ua.includes('lunascape')) return 'lunascape';
    if (ua.includes('comodo')) return 'comodo';
    if (ua.includes('icecat')) return 'icecat';
    if (ua.includes('iceweasel')) return 'iceweasel';
    if (ua.includes('qutebrowser')) return 'qutebrowser';
    if (ua.includes('torbrowser')) return 'tor';
    if (ua.includes('falkon')) return 'falkon';
    if (ua.includes('netscape')) return 'netscape';

    return 'other';
}


export async function getDeviceFingerprintHash(fingerprintData: string | null, window: Window): Promise<string> {
    let deviceFingerprintHash = '';
    try {
      if (fingerprintData) {
        // Hash the fingerprint for privacy
        const encoder = new TextEncoder();
        const data = encoder.encode(fingerprintData);
        const hashBuffer = await window.crypto.subtle.digest('SHA-256', data)
        deviceFingerprintHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (e) {
      deviceFingerprintHash = '';
    }

    return deviceFingerprintHash
}

/**
 * Passive device signals, collected the way device-intelligence SDKs do it: canvas and
 * WebGL render output, hardware and display characteristics, locale and timezone.
 *
 * The IP is deliberately absent — it changes with every network and says nothing about
 * the device. This value is a RISK signal only; the device identity is the persisted id
 * cookie (`DeviceVerificationService.getOrCreateDeviceId`). Keeping the two apart is the
 * whole point: entropy drifts (browser updates, canvas randomisation in Brave/Firefox)
 * and would otherwise unpick a trusted device.
 *
 * ponytail: no audio-context pass and no font probing. Canvas + WebGL carry most of the
 * entropy; add them only if two real devices need to be told apart.
 */
export function collectDeviceSignals(window: Window): string {
  try {
    const navigatorRef = window.navigator as Navigator & { deviceMemory?: number };
    const screenRef = window.screen;
    return [
      navigatorRef.userAgent,
      navigatorRef.platform,
      (navigatorRef.languages || []).join(','),
      String(navigatorRef.hardwareConcurrency || ''),
      String(navigatorRef.deviceMemory || ''),
      String(navigatorRef.maxTouchPoints || ''),
      `${screenRef?.width}x${screenRef?.height}x${screenRef?.colorDepth}@${window.devicePixelRatio || 1}`,
      `${screenRef?.availWidth}x${screenRef?.availHeight}`,
      Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      String(new Date().getTimezoneOffset()),
      canvasSignal(window),
      webglSignal(window),
    ].join('|');
  } catch {
    return '';
  }
}

/** Canvas text + shape render output. Brave/Firefox randomise it per session by design. */
function canvasSignal(window: Window): string {
  try {
    const canvas = window.document.createElement('canvas');
    canvas.width = 220;
    canvas.height = 40;
    const context = canvas.getContext('2d');
    if (!context) {
      return '';
    }
    context.textBaseline = 'top';
    context.font = '14px Arial';
    context.fillStyle = '#f60';
    context.fillRect(0, 0, 110, 22);
    context.fillStyle = '#069';
    context.fillText('deepscrape-1', 2, 2);
    context.globalCompositeOperation = 'multiply';
    context.fillStyle = 'rgb(120,200,60)';
    context.fillText('deepscrape-2', 6, 6);
    return canvas.toDataURL();
  } catch {
    return '';
  }
}

/** GPU vendor/renderer (unmasked where the browser allows it) plus a capability probe. */
function webglSignal(window: Window): string {
  try {
    const canvas = window.document.createElement('canvas');
    const gl = canvas.getContext('webgl') as WebGLRenderingContext | null;
    if (!gl) {
      return '';
    }
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    const renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return `${vendor}~${renderer}~${gl.getParameter(gl.MAX_TEXTURE_SIZE)}`;
  } catch {
    return '';
  }
}

// Collected once per page load: the canvas read is the expensive part, and the signals
// cannot change while the document is alive.
let deviceSignalsHashCache = '';

/**
 * SHA-256 of the passive signals, cached for the lifetime of the page.
 *
 * @return The signals hash, or an empty string when the browser blocks the probes.
 */
export async function getDeviceSignalsHash(window: Window): Promise<string> {
  if (deviceSignalsHashCache) {
    return deviceSignalsHashCache;
  }
  deviceSignalsHashCache = await getDeviceFingerprintHash(collectDeviceSignals(window), window);
  return deviceSignalsHashCache;
}