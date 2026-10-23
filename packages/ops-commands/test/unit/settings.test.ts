// == ARGUS AGENT PROJECT ==
import { describe, expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { describeSchema, pendingRestart, schemaAt, systemApply, type SchemaNode } from '../../src/settings.js'

const schema = z.object({
  timezone: z.string().default('UTC').description('Where days begin'),
  tasks: z.object({ model: z.string().default('deepseek/deepseek-v4-flash') }).default({}),
  web: z.object({
    session_hours: z.number().min(1).max(720).default(24),
    public: z.boolean().default(false),
    mode: z.union([z.const('a'), z.const('b')]).default('a'),
    hosts: z.array(z.string()).default([]),
    prices: z.dict(z.number()).default({}),
  }).default({}),
}) as unknown as SchemaNode

describe('settings', () => {
  it('describe every leaf: its kind, choices, bounds, default, value and whether the file sets it', () => {
    const fields = describeSchema(schema, { web: { session_hours: 48 } }, systemApply)
    expect(fields.map((field) => field.key)).toEqual(['timezone', 'tasks.model', 'web.session_hours', 'web.public', 'web.mode', 'web.hosts', 'web.prices'])
    expect(fields[0]).toMatchObject({ kind: 'string', value: 'UTC', set: false, description: 'Where days begin', apply: 'restart' })
    expect(fields[1]).toMatchObject({ apply: 'live' })
    expect(fields[2]).toMatchObject({ kind: 'number', min: 1, max: 720, default: 24, value: 48, set: true })
    expect(fields[4]).toMatchObject({ kind: 'enum', options: ['a', 'b'] })
    expect(fields.slice(5).map((field) => field.kind)).toEqual(['list', 'map'])
    expect(schemaAt(schema, 'web.session_hours')?.type).toBe('number')
    expect(schemaAt(schema, 'web')?.type).toBe('object')
    expect(schemaAt(schema, 'web.nothing')).toBeUndefined()
    expect(schemaAt(schema, 'timezone.deeper')).toBeUndefined()
  })

  it('wait for a restart only for what changed since the start and does not apply at once', () => {
    expect(pendingRestart(schema, { web: { session_hours: 48 }, tasks: { model: 'x/y' } }, {})).toEqual(['web.session_hours'])
    // Written back to its default value: nothing waits.
    expect(pendingRestart(schema, { web: { session_hours: 24 } }, {})).toEqual([])
  })
})
