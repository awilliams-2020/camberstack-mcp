import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Opaque random token, URL-safe. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Tokens are stored as hashes only, so a copy of the database cannot be replayed. */
export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** AES-256-GCM. Output: base64url(iv[12] | tag[16] | ciphertext). */
export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}

export function decrypt(key: Buffer, blob: string): string {
  const b = Buffer.from(blob, "base64url");
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

/** A purpose-specific key from ENCRYPTION_KEY, so signing links needs no extra secret. */
export function deriveKey(key: Buffer, label: string): Buffer {
  return createHash("sha256").update(key).update(label).digest();
}

/** Short HMAC for signed links (32 base64url chars). */
export function sign(key: Buffer, message: string): string {
  return createHmac("sha256", key).update(message).digest("base64url").slice(0, 32);
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
