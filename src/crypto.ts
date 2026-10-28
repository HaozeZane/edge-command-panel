import { b64Decode, b64Encode, constantTimeEqual, sha256Bytes } from "./util";

function buffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

const keyCache = new Map<string, CryptoKey>();

function decodeKey(raw: string): Uint8Array {
  const bytes = b64Decode(raw);
  if (bytes.byteLength !== 32) throw new Error("CREDENTIAL_ENCRYPTION_KEY must be 32 bytes base64");
  return bytes;
}

async function importAes(raw: string): Promise<CryptoKey> {
  const cached = keyCache.get(raw);
  if (cached) return cached;
  const key = await crypto.subtle.importKey("raw", buffer(decodeKey(raw)), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  keyCache.set(raw, key);
  return key;
}

export function validEncryptionKey(raw: string | undefined): raw is string {
  if (!raw) return false;
  try {
    decodeKey(raw);
    return true;
  } catch {
    return false;
  }
}

export async function encryptSecret(plaintext: string, rawKey: string): Promise<string> {
  const key = await importAes(rawKey);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: buffer(iv) },
    key,
    buffer(new TextEncoder().encode(plaintext)),
  );
  return `v1.${b64Encode(iv)}.${b64Encode(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(packed: string, rawKey: string): Promise<string> {
  const parts = packed.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("unsupported secret envelope");
  const key = await importAes(rawKey);
  const iv = b64Decode(parts[1]!);
  const ciphertext = b64Decode(parts[2]!);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(iv) }, key, buffer(ciphertext));
  return new TextDecoder().decode(plain);
}

export async function tokenMatches(presented: string | null, storedHex: string): Promise<boolean> {
  if (!presented) return false;
  const digest = await sha256Bytes(presented);
  const stored = new Uint8Array(storedHex.length / 2);
  if (storedHex.length % 2 !== 0) return false;
  for (let i = 0; i < stored.length; i++) {
    const byte = Number.parseInt(storedHex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(byte)) return false;
    stored[i] = byte;
  }
  return constantTimeEqual(digest, stored);
}

export async function verifyEd25519(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  if (publicKey.byteLength !== 32) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      buffer(publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify("Ed25519", key, buffer(signature), buffer(message));
  } catch {
    return false;
  }
}
