import { describe, it, expect } from 'vitest';
import {
  base64ToBytes,
  decodeBase64urlJson,
  StreamLogDecoder,
} from './base64';

describe('Base64 and Base64URL utilities', () => {
  it('decodes standard base64 to bytes', () => {
    const text = 'Hello, Edge Command!';
    const b64 = btoa(text);
    const bytes = base64ToBytes(b64);
    const decoded = new TextDecoder().decode(bytes);
    expect(decoded).toBe(text);
  });

  it('decodes base64url without padding and with - and _ chars', () => {
    // String with characters that produce + and / in base64:
    // ">>>???" in ASCII:
    // btoa(">>>???") = "Pj4+Pz8/" -> base64url is "Pj4-Pz8_"
    const payload = { command: 'curl -fsSL https://example.com | sh' };
    const jsonStr = JSON.stringify(payload);
    const b64 = btoa(jsonStr);
    const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    const decoded = decodeBase64urlJson<{ command: string }>(b64url);
    expect(decoded.command).toBe(payload.command);
  });

  it('StreamLogDecoder handles UTF-8 characters split across chunk boundaries', () => {
    const fullText = '你好，边缘运维面板！🚀';
    const utf8Bytes = new TextEncoder().encode(fullText);

    // Split across an arbitrary byte position in the middle of a 3-byte Chinese character
    const splitIndex = 4; // '你' is 3 bytes (0,1,2), byte 3 & 4 are start of '好'
    const part1 = utf8Bytes.subarray(0, splitIndex);
    const part2 = utf8Bytes.subarray(splitIndex);

    // Convert parts to base64
    const b64Part1 = btoa(String.fromCharCode(...part1));
    const b64Part2 = btoa(String.fromCharCode(...part2));

    const decoder = new StreamLogDecoder();
    const chunk1 = decoder.decodeChunk(b64Part1, false);
    const chunk2 = decoder.decodeChunk(b64Part2, true);
    const flushed = decoder.flush();

    const result = chunk1 + chunk2 + flushed;
    expect(result).toBe(fullText);
  });
});
