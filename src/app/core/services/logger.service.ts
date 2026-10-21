import { Injectable, inject } from '@angular/core';
import { environment } from 'src/environments/environment';
import { I18nService } from '../i18n';


declare global {
  interface Console {
    forceLog?: (...args: unknown[]) => void
  }
}

const REDACTED = '[REDACTED]'
const SENSITIVE_KEYS = ['apiKey', 'apiKeys', 'apiKeyId']

function redactString(value: string): string {
  return value
    .replace(/apiKeys?\s*:\s*['"][^'"]+['"]/gi, 'apiKey: [REDACTED]')
    .replace(/apiKeyId\s*:\s*['"][^'"]+['"]/gi, 'apiKeyId: [REDACTED]')
    .replace(/apiKey\s*=\s*['"][^'"]+['"]/gi, 'apiKey=[REDACTED]');
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Redacts every argument before it reaches the console.
 *
 * Strings are pattern-scrubbed; arrays and plain objects are walked recursively. The previous
 * implementation cloned a single level, so a secret nested one object deeper was printed in
 * clear. Non-plain objects (`Error`, `Date`, DOM nodes) are returned untouched so their stack
 * and native inspection survive — spreading an `Error` yields `{}`, which is how production
 * error logs lost the stack. The exception is an object carrying a sensitive own key: that is
 * cloned so the value cannot reach the console.
 *
 * @param args The console arguments, unmodified.
 * @return {unknown[]} Redacted copies, positionally aligned with the input.
 */
export function redactConsoleArgs(args: readonly unknown[]): unknown[] {
  const ancestors = new WeakSet<object>();

  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return redactString(value);
    }
    if (typeof value !== 'object' || value === null) {
      return value;
    }
    if (ancestors.has(value)) {
      return '[Circular]';
    }

    const entries = Object.entries(value);
    const carriesSecret = entries.some(([key]) => SENSITIVE_KEYS.includes(key));
    if (!Array.isArray(value) && !isPlainObject(value) && !carriesSecret) {
      return value;
    }

    ancestors.add(value);
    const redacted: unknown = Array.isArray(value)
      ? value.map(item => redact(item))
      : entries.reduce<Record<string, unknown>>((clone, [key, nested]) => {
        clone[key] = SENSITIVE_KEYS.includes(key) ? REDACTED : redact(nested);
        return clone;
      }, {});
    ancestors.delete(value);

    return redacted;
  };

  return args.map(redact);
}

@Injectable({
  providedIn: 'root'
})
export class LoggerService {
  private static i18nService: I18nService

  // Static initialization - runs once when app starts
  static {
    
    // Only modify console in production
    if (environment.production) {
      // Store original methods
      const originalMethods = {
        log: console.log,
        debug: console.debug,
        info: console.info,
        warn: console.warn,
        error: console.error
      }
      
      // Replace with filtered versions
      console.log = console.debug = console.info = console.warn = () => {}
      
      // Keep error logging
      console.error = function(...args) {
        // Redact every argument, recursively, before logging
        const redactedArgs = redactConsoleArgs(args);
        // Show i18n warning before error
        
        let warning = '';
        if (LoggerService.i18nService) {
          warning = LoggerService.i18nService.instant('consoleWarning');
        }
        originalMethods.log.call(console, warning);
        originalMethods.error.apply(console, redactedArgs)
      };
      
      // Add ability to force logging even in production
      (console as Console).forceLog = (...args: unknown[]): void => {
        // Same redaction as `console.error`: this path bypasses the patched methods.
        originalMethods.log.apply(console, redactConsoleArgs(args))
      }
    }
  }

  // Regular instance methods - these will maintain call stack
  log(...data: any[]): void {
    console.log(...data)
  }
  
  debug(...data: any[]): void {
    console.debug(...data)
  }
  
  info(...data: any[]): void {
    console.info(...data)
  }
  
  warn(...data: any[]): void {
    console.warn(...data)
  }
  
  error(...data: any[]): void {
    console.error(...data);
  }
  
  // For critical logs that should appear even in production
  forceLog(...data: any[]): void {
    if ((console as any).forceLog) {
      (console as any).forceLog(...data)
    } else {
      console.log(...data)
    }
  }
}
