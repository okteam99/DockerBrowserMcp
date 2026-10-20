export class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function publicError(error: unknown) {
  if (error instanceof ToolError) return { code: error.code, message: error.message };
  const msg = error instanceof Error ? error.message : String(error);
  if (/Timeout|timed out/i.test(msg))
    return {
      code: 'TIMEOUT',
      message: 'Operation timed out; inspect state before repeating a write action.',
    };
  if (/proxy|socks|tunnel/i.test(msg))
    return {
      code: 'PROXY_CONNECTION_FAILED',
      message:
        'Proxy connection failed. Check connectivity and credentials; no direct fallback is used.',
    };
  if (/closed|crash/i.test(msg))
    return { code: 'BROWSER_CLOSED', message: 'Browser or page is closed.' };
  if (/strict mode violation/i.test(msg))
    return {
      code: 'AMBIGUOUS_ELEMENT',
      message: 'Target matched multiple elements. Use a more specific locator.',
    };
  if (/locator|element/i.test(msg))
    return {
      code: 'ELEMENT_ERROR',
      message: 'Element action failed; refresh snapshot and inspect state.',
    };
  return {
    code: 'OPERATION_FAILED',
    message: 'Operation failed. Check inputs, page state and server logs; secrets are omitted.',
  };
}
export function safeUrl(raw: string) {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '[non-http-url]';
  }
}
