// == ARGUS AGENT PROJECT ==
/**
 * A scripted fake LLM adapter.
 *
 * Registers on `ctx.llm` under provider `fake` and returns pre-scripted
 * responses. It reports token usage in exactly the shape a real adapter does —
 * as a `usage` stream chunk that `dsh-agent-loop` folds onto the
 * `assistant/message` session event (see `docs/developer-docs.md#verified-dsh-facts` spike 2) — so
 * a test can assert on cost without calling a provider.
 *
 * @module @argus-agent/testkit/fake-llm
 */
import {
  LlmAdapter,
  type FinishReason,
  type GenerateOptions,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'

/** One tool call the model should emit. */
export interface ScriptedToolCall {
  /** Tool name. */
  readonly name: string
  /** Arguments as a JSON string, exactly as a provider would send them. */
  readonly arguments: string
  /** Tool-call id. Defaults to a stable per-response id. */
  readonly id?: string
}

/** What the model should produce for one request. */
export interface ScriptedResponse {
  /** Assistant text. Omit for a tool-only response. */
  readonly text?: string
  /** Reasoning text, reported as a separate content block. */
  readonly reasoning?: string
  /** Tool calls to emit after the text. */
  readonly toolCalls?: readonly ScriptedToolCall[]
  /** Token usage to report. Defaults to a small non-zero triple. */
  readonly usage?: TokenUsage
  /** Delay before the first chunk, in milliseconds. */
  readonly latencyMs?: number
  /**
   * Fail instead of answering.
   *
   * `'rate-limit'` produces a provider rate-limit error, `'transport'` a
   * generic transport failure. Used to test retry policy and provider error
   * reporting.
   */
  readonly fail?: 'rate-limit' | 'transport'
  /**
   * Finish reason. Defaults to `'stop'`, or `'tool-calls'` when calls are
   * present. `'max-tokens'` simulates a step that hit its output ceiling.
   */
  readonly finishReason?: 'stop' | 'tool-calls' | 'max-tokens'
}

/** A recorded request, for assertions. */
export interface RecordedRequest {
  readonly provider: string
  readonly model: string
  readonly system: string | undefined
  /** Message roles in order. */
  readonly roles: readonly string[]
  /** Concatenated text of the last user message. */
  readonly lastUserText: string
  /** Tool names offered on this request. */
  readonly toolNames: readonly string[]
  readonly maxTokens: number | undefined
}

/** How the adapter chooses a response. */
export type ScriptSource =
  | readonly ScriptedResponse[]
  | ((request: RecordedRequest, callIndex: number) => ScriptedResponse)

/** Options for {@link FakeLlmAdapter}. */
export interface FakeLlmAdapterOptions {
  /** Provider routes to register. Defaults to `['fake']`. */
  readonly providers?: readonly string[]
  /** The script. */
  readonly script: ScriptSource
  /**
   * After the script is exhausted, repeat the last response.
   *
   * Off by default: a test that under-scripts should fail loudly rather than
   * silently loop. The one exception is {@link infiniteLoopScript}, which is
   * deliberately unbounded.
   */
  readonly repeatLast?: boolean
}

/** Raised when the adapter is asked for more responses than the script has. */
export class ScriptExhaustedError extends Error {
  constructor(callIndex: number, scriptLength: number) {
    super(
      `fake LLM script exhausted: request #${callIndex + 1} but the script has ${scriptLength} response(s). ` +
        'Add more responses, or set repeatLast: true.',
    )
    this.name = 'ScriptExhaustedError'
  }
}

/**
 * A fake provider adapter driven by a script.
 *
 * @example
 * ```ts
 * const adapter = new FakeLlmAdapter({
 *   script: [
 *     { text: 'let me look', toolCalls: [{ name: 'bash', arguments: '{"command":"ls"}' }] },
 *     { text: 'done', usage: { inputTokens: 100, outputTokens: 10 } },
 *   ],
 * })
 * ctx.llm.registerAdapter(['fake'], adapter)
 * ```
 */
export class FakeLlmAdapter extends LlmAdapter {
  /** Every request the adapter received, in order. */
  readonly requests: RecordedRequest[] = []

  private callIndex = 0
  private script: ScriptSource
  private readonly repeatLast: boolean

  constructor(options: FakeLlmAdapterOptions) {
    super()
    this.script = options.script
    this.repeatLast = options.repeatLast ?? false
  }

  /** How many requests have been served. */
  get callCount(): number {
    return this.callIndex
  }

  /**
   * Replace the script and reset the call cursor.
   *
   * A test that needs a different response shape partway through — a two-step
   * turn after a simple one — would otherwise have to build the whole sequence
   * up front. Resetting the cursor means the new script starts from its first
   * entry.
   *
   * @param script the new script.
   */
  setScript(script: ScriptSource): void {
    this.script = script
    this.callIndex = 0
  }

  override providerInfo(provider: string) {
    return {
      id: provider,
      name: `Fake (${provider})`,
      models: [],
    }
  }

  override async listModels() {
    return [] as const
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const recorded = recordRequest(options)
    this.requests.push(recorded)

    const index = this.callIndex++
    const response = this.resolve(index)

    if (response.fail) {
      throw transportError(response.fail)
    }
    if (response.latencyMs && response.latencyMs > 0) {
      await delay(response.latencyMs, options.signal)
    }

    let blockIndex = 0

    if (response.reasoning !== undefined) {
      yield { type: 'block-start', index: blockIndex, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: blockIndex, text: response.reasoning }
      yield {
        type: 'block-end',
        index: blockIndex,
        block: { type: 'reasoning', text: response.reasoning },
      }
      blockIndex += 1
    }

    if (response.text !== undefined) {
      yield { type: 'block-start', index: blockIndex, blockType: 'text' }
      yield { type: 'text-delta', index: blockIndex, text: response.text }
      yield {
        type: 'block-end',
        index: blockIndex,
        block: { type: 'text', text: response.text },
      }
      blockIndex += 1
    }

    for (const [callOffset, call] of (response.toolCalls ?? []).entries()) {
      const id = (call.id ?? `call-${index}-${callOffset}`) as never
      yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: blockIndex, id, name: call.name, argumentsDelta: call.arguments }
      yield {
        type: 'block-end',
        index: blockIndex,
        block: {
          type: 'tool-call',
          id,
          name: call.name,
          arguments: call.arguments,
        },
      }
      blockIndex += 1
    }

    yield {
      type: 'usage',
      usage: response.usage ?? { inputTokens: 10, outputTokens: 5 },
    }
    // `FinishReason` is a tagged union in dsh, not a bare string.
    yield { type: 'finish', reason: finishReasonOf(response) }
  }

  private resolve(index: number): ScriptedResponse {
    if (typeof this.script === 'function') return this.script(this.requests[index]!, index)
    const entry = this.script[index]
    if (entry !== undefined) return entry
    if (this.repeatLast) {
      const last = this.script[this.script.length - 1]
      if (last !== undefined) return last
    }
    throw new ScriptExhaustedError(index, this.script.length)
  }
}

