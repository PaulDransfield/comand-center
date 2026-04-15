// @ts-nocheck
// lib/integrations/encryption.ts
//
// AES-256-GCM encryption for storing third-party API credentials.
//
// WHY: We never store Fortnox tokens, POS keys, or bank credentials in plain text.
// Each credential is encrypted with a key that lives ONLY in your environment variable.
// If the database is ever breached, the tokens are useless without the key.
//
// The key is CREDENTIAL_ENCRYPTION_KEY in .env.local
// Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// Format stored: base64(IV + ciphertext + authTag)
//   IV:      12 random bytes (initialisation vector â€” different for every encryption)
//   authTag: 16 bytes (proves the ciphertext hasn't been tampered with)

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherKey,
} from 'crypto'

const ALGORITHM  = 'aes-256-gcm'
const IV_LENGTH  = 12   // 96-bit IV â€” GCM standard
const TAG_LENGTH = 16   // 128-bit auth tag

function getKey(): CipherKey {
  const keyHex = process.env.CREDENTIAL_ENCRYPTION_KEY
  if (!keyHex) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY is not set. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    )
  }
  if (keyHex.length !== 64) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)')
  }
  return Buffer.from(keyHex, 'hex')
}

/**
 * encrypt(plaintext)
 * Encrypts a string and returns a base64-encoded string safe for database storage.
 * Returns null if plaintext is null/undefined.
 */
export function encrypt(plaintext: string | null | undefined): string | null {
  if (!plaintext) return null

  const key    = getKey()
  const iv     = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH })

  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  // Pack everything into one base64 string: IV + ciphertext + authTag
  return Buffer.concat([iv, encrypted, authTag]).toString('base64')
}

/**
 * decrypt(encryptedBase64)
 * Decrypts a base64-encoded string previously created by encrypt().
 * Returns null if input is null/undefined.
 * Throws if the data has been tampered with (authTag mismatch).
 */
export function decrypt(encryptedBase64: string | null | undefined): string | null {
  if (!encryptedBase64) return null

  const key    = getKey()
  const packed = Buffer.from(encryptedBase64, 'base64')

  // Unpack
  const iv         = packed.subarray(0, IV_LENGTH)
  const authTag    = packed.subarray(packed.length - TAG_LENGTH)
  const ciphertext = packed.subarray(IV_LENGTH, packed.length - TAG_LENGTH)

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH })
  decipher.setAuthTag(authTag)

  try {
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    throw new Error('Decryption failed â€” data may be corrupted or the encryption key has changed')
  }
}
