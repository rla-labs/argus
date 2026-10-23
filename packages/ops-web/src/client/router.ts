// == ARGUS AGENT PROJECT ==
/**
 * Where the page is: every place has an address (`#/p/site-firma/settings/tools`), so a
 * link, the back button and a reload all land in the same place.
 */
import { useEffect, useState } from 'preact/hooks'

/** A place in the console. */
export type Route =
  | { readonly name: 'home' }
  | { readonly name: 'project'; readonly id: string; readonly tab: string; readonly sec: string }
  | { readonly name: 'inbox' }
  | { readonly name: 'sessions' }
  | { readonly name: 'schedules' }
  | { readonly name: 'costs' }
  | { readonly name: 'settings'; readonly sec: string }
  | { readonly name: 'chat' }
  | { readonly name: 'setup' }

/** The addresses before 0.7.3 (`#projects/site-firma`), still followed. */
const OLD: Record<string, string> = { overview: '', approvals: 'inbox', tasks: 'sessions', runs: 'costs', users: 'settings/users', projects: '' }

/**
 * The place an address names.
 *
 * @param hash `location.hash`.
 * @returns the route; anything unknown is home.
 */
export function parseRoute(hash: string): Route {
  let path = hash.replace(/^#\/?/, '')
  const [first = '', ...rest] = path.split('/')
  if (first in OLD) path = first === 'projects' && rest.length > 0 ? `p/${rest.join('/')}` : [OLD[first], ...rest].filter((part) => part !== '').join('/')
  const parts = path.split('/').map((part) => {
    try {
      return decodeURIComponent(part)
    } catch {
      return part
    }
  })
  switch (parts[0]) {
    case 'p':
      return parts[1] === undefined || parts[1] === '' ? { name: 'home' } : { name: 'project', id: parts[1], tab: parts[2] || 'chat', sec: parts[3] || '' }
    case 'inbox':
    case 'sessions':
    case 'schedules':
    case 'costs':
    case 'chat':
    case 'setup':
      return { name: parts[0] }
    case 'settings':
      return { name: 'settings', sec: parts[1] || '' }
    default:
      return { name: 'home' }
  }
}

/**
 * The address of a place.
 *
 * @param route the place.
 * @returns the hash, `#/…`.
 */
export function href(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/'
    case 'project':
      return `#/p/${[route.id, route.tab, route.sec].filter((part) => part !== '').map(encodeURIComponent).join('/')}`
    case 'settings':
      return route.sec === '' ? '#/settings' : `#/settings/${encodeURIComponent(route.sec)}`
    default:
      return `#/${route.name}`
  }
}

/** Go to a place, as a link would. */
export function go(route: Route): void {
  location.hash = href(route)
}

/** The current place, following the address. */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash))
  useEffect(() => {
    const follow = (): void => {
      setRoute(parseRoute(location.hash))
      window.scrollTo({ top: 0 })
    }
    window.addEventListener('hashchange', follow)
    follow()
    return () => window.removeEventListener('hashchange', follow)
  }, [])
  return route
}