/**
 * A script that repeats the same tool call forever.
 *
 * Deliberately unbounded: this is the fixture for loop-detection tests, where
 * the governor must stop the run rather than the script stopping itself.
 *
 * @param toolName the tool to call repeatedly.
 * @param args the arguments, identical on every call so loop detection matches.
 * @returns a script source.
 */
export function infiniteLoopScript(toolName = 'bash', args = '{"command":"echo loop"}'): ScriptSource {
  return () => ({
    toolCalls: [{ name: toolName, arguments: args, id: 'loop-call' }],
    usage: { inputTokens: 10, outputTokens: 5 },
  })
}

/**
 * A script that answers with plain text once.
 * @param text the text to answer with.
 * @param usage optional usage to report.
 * @returns a script source.
 */
export function textScript(text = 'ok', usage?: TokenUsage): ScriptSource {
  return [{ text, usage }]
}

/**
 * A script that always fails.
 *
 * `repeatLast: true` so every request fails, not just the first: a retry test
 * needs the failure to persist until the policy gives up.
 *
 * @param kind the failure kind.
 * @returns a script source.
 */
export function failureScript(kind: 'rate-limit' | 'transport' = 'transport'): ScriptSource {
  return [{ fail: kind }]
}

/** Resolve the finish reason for one scripted response. */
function finishReasonOf(response: ScriptedResponse): FinishReason {
  const kind = response.finishReason ?? ((response.toolCalls?.length ?? 0) > 0 ? 'tool-calls' : 'stop')
  return { kind } as FinishReason
}

/** Build a recorded request from dsh's generate options. */
function recordRequest(options: GenerateOptions): RecordedRequest {
  const messages = options.messages ?? []
  let lastUserText = ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    lastUserText = textOf(message.content)
    break
  }
  return {
    provider: options.provider,
    model: options.model,
    system: options.system,
    roles: messages.map((message) => message.role),
    lastUserText,
    toolNames: (options.tools ?? []).map((tool) => tool.name),
    maxTokens: options.maxTokens,
  }
}

/** Concatenate the text blocks of a message's content. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (block === null || typeof block !== 'object') return ''
      const record = block as Record<string, unknown>
      return record['type'] === 'text' && typeof record['text'] === 'string' ? record['text'] : ''
    })
    .join('')
}

/** Build the transport error a real adapter would raise. */
function transportError(kind: 'rate-limit' | 'transport'): Error {
  const error = new Error(
    kind === 'rate-limit'
      ? 'fake adapter: provider rate limit exceeded'
      : 'fake adapter: transport failure',
  )
  error.name = kind === 'rate-limit' ? 'LlmError' : 'TransportError'
  return error
}

/** Sleep, honoring an abort signal. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
