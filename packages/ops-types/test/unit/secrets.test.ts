// == ARGUS AGENT PROJECT ==
import { describe, expect, it } from 'vitest'
import { keyTail, looksLikeSecret } from '@argus-agent/types'

describe('looksLikeSecret', () => {
  it('catches the key shapes people paste', () => {
    for (const text of [
      'sk-or-v1-0123456789abcdef0123456789abcdef',
      'my key is sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV',
      'AIzaSyA1234567890abcdefghijklmnopqrstuv',
      'gsk_abcdefghijklmnopqrstuvwxyz0123',
      '123456789:AAH4abcdefghijklmnopqrstuvwxyz012345',
    ]) {
      expect(looksLikeSecret(text), text).toBe(true)
    }
  })

  it('leaves ordinary text alone', () => {
    for (const text of ['ask-me later', 'the sk- prefix', 'build the site and send it', 'task 12:30 today']) {
      expect(looksLikeSecret(text), text).toBe(false)
    }
  })

  it('names a key by its last four characters', () => {
    expect(keyTail(' sk-abcdef1234 ')).toBe('…1234')
  })
})
