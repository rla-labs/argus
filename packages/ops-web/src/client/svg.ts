// == ARGUS AGENT PROJECT ==
/** The console's drawings, all inline SVG: no images, nothing fetched. */
import { html } from 'htm/preact'
import type { VNode } from 'preact'
import { money, t } from './i18n.js'

/** A project as the constellation draws it. */
export interface Star {
  readonly id: string
  readonly running: boolean
  readonly waiting: boolean
  readonly status: string
  readonly invalid: string | null
  readonly dayPct: number | null
}

/** The orbits: centre, and each ring's radii. */
const CX = 320
const CY = 225
// The inner ring clears the core (a 52-radius hexagon) at its top and bottom too.
const RINGS = [
  { rx: 150, ry: 92 },
  { rx: 215, ry: 122 },
  { rx: 285, ry: 152 },
]

/** Where the i-th project sits: rings in turn, spread by the golden angle so none overlap. */
function place(index: number): { x: number; y: number } {
  const ring = RINGS[index % RINGS.length] as { rx: number; ry: number }
  const angle = (index * 137.508 + 200) * (Math.PI / 180)
  return { x: CX + ring.rx * Math.cos(angle), y: CY + ring.ry * Math.sin(angle) }
}

/** A star's colour and label, by state. */
function lookOf(star: Star): { color: string; label: string } {
  if (star.invalid !== null) return { color: '#ff6b6b', label: t('state.invalid') }
  if (star.waiting) return { color: '#ffd166', label: t('state.waiting') }
  if (star.running) return { color: '#ff8a3d', label: t('state.running') }
  if (star.status === 'paused') return { color: '#8fa6c4', label: t('state.paused') }
  return { color: '#3bd5ff', label: t('state.idle') }
}

