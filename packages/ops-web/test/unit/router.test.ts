// == ARGUS AGENT PROJECT ==
import { describe, expect, it } from 'vitest'
import { href, parseRoute } from '../../lib/client/router.js'

describe('the console\'s addresses', () => {
  it('name every place, and the address of a place reads back as that place', () => {
    const places = [
      { name: 'home' },
      { name: 'project', id: 'site-firma', tab: 'settings', sec: 'tools' },
      { name: 'project', id: 'a b/c', tab: 'chat', sec: '' },
      { name: 'inbox' },
      { name: 'sessions' },
      { name: 'schedules' },
      { name: 'costs' },
      { name: 'settings', sec: 'access' },
      { name: 'settings', sec: '' },
      { name: 'setup' },
    ] as const
    for (const place of places) expect(parseRoute(href(place))).toEqual(place)
  })

  it('follow the addresses from before 0.7.3, and send anything unknown home', () => {
    expect(parseRoute('#projects/site-firma')).toEqual({ name: 'project', id: 'site-firma', tab: 'chat', sec: '' })
    expect(parseRoute('#approvals')).toEqual({ name: 'inbox' })
    expect(parseRoute('#tasks')).toEqual({ name: 'sessions' })
    expect(parseRoute('#runs')).toEqual({ name: 'costs' })
    expect(parseRoute('#users')).toEqual({ name: 'settings', sec: 'users' })
    expect(parseRoute('#overview')).toEqual({ name: 'home' })
    expect(parseRoute('')).toEqual({ name: 'home' })
    expect(parseRoute('#/nowhere')).toEqual({ name: 'home' })
    expect(parseRoute('#/p/%E0%A4%A')).toEqual({ name: 'project', id: '%E0%A4%A', tab: 'chat', sec: '' })
  })
})
