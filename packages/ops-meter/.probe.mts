// == ARGUS AGENT PROJECT ==
import { TimezoneCalendar } from './src/time.js'
const bucharest = new TimezoneCalendar('Europe/Bucharest')
const utc = new TimezoneCalendar('UTC')
console.log('UTC day of epoch:', utc.dayOf(0))
console.log('Bucharest day of 2026-10-03T22:00Z:', bucharest.dayOf(Date.parse('2026-10-03T22:00:00Z')), '(should be 2026-10-04, +3)')
console.log('monthOf:', bucharest.monthOf(Date.parse('2026-10-03T22:00:00Z')))
console.log('monthEnd Feb 2024:', utc.monthEnd(Date.parse('2024-02-10T00:00:00Z')), '(leap: 29)')
console.log('monthEnd Feb 2026:', utc.monthEnd(Date.parse('2026-02-10T00:00:00Z')), '(28)')
console.log('monthEnd Dec:', utc.monthEnd(Date.parse('2026-12-05T00:00:00Z')), '(31)')
// DST: Bucharest springs forward 2026-03-29 03:00 -> 04:00 local.
const beforeDst = Date.parse('2026-03-28T22:00:00Z') // 2026-03-29 00:00 local
const nm = bucharest.nextMidnight(beforeDst)
console.log('DST nextMidnight local:', new Date(nm).toISOString(), '-> day:', bucharest.dayOf(nm + 1000))
console.log('hours from 00:00 local to next midnight:', (nm - beforeDst) / 3600000, '(should be 23 on spring-forward)')
// Fall back: 2026-10-25 04:00 -> 03:00
const beforeFall = Date.parse('2026-10-24T21:00:00Z') // 2026-10-25 00:00 local
const nm2 = bucharest.nextMidnight(beforeFall)
console.log('fall-back hours:', (nm2 - beforeFall) / 3600000, '(should be 25)')
// Exactly at midnight must return the NEXT midnight, not now.
const midnight = Date.parse('2026-06-01T21:00:00Z') // 2026-06-02 00:00 local
console.log('at midnight, day:', bucharest.dayOf(midnight), 'next is next day:', bucharest.dayOf(bucharest.nextMidnight(midnight) + 1000))
console.log('nextMonthStart:', bucharest.dayOf(bucharest.nextMonthStart(Date.parse('2026-10-20T12:00:00Z'))))