/** The projects orbiting the front desk. */
export function Constellation({ stars }: { stars: readonly Star[] }): VNode {
  const placed = stars.map((star, index) => ({ star, ...place(index), look: lookOf(star) }))
  const hex = (x: number, y: number, r: number): string =>
    Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i - Math.PI / 2
      return `${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)}`
    }).join(' ')
  return html`<svg viewBox="0 0 640 470" width="100%" role="img" aria-label=${t('constellation.aria')} style="display:block;max-height:520px">
    <defs>
      <radialGradient id="coreGlow"><stop offset="0" stop-color="#3BD5FF" stop-opacity=".5"></stop><stop offset="1" stop-color="#3BD5FF" stop-opacity="0"></stop></radialGradient>
      <radialGradient id="hotGlow"><stop offset="0" stop-color="#FF8A3D" stop-opacity=".55"></stop><stop offset="1" stop-color="#FF8A3D" stop-opacity="0"></stop></radialGradient>
      <pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="rgba(59,213,255,.14)"></circle></pattern>
    </defs>
    <rect width="640" height="470" fill="url(#dots)"></rect>
    ${RINGS.map(
      (ring, i) =>
        html`<ellipse cx=${CX} cy=${CY} rx=${ring.rx} ry=${ring.ry} fill="none" stroke=${`rgba(59,213,255,${0.35 - i * 0.09})`} stroke-dasharray=${i === 0 ? '' : i === 1 ? '2 6' : '1 9'}></ellipse>`,
    )}
    ${placed
      .filter((p) => p.star.running || p.star.waiting)
      .map(
        (p) => html`<line x1=${CX} y1=${CY} x2=${p.x} y2=${p.y} stroke=${p.look.color} stroke-width="1.3" opacity=".75"></line>
          <circle r="3" fill="#FFB27D"><animateMotion dur="2.6s" repeatCount="indefinite" path=${`M${CX} ${CY} L${p.x.toFixed(1)} ${p.y.toFixed(1)}`}></animateMotion></circle>`,
      )}
    <ellipse cx=${CX} cy=${CY + 75} rx="78" ry="16" fill="none" stroke="rgba(59,213,255,.5)"></ellipse>
    <ellipse cx=${CX} cy=${CY + 75} rx="54" ry="10" fill="none" stroke="#FF8A3D" stroke-opacity=".6"></ellipse>
    <circle cx=${CX} cy=${CY} r="86" fill="url(#coreGlow)"></circle>
    <polygon points=${hex(CX, CY, 52)} fill="rgba(6,14,26,.92)" stroke="#3BD5FF" stroke-width="1.5"></polygon>
    <polygon class="spin" points=${hex(CX, CY, 42)} fill="none" stroke="rgba(59,213,255,.35)" stroke-dasharray="3 3">
      <animateTransform attributeName="transform" type="rotate" from=${`0 ${CX} ${CY}`} to=${`360 ${CX} ${CY}`} dur="40s" repeatCount="indefinite"></animateTransform>
    </polygon>
    <path d=${`M${CX - 28} ${CY} Q${CX} ${CY - 22} ${CX + 28} ${CY} Q${CX} ${CY + 22} ${CX - 28} ${CY} Z`} fill="rgba(59,213,255,.15)" stroke="#9BEBFF" stroke-width="1.5"></path>
    <circle cx=${CX} cy=${CY} r="9" fill="#FF8A3D"></circle>
    <circle cx=${CX} cy=${CY} r="3.5" fill="#04070D"></circle>
    <text x=${CX} y=${CY + 110} text-anchor="middle" fill="#9BEBFF" font-family="ui-monospace,monospace" font-size="11" letter-spacing="2.5">${t('constellation.core')}</text>
    ${placed.map((p) => {
      const pct = Math.min(100, Math.max(0, p.star.dayPct ?? 0))
      return html`<g>
        ${p.star.running ? html`<circle cx=${p.x} cy=${p.y} r="34" fill="url(#hotGlow)"></circle>` : null}
        <circle cx=${p.x} cy=${p.y} r="22" fill="none" stroke=${p.look.color} stroke-opacity=".2" stroke-width="3"></circle>
        ${p.star.dayPct === null
          ? null
          : html`<circle cx=${p.x} cy=${p.y} r="22" fill="none" stroke=${p.look.color} stroke-width="3" stroke-dasharray=${`${((pct / 100) * 138.2).toFixed(1)} 138.2`} transform=${`rotate(-90 ${p.x} ${p.y})`}></circle>`}
        ${p.star.waiting
          ? html`<circle cx=${p.x} cy=${p.y} r="28" fill="none" stroke="#FFD166" stroke-dasharray="5 4"><animateTransform attributeName="transform" type="rotate" from=${`0 ${p.x} ${p.y}`} to=${`360 ${p.x} ${p.y}`} dur="8s" repeatCount="indefinite"></animateTransform></circle>`
          : null}
        <polygon points=${hex(p.x, p.y, 12)} fill="#0B1424" stroke=${p.look.color} stroke-width="1.5"></polygon>
        <text x=${p.x} y=${p.y + (p.y < CY ? -46 : 42)} text-anchor="middle" fill="#E6F4FF" font-family="ui-monospace,monospace" font-size="13">${p.star.id}</text>
        <text x=${p.x} y=${p.y + (p.y < CY ? -31 : 57)} text-anchor="middle" fill=${p.look.color} font-family="ui-monospace,monospace" font-size="10" letter-spacing="1.5">${p.look.label}${p.star.dayPct === null ? '' : ` · ${Math.round(p.star.dayPct)}%`}</text>
      </g>`
    })}
  </svg>`
}

