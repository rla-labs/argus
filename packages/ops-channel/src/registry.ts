// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/channel/registry` — the adapter registry.
 *
 * An adapter is started when it is registered and stopped when its disposer runs.
 * The registry owns that lifecycle so a plugin can be unloaded without leaking a
 * polling loop or a socket — the HMR-safety rule AGENTS.md requires.
 *
 * @module @argus-agent/channel/registry
 */
import type {
  ButtonAnswer,
  ChannelAdapter,
  IncomingMessage,
} from '@argus-agent/types'

/** Callbacks an adapter's messages are routed to. */
export interface RegistrySink {
  onMessage(message: IncomingMessage): void
  onButton(answer: ButtonAnswer): void
}

/** One registered adapter. */
interface Registration {
  readonly adapter: ChannelAdapter
  /** The adapter's own disposer, once `start` resolved. */
  stop: (() => Promise<void>) | undefined
  /** Whether `start` has settled, successfully or not. */
  started: boolean
  /** Called when `start` settles, so an awaiting caller resumes. */
  startResolve: (() => void) | undefined
}

/**
 * The adapter registry.
 *
 * Multiple adapters coexist: a deployment may run Telegram and a console adapter
 * at once, and each has its own limits and its own channel name.
 */
export class ChannelRegistry {
  private readonly registrations = new Map<string, Registration>()

  constructor(private readonly sink: RegistrySink) {}

  /**
   * Wait until an adapter's `start` has settled.
   *
   * `register` starts asynchronously — a plugin's `apply` is synchronous — so a
   * caller that must not race the start awaits this. Returns immediately when the
   * adapter has already settled, and for an unregistered name.
   *
   * @param name the adapter's name.
   * @returns once `start` settled.
   */
  async started(name: string): Promise<void> {
    const registration = this.registrations.get(name)
    if (registration === undefined || registration.started) return
    await new Promise<void>((resolve) => {
      registration.startResolve = resolve
    })
  }

  /**
   * Register and start an adapter.
   *
   * @param adapter the adapter.
   * @returns a disposer that stops it.
   * @throws {Error} when the name is already registered, because two adapters
   *   answering to one name would make every address ambiguous.
   */
  register(adapter: ChannelAdapter): () => Promise<void> {
    if (this.registrations.has(adapter.name)) {
      throw new Error(`a channel adapter named "${adapter.name}" is already registered`)
    }
    const registration: Registration = { adapter, stop: undefined, started: false, startResolve: undefined }
    this.registrations.set(adapter.name, registration)

    // Started eagerly, and the promise is not awaited: a plugin's `apply` is
    // synchronous, and an adapter that takes a second to connect must not block
    // the boot. A failure is recorded rather than thrown, so one broken adapter
    // does not stop the others.
    void adapter
      .start(
        (message) => this.sink.onMessage(message),
        (answer) => this.sink.onButton(answer),
      )
      .then((stop) => {
        registration.stop = stop
        // Resolved once the adapter has taken its callbacks. A caller that must not
        // race the start — a test answering immediately, or a deployment waiting
        // before it advertises the channel as ready — awaits this.
        registration.started = true
        registration.startResolve?.()
      })
      .catch((error: unknown) => {
        registration.stop = undefined
        this.startFailure = (error as Error).message
        registration.startResolve?.()
      })

    return async () => {
      this.registrations.delete(adapter.name)
      await registration.stop?.()
    }
  }

  /** The last adapter start failure, for a health report. */
  startFailure: string | undefined

  /** The adapter for a channel name. */
  get(name: string): ChannelAdapter | undefined {
    return this.registrations.get(name)?.adapter
  }

  /** Every registered adapter, sorted by name. */
  adapters(): ChannelAdapter[] {
    return [...this.registrations.values()]
      .map((registration) => registration.adapter)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  /** The names of the registered adapters. */
  names(): string[] {
    return this.adapters().map((adapter) => adapter.name)
  }

  /** Whether any adapter is registered. */
  get isEmpty(): boolean {
    return this.registrations.size === 0
  }

  /** Stop every adapter. */
  async disposeAll(): Promise<void> {
    const all = [...this.registrations.values()]
    this.registrations.clear()
    await Promise.all(all.map(async (registration) => registration.stop?.()))
  }
}
