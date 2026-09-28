/**
 * Crypto primitives shared by the session cookie and the session store.
 *
 * Web Crypto only — no `node:crypto` — because middleware runs in the Edge runtime
 * by default and bundling a Node builtin there fails the build outright.
 * `globalThis.crypto` is present in Node 18+, Edge and browsers, so these functions
 * behave identically in tests, in middleware and in route handlers.
 *
 * Every buffer handed to Web Crypto goes through `bufferOf`, which returns a view
 * over a plain `ArrayBuffer`; the DOM types reject `Uint8Array<ArrayBufferLike>`
 * because a `SharedArrayBuffer` backing store cannot be passed to `subtle`.
 */

const encoder = new TextEncoder();

/** Copies bytes into a view backed by a plain `ArrayBuffer`. */
export const bufferOf = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
};

export const utf8 = (value: string): Uint8Array<ArrayBuffer> => bufferOf(encoder.encode(value));

/**
 * Obfuscates an API key for display.
 *
 * Never reveals more than the last four characters, and reveals nothing at all for
 * very short keys — which is the whole point: this output is rendered in the UI.
 * @param apiKey Raw key.
 */
export const maskSecret = (apiKey: string): string => {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (trimmed.length <= 8) {
    return "•".repeat(trimmed.length);
  }
  return `${"•".repeat(Math.min(12, trimmed.length - 4))}${trimmed.slice(-4)}`;
};

/** Cryptographically strong session identifier, 24 random bytes as base64url. */
export const createSessionId = (): string => {
  const bytes = new Uint8Array(new ArrayBuffer(24));
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
