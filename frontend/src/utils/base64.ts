/**
 * Base64 and Base64URL utilities with UTF-8 streaming decoder support.
 */

export function base64urlToBytes(base64url: string): Uint8Array {
  // Convert base64url to regular base64
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  // Pad with '='
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return base64ToBytes(base64);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export function decodeBase64urlJson<T = unknown>(hashPayload: string): T {
  const bytes = base64urlToBytes(hashPayload);
  const jsonStr = new TextDecoder('utf-8').decode(bytes);
  return JSON.parse(jsonStr) as T;
}

/**
 * Streaming UTF-8 log decoder for chunked base64 stream events.
 * Preserves multibyte character state across chunks.
 */
export class StreamLogDecoder {
  private decoder: TextDecoder;

  constructor() {
    this.decoder = new TextDecoder('utf-8', { fatal: false });
  }

  /**
   * Decode base64 chunk into string, maintaining streaming state.
   */
  public decodeChunk(base64: string, isLast = false): string {
    if (!base64) return '';
    try {
      const bytes = base64ToBytes(base64);
      return this.decoder.decode(bytes, { stream: !isLast });
    } catch {
      // In case of corrupt chunk, attempt fallback
      return `[解码错误: 数据损坏]`;
    }
  }

  /**
   * Flush remaining incomplete bytes when stream ends.
   */
  public flush(): string {
    return this.decoder.decode();
  }
}
