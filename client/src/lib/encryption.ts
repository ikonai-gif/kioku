/**
 * KIOKU™ E2E Encryption — Client-side crypto using Web Crypto API (SubtleCrypto)
 * AES-256-GCM symmetric encryption with PBKDF2 key derivation from passphrase
 */

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;

/** Convert ArrayBuffer to base64 string */
function bufToBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

/** Convert base64 string to ArrayBuffer */
function base64ToBuf(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

/** Derive AES-256-GCM key from passphrase using PBKDF2 */
export async function deriveKey(
  passphrase: string,
  salt?: Uint8Array,
): Promise<{ key: CryptoKey; salt: string }> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const usedSalt = salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES));

  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: usedSalt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: KEY_BITS },
    false,
    ["encrypt", "decrypt"],
  );

  return { key, salt: bufToBase64(usedSalt.buffer) };
}

/** Encrypt plaintext with AES-256-GCM */
export async function encrypt(
  plaintext: string,
  key: CryptoKey,
): Promise<{ ciphertext: string; iv: string; tag: string }> {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );

  // AES-GCM appends the 16-byte auth tag to the ciphertext
  const combined = new Uint8Array(encrypted);
  const ciphertextBytes = combined.slice(0, combined.length - 16);
  const tagBytes = combined.slice(combined.length - 16);

  return {
    ciphertext: bufToBase64(ciphertextBytes.buffer),
    iv: bufToBase64(iv.buffer),
    tag: bufToBase64(tagBytes.buffer),
  };
}

/** Decrypt ciphertext with AES-256-GCM */
export async function decrypt(
  ciphertext: string,
  iv: string,
  tag: string,
  key: CryptoKey,
): Promise<string> {
  const ciphertextBuf = new Uint8Array(base64ToBuf(ciphertext));
  const tagBuf = new Uint8Array(base64ToBuf(tag));
  const ivBuf = new Uint8Array(base64ToBuf(iv));

  // Reconstruct the combined buffer (ciphertext + tag) for AES-GCM
  const combined = new Uint8Array(ciphertextBuf.length + tagBuf.length);
  combined.set(ciphertextBuf, 0);
  combined.set(tagBuf, ciphertextBuf.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBuf },
    key,
    combined.buffer,
  );

  return new TextDecoder().decode(decrypted);
}

/** Generate a human-readable recovery key (24 words from random bytes) */
export function generateRecoveryKey(): string {
  const words = [
    "alpha", "bravo", "coral", "delta", "eagle", "flame", "globe", "haven",
    "ivory", "jade", "karma", "lunar", "maple", "noble", "ocean", "pearl",
    "quartz", "river", "solar", "tiger", "unity", "vivid", "waltz", "xenon",
    "yield", "zephyr", "amber", "basil", "cedar", "drift", "ember", "frost",
    "grain", "haze", "iris", "jewel", "knoll", "lotus", "mint", "nexus",
    "opal", "prism", "quill", "rune", "slate", "thorn", "umbra", "vault",
    "wren", "xylem", "yew", "zinc", "arch", "blade", "cliff", "dawn",
    "echo", "fern", "glow", "harp", "isle", "jet", "kite", "lark",
  ];
  const indices = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(indices)
    .map((b) => words[b % words.length])
    .join("-");
}

/** Export salt for storing on server (used to re-derive key) */
export function getSaltFromBase64(saltB64: string): Uint8Array {
  return new Uint8Array(base64ToBuf(saltB64));
}
