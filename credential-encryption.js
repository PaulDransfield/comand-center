/**
 * credential-encryption.js
 * lib/integrations/credential-encryption.js
 * ─────────────────────────────────────────────────────────────────────────────
 * AES-256-GCM encryption for integration credentials.
 *
 * Why AES-256-GCM:
 *   - AES-256: military-grade symmetric encryption
 *   - GCM mode: authenticated encryption — detects tampering
 *   - Each encryption generates a unique 12-byte IV (nonce)
 *   - Auth tag verifies data hasn't been modified
 *
 * The encryption key (CREDENTIAL_ENCRYPTION_KEY) is a 32-byte hex string
 * stored only as an environment variable — never in code or database.
 *
 * SETUP:
 *   1. Generate a key:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   2. Add to Vercel:   CREDENTIAL_ENCRYPTION_KEY=<your 64-char hex string>
 *   3. NEVER change this key after credentials are stored — you'll lose all data
 *   4. Back it up securely — losing it means all integrations need re-connecting
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createCipheriv, createDecipheriv, randomBytes, createHmac } from 'crypto';

const ALGORITHM   = 'aes-256-gcm';
const IV_LENGTH   = 12;   // 96-bit IV for GCM
const TAG_LENGTH  = 16;   // 128-bit auth tag

/**
 * getEncryptionKey()
 * Loads and validates the encryption key from environment.
 * Throws clearly if key is missing or malformed.
 */
function getEncryptionKey() {
  const hex = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!hex) throw new Error('CREDENTIAL_ENCRYPTION_KEY environment variable is not set');
  if (hex.length !== 64) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  return Buffer.from(hex, 'hex');
}

/**
 * encrypt(plaintext)
 * Encrypts a string using AES-256-GCM.
 * Returns a single base64 string: IV + ciphertext + auth_tag
 *
 * Format: base64(iv[12] + ciphertext[n] + authTag[16])
 */
export function encrypt(plaintext) {
  if (!plaintext) return null;

  const key     = getEncryptionKey();
  const iv      = randomBytes(IV_LENGTH);
  const cipher  = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack: IV + ciphertext + authTag → base64
  const packed = Buffer.concat([iv, encrypted, authTag]);
  return packed.toString('base64');
}

/**
 * decrypt(encryptedBase64)
 * Decrypts a string previously encrypted with encrypt().
 * Throws if the auth tag doesn't match (data was tampered with).
 */
export function decrypt(encryptedBase64) {
  if (!encryptedBase64) return null;

  const key    = getEncryptionKey();
  const packed = Buffer.from(encryptedBase64, 'base64');

  // Unpack
  const iv         = packed.subarray(0, IV_LENGTH);
  const authTag    = packed.subarray(packed.length - TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH, packed.length - TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch (err) {
    // GCM auth tag mismatch — data corrupted or tampered
    throw new Error('Decryption failed: credential may have been tampered with');
  }
}

/**
 * encryptObject(obj)
 * Encrypts each value in an object individually.
 * Keys are stored in plain text; only values are encrypted.
 *
 * encryptObject({ access_token: 'abc', refresh_token: 'xyz' })
 * → { access_token: 'enc:...', refresh_token: 'enc:...' }
 *
 * Use this for storing a set of credentials as a JSON field.
 */
export function encryptObject(obj) {
  if (!obj) return null;
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    result[key] = val ? 'enc:' + encrypt(String(val)) : null;
  }
  return result;
}

/**
 * decryptObject(obj)
 * Decrypts each value in an object encrypted by encryptObject().
 */
export function decryptObject(obj) {
  if (!obj) return null;
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string' && val.startsWith('enc:')) {
      result[key] = decrypt(val.slice(4));
    } else {
      result[key] = val;  // unencrypted values pass through
    }
  }
  return result;
}

/**
 * maskSecret(value, visibleChars = 4)
 * Masks a secret for safe display in UI.
 * 'sk-ant-api03-abc123...' → 'sk-ant-api03-abc1••••••••••••'
 */
export function maskSecret(value, visibleChars = 8) {
  if (!value || value.length <= visibleChars) return '••••••••';
  return value.substring(0, visibleChars) + '•'.repeat(Math.min(12, value.length - visibleChars));
}

/**
 * generateWebhookSecret()
 * Generates a secure random webhook signing secret.
 */
export function generateWebhookSecret() {
  return 'whsec_' + randomBytes(32).toString('hex');
}

/**
 * verifyWebhookSignature(payload, signature, secret)
 * Verifies an HMAC-SHA256 webhook signature.
 * Use this to verify incoming webhooks from integrations.
 */
export function verifyWebhookSignature(payload, signature, secret) {
  const expected = createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  // Timing-safe comparison to prevent timing attacks
  if (signature.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < signature.length; i++) {
    diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