/** Today's spending against the daily limit: a 270° arc. */
export function Gauge({ spent, limit }: { spent: number; limit: number | null }): VNode {
  const share = limit === null || limit === 0 ? 0 : Math.min(1, spent / limit)
  return html`<svg width="160" height="140" viewBox="0 0 180 160" role="img" aria-label=${t('spend.aria', { spent: money(spent), limit: limit === null ? t('spend.unlimited') : money(limit) })}>
    <circle cx="90" cy="88" r="70" fill="none" stroke="rgba(59,213,255,.14)" stroke-width="10" stroke-dasharray="329.9 439.8" transform="rotate(135 90 88)"></circle>
    <circle cx="90" cy="88" r="70" fill="none" stroke=${share >= 0.8 ? '#FF8A3D' : '#3BD5FF'} stroke-width="10" stroke-dasharray=${`${(share * 329.9).toFixed(1)} 439.8`} transform="rotate(135 90 88)"></circle>
    <circle cx="90" cy="88" r="56" fill="none" stroke="rgba(59,213,255,.25)" stroke-dasharray="1.5 6.3"></circle>
    <text x="90" y="92" text-anchor="middle" fill="#E6F4FF" font-family="ui-monospace,monospace" font-size="22">${money(spent)}</text>
    <text x="90" y="112" text-anchor="middle" fill="#8FA6C4" font-family="ui-monospace,monospace" font-size="11">${limit === null ? t('spend.unlimited') : t('spend.of', { limit: money(limit) })}</text>
  </svg>`
}

/** A small line of daily spending. */
export function Trend({ points }: { points: ReadonlyArray<{ micros: number }> }): VNode {
  const max = Math.max(1, ...points.map((p) => p.micros))
  const step = points.length > 1 ? 300 / (points.length - 1) : 300
  const line = points.map((p, i) => `${(i * step).toFixed(1)},${(44 - (p.micros / max) * 38).toFixed(1)}`).join(' ')
  return html`<svg width="100%" height="48" viewBox="0 0 300 48" preserveAspectRatio="none" aria-hidden="true">
    <polyline points=${`${line} 300,48 0,48`} fill="rgba(59,213,255,.08)" stroke="none"></polyline>
    <polyline points=${line} fill="none" stroke="#3BD5FF" stroke-width="1.5"></polyline>
  </svg>`
}

/** The next 24 hours on a dial: the hand is now, the dots are scheduled runs. */
export function Dial({ now, runs }: { now: number; runs: ReadonlyArray<{ at: number }> }): VNode {
  const point = (at: number, r: number): { x: number; y: number } => {
    const date = new Date(at)
    const hours = date.getHours() + date.getMinutes() / 60
    const angle = (hours / 24) * 2 * Math.PI - Math.PI / 2
    return { x: 110 + r * Math.cos(angle), y: 110 + r * Math.sin(angle) }
  }
  const hand = point(now, 64)
  return html`<svg width="190" height="190" viewBox="0 0 220 220" role="img" aria-label=${t('schedule.aria')}>
    <circle cx="110" cy="110" r="92" fill="none" stroke="rgba(59,213,255,.12)"></circle>
    <circle cx="110" cy="110" r="80" fill="none" stroke="rgba(59,213,255,.45)" stroke-width="6" stroke-dasharray="1.5 19.44" transform="rotate(-90.5 110 110)"></circle>
    <circle cx="110" cy="110" r="60" fill="none" stroke="rgba(59,213,255,.15)" stroke-dasharray="2 4"></circle>
    <g font-family="ui-monospace,monospace" font-size="10" fill="#8FA6C4" text-anchor="middle">
      <text x="110" y="12">00</text><text x="210" y="114">06</text><text x="110" y="216">12</text><text x="10" y="114">18</text>
    </g>
    <line x1="110" y1="110" x2=${hand.x} y2=${hand.y} stroke="#FF8A3D" stroke-width="2"></line>
    <circle cx="110" cy="110" r="4" fill="#FF8A3D"></circle>
    ${runs.map((run) => {
      const p = point(run.at, 80)
      return html`<circle cx=${p.x} cy=${p.y} r="6" fill="#04070D" stroke="#3BD5FF" stroke-width="2"></circle>`
    })}
  </svg>`
}
