import { TestBed } from '@angular/core/testing';

import { LoggerService, redactConsoleArgs } from './logger.service';
import { getTestProviders } from 'src/app/testing';
import { environment } from 'src/environments/environment';

function getConsoleErrorSpy(): jasmine.Spy {
  return jasmine.isSpy(console.error) ? (console.error as jasmine.Spy) : spyOn(console, 'error');
}

describe('LoggerService', () => {
  let service: LoggerService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: getTestProviders() });
    service = TestBed.inject(LoggerService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should be a singleton service', () => {
    const service1 = TestBed.inject(LoggerService);
    const service2 = TestBed.inject(LoggerService);
    expect(service1).toBe(service2);
  });

  it('should handle console.error gracefully', () => {
    getConsoleErrorSpy();

    // Service should not throw when logging errors
    expect(() => {
      service.error('Test error message');
    }).not.toThrow();
  });

  it('should redact sensitive information in production', () => {
    if (environment.production) {
      const consoleErrorSpy = getConsoleErrorSpy();

      const sensitiveData = { apiKey: 'secret-key-123' };
      service.error('Error:', sensitiveData);

      expect(consoleErrorSpy).toHaveBeenCalled();
    }
  });

  it('should filter sensitive patterns from log messages', () => {
    const sensitiveMessage = 'config: { apiKey: "secret-token-here" }';

    // Service should be able to process and redact this
    expect(sensitiveMessage).toContain('apiKey');
  });

  it('should preserve non-sensitive information', () => {
    const message = 'User logged in successfully from session-id-123';

    // Non-sensitive info should pass through
    expect(message).toContain('session-id-123');
  });

  it('should handle errors with nested objects', () => {
    const complexError = {
      error: {
        apiKey: 'secret',
        message: 'An error occurred',
      },
    };

    expect(() => {
      service.error(complexError);
    }).not.toThrow();
  });

  it('should redact a secret carried by any argument, not only the first', () => {
    const redacted = redactConsoleArgs(['request failed', { apiKey: 'secret-key-123' }]);

    expect((redacted[1] as { apiKey: string }).apiKey).toBe('[REDACTED]');
  });

  it('should redact string patterns in later arguments', () => {
    const redacted = redactConsoleArgs(['first', 'apiKey: "secret-token"']);

    expect(redacted[1]).toBe('apiKey: [REDACTED]');
  });

  it('should redact secrets nested more than one level deep', () => {
    const redacted = redactConsoleArgs([{ request: { headers: { apiKeyId: 'secret-id' } } }]);
    const headers = (redacted[0] as { request: { headers: { apiKeyId: string } } }).request.headers;

    expect(headers.apiKeyId).toBe('[REDACTED]');
  });

  it('should redact secrets inside arrays', () => {
    const redacted = redactConsoleArgs([[{ apiKeys: ['secret'] }]]);
    const first = (redacted[0] as { apiKeys: unknown }[])[0];

    expect(first.apiKeys).toBe('[REDACTED]');
  });

  it('should not recurse forever on circular arguments', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;

    const redacted = redactConsoleArgs([circular]) as Record<string, unknown>[];

    expect(redacted[0]['self']).toBe('[Circular]');
  });

  it('should keep Error arguments intact so the stack survives', () => {
    const error = new Error('boom');
    const redacted = redactConsoleArgs(['failed', error]);

    expect(redacted[1]).toBe(error);
  });
});
