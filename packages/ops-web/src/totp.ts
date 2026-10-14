// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/web/totp` — time-based one-time codes (RFC 6238), the second factor.
 *
 * Six digits, SHA-1, 30-second steps: what every authenticator app does by default.
 * A code is accepted for the step before and after the current one (a clock a little
 * off), and only once (the caller records the step). Ten recovery codes, stored as
 * hashes, each work once, for a lost phone.
 *
 * @module @argus-agent/web/totp
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'

/** Seconds per step. */
const STEP_S = 30
/** How many recovery codes are given. */
export const RECOVERY_CODES = 10
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Base32 without padding (RFC 4648), as `otpauth://` URIs carry a secret. */
export function base32(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function unbase32(text: string): Buffer {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of text.toUpperCase().replace(/=+$/, '')) {
    const index = ALPHABET.indexOf(char)
    if (index < 0) throw new Error('not base32')
    value = ((value << 5) | index) & 0xffff
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** A new secret: 20 random bytes, base32. */
export function newSecret(): string {
  return base32(randomBytes(20))
}

/** The code for a step (RFC 4226 HOTP over the step counter). */
export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', unbase32(secret)).update(counter).digest()
  const offset = (mac[mac.length - 1] as number) & 15
  const number = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return String(number).padStart(6, '0')
}

/** The step a moment falls in. */
export function stepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_S)
}

/**
 * The step a code matches, within one step of now.
 *
 * @param secret the shared secret.
 * @param code what the person typed; spaces are ignored.
 * @param nowMs the current time.
 * @returns the step, or `undefined` when it matches none.
 */
export function matchStep(secret: string, code: string, nowMs: number): number | undefined {
  const typed = code.replace(/\s+/g, '')
  if (!/^\d{6}$/.test(typed)) return undefined
  const now = stepAt(nowMs)
  for (const step of [now - 1, now, now + 1]) if (codeAt(secret, step) === typed) return step
  return undefined
}

/** What an authenticator app scans or opens. */
export function otpauthUri(secret: string, account: string): string {
  return `otpauth://totp/${encodeURIComponent(`Argus:${account}`)}?secret=${secret}&issuer=Argus&algorithm=SHA1&digits=6&period=${STEP_S}`
}

/** A recovery code's hash, as stored; dashes, spaces and case are ignored. */
export function recoveryHash(code: string): string {
  return createHash('sha256').update(code.replace(/[\s-]+/g, '').toLowerCase()).digest('hex')
}

/** New recovery codes: `xxxxx-xxxxx`, lower-case base32. */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODES }, () => {
    const text = base32(randomBytes(7)).slice(0, 10).toLowerCase()
    return `${text.slice(0, 5)}-${text.slice(5)}`
  })
}
