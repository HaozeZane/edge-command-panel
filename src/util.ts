export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers });
}

export function errorResponse(error: string, status = 400, extra?: HeadersInit): Response {
  return json({ error }, status, extra);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, field: string, max = 1000, min = 1): string {
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string`);
  const len = encoder.encode(value).byteLength;
  if (len < min || len > max) throw new ValidationError(`${field} length must be ${min}..${max} bytes`);
  return value;
}

export function optionalString(value: unknown, field: string, max = 1000): string | undefined {
  if (value === undefined || value === null) return undefined;
  return asString(value, field, max, 0);
}

export function asInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} must be an integer in ${min}..${max}`);
  }
  return value;
}

export function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new ValidationError(`${field} must be a boolean`);
  return value;
}

export function asUuid(value: unknown, field: string): string {
  const s = asString(value, field, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)) {
    throw new ValidationError(`${field} must be a UUID`);
  }
  return s.toLowerCase();
}

export function asStringArray(value: unknown, field: string, maxItems = 100): string[] {
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array`);
  if (value.length > maxItems) throw new ValidationError(`${field} has too many items`);
  const out: string[] = [];
  for (const item of value) {
    const s = asString(item, field, 128);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(s)) throw new ValidationError(`${field} contains an invalid id`);
    out.push(s);
  }
  return [...new Set(out)];
}

export class ValidationError extends Error {}

export function parseBody(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ValidationError("invalid JSON body");
  }
  if (!isRecord(value)) throw new ValidationError("body must be a JSON object");
  return value;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function nowMs(): number {
  return Date.now();
}

export function b64Encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function b64Decode(value: string): Uint8Array {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function b64urlEncode(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return b64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function b64urlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return decoder.decode(b64Decode(padded));
}

export function isStrictBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    const bytes = b64Decode(value);
    return b64Encode(bytes) === value;
  } catch {
    return false;
  }
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64urlEncode(buf);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function clampInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function normalizeOrigin(raw: string): string {
  return new URL(raw).origin;
}

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

export function parseCursor(cursor: string | null): { createdAt: number; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = JSON.parse(b64urlDecode(cursor)) as unknown;
    if (!isRecord(raw)) return null;
    if (typeof raw.createdAt !== "number" || typeof raw.id !== "string") return null;
    if (!Number.isSafeInteger(raw.createdAt) || raw.id.length > 128) return null;
    return { createdAt: raw.createdAt, id: raw.id };
  } catch {
    return null;
  }
}

export function makeCursor(createdAt: number, id: string): string {
  return b64urlEncode(JSON.stringify({ createdAt, id }));
}
