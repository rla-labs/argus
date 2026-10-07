// == ARGUS AGENT PROJECT ==
import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  {
    test: {
      name: 'spikes',
      root: '.',
      include: ['test/spikes/**/*.test.ts'],
      testTimeout: 60_000,
      hookTimeout: 60_000,
      pool: 'forks',
    },
  },
  {
    test: {
      name: 'packages',
      root: '.',
      // ops-telegram falls back to TELEGRAM_BOT_TOKEN; a developer's real token must
      // never put a test on the live Bot API.
      env: { TELEGRAM_BOT_TOKEN: '' },
      include: ['packages/*/test/**/*.test.ts'],
      testTimeout: 60_000,
      hookTimeout: 60_000,
      pool: 'forks',
    },
  },
  {
    test: {
      name: 'deploy',
      root: '.',
      include: ['test/deploy/**/*.test.ts'],
      // The deploy scripts drive real processes and real files. A generous timeout,
      // and `forks` so a test that spawns a shell cannot disturb another project.
      testTimeout: 120_000,
      hookTimeout: 120_000,
      pool: 'forks',
    },
  },
  {
    test: {
      name: 'e2e',
      root: '.',
      // ops-telegram falls back to TELEGRAM_BOT_TOKEN; a developer's real token must
      // never put a test on the live Bot API.
      env: { TELEGRAM_BOT_TOKEN: '' },
      include: ['test/e2e/**/*.test.ts'],
      testTimeout: 120_000,
      hookTimeout: 120_000,
      pool: 'forks',
    },
  },
  {
    test: {
      // Real Telegram and real billed models. Skipped unless ARGUS_LIVE=1 (test/live).
      name: 'live',
      root: '.',
      include: ['test/live/**/*.test.ts'],
      testTimeout: 300_000,
      hookTimeout: 120_000,
      pool: 'forks',
    },
  },
])
