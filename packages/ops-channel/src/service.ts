// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/channel/service` — `ctx.opsChannel`.
 *
 * The one place where a message becomes an action and an event becomes a
 * message. Adapters translate; this decides.
 *
 * @module @argus-agent/channel/service
 */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  addressesEqual,
  encodeAddress,
  isInside,
  looksLikeSecret,
  ownerKey,
  type AnswerOrTimeout,
  type ButtonAnswer,
  type Button,
  type ChannelAddress,
  type ContentBlockLike,
  type DoctorFinding,
  type IncomingAttachment,
  type IncomingMessage,
  type MessageRef,
  type OutgoingFile,
  type OutgoingMessage,
  type Owner,
  type ServiceHealth,
} from '@argus-agent/types'
import type { OpsStore } from '@argus-agent/store'
import type { OpsProjects } from '@argus-agent/projects'
import type { OpsMeter } from '@argus-agent/meter'
import type { OpsGovernor } from '@argus-agent/governor'
import type { OpsCommands } from '@argus-agent/commands'
import { AccessPolicy, warningText, type AccessConfig } from './access.js'
import { ChannelRegistry } from './registry.js'
import { decideRoute, unroutableText } from './routing.js'
import {
  formatOutput,
  interruptedText,
  shouldSendProgress,
  panicText,
  rejectedText,
  invalidProjectsText,
  pricesChangedText,
  prefixFor,
  budgetText,
  scheduleSkippedText,
  stalledText,
  stoppedText,
  type OutputSubject,
} from './format.js'
import type { ChannelSection } from './config.js'

/** Options for the service. */
export interface ChannelOptions {
  readonly store: OpsStore
  readonly projects: OpsProjects
  readonly meter: OpsMeter
  readonly governor: OpsGovernor
  readonly commands: OpsCommands
  readonly access: AccessConfig
  readonly channel: ChannelSection
  /** Where a run attains its project's cwd, for attachment inboxes. */
  readonly scratchDir: string
  /** Whether an orchestrator is mounted. */
  readonly hasOrchestrator: () => boolean
  /** Reads the current time; injected so tests control it. */
  readonly now: () => number
  /** Delivers to the orchestrator when one is present. */
  readonly orchestratorInput: (input: OrchestratorInput) => void
  /**
   * Called for every button press that reached the answer path.
   *
   * The service has no context of its own, so the plugin entry uses this to
   * re-emit the press as `ops/channel-button`. It fires AFTER the allowlist check
   * and AFTER the confirmation and command shapes have been handled: what remains
   * is a value the plugin that offered the button owns.
   */
  readonly onButtonAnswer?: (answer: ButtonAnswer) => void
}

/** What the orchestrator receives from a free-text message. */
export interface OrchestratorInput {
  /** The inbound request id, which is the orchestrator's message reference. */
  readonly messageRef: string
  readonly address: ChannelAddress
  readonly userId: string
  readonly text: string
  readonly attachments: readonly string[]
}

/**
 * The channel service.
 *
 * Exposed as `ctx.opsChannel`.
 */
export class OpsChannel {
  readonly registry: ChannelRegistry
  private readonly policy: AccessPolicy
  /** Question ids this service issued, so a press can be recognized as ours. */
  private readonly outstanding = new Set<string>()
  /** Progress state per run, so later updates edit rather than repost. */
  private readonly progress = new Map<
    string,
    { messageRef: MessageRef | undefined; lastSentAt: number; sent: boolean; address: ChannelAddress }
  >()
  /** Where a run's output goes, remembered from its delivery. */
  private readonly replyTo = new Map<string, ChannelAddress>()
  /** Messages already handled, so a redelivered one is not actioned twice. */
  private readonly seen = new Set<string>()

  constructor(private readonly options: ChannelOptions) {
    this.policy = new AccessPolicy(options.access, () => options.commands.addedUsers())
    this.registry = new ChannelRegistry({
      onMessage: (message) => {
        void this.handleIncoming(message)
      },
      onButton: (answer) => {
        void this.handleButton(answer)
      },
    })
  }

  // ── registry ─────────────────────────────────────────────────────────────

  /**
   * Register an adapter.
   * @param adapter the adapter.
   * @returns a disposer that stops it.
   */
  register(adapter: Parameters<ChannelRegistry['register']>[0]): () => Promise<void> {
    return this.registry.register(adapter)
  }

  /**
   * A health report.
   *
   * `degraded` when no adapter is registered — the system is unreachable, which is a
   * deployment fault rather than a crash — or when the allowlist is empty, which
   * means every message is refused.
   *
   * @returns the report.
   */
  /**
   * `argus doctor`: can anyone actually reach the system.
   *
   * @returns the findings.
   */
  doctor(): DoctorFinding[] {
    const adapters = this.adapters().map((adapter) => adapter.name)
    const failure = this.registry.startFailure
    const findings: DoctorFinding[] = [
      adapters.length === 0
        ? { ok: false, check: 'the chat channel', detail: 'no channel is connected', fix: 'set TELEGRAM_BOT_TOKEN (from @BotFather) in .env, or secrets.env on a native install, then restart' }
        : failure !== undefined
          ? { ok: false, check: 'the chat channel', detail: `it failed to start: ${failure}`, fix: 'check TELEGRAM_BOT_TOKEN: the whole token from @BotFather, then restart' }
          : { ok: true, check: 'the chat channel', detail: `connected: ${adapters.join(', ')}` },
    ]
    findings.push(
      this.options.access.admin === undefined
        ? { ok: false, check: 'the admin', detail: 'access.admin is not set, so nobody can run /set, /archive or /allow', fix: 'set access.admin in ops.yaml to your numeric Telegram id (from @userinfobot), then restart' }
        : { ok: true, check: 'the admin', detail: `${this.options.access.admin.channel}:${this.options.access.admin.chatId}` },
    )
    return findings
  }

  health(): ServiceHealth {
    const adapters = this.adapters().map((adapter) => adapter.name)
    const details: Record<string, unknown> = {
      adapters,
      allowedUsers: this.policy.size,
      pendingQuestions: this.pendingQuestions,
    }
    if (adapters.length === 0) {
      return { status: 'degraded', details: { ...details, reason: 'no channel adapter is registered; nothing can be delivered' } }
    }
    if (this.registry.startFailure !== undefined) {
      // An adapter that never started is registered but deaf: messages to the bot
      // go nowhere. Reporting `ok` here is what made a bad bot token invisible.
      return {
        status: 'degraded',
        details: { ...details, reason: `a channel adapter failed to start: ${this.registry.startFailure}` },
      }
    }
    if (this.policy.isEmpty) {
      return { status: 'degraded', details: { ...details, reason: 'access.allowed_users is empty; every message is refused' } }
    }
    return { status: 'ok', details }
  }

  /**
   * Wait until an adapter's `start` has settled.
   *
   * @param name the adapter's name.
   * @returns once it settled.
   */
  async adapterStarted(name: string): Promise<void> {
    await this.registry.started(name)
  }

  /** The registered adapters. */
  adapters(): ReturnType<ChannelRegistry['adapters']> {
    return this.registry.adapters()
  }

  /**
   * The address a message with no reply address goes to.
   *
   * `channel.default_address` when configured; otherwise the first registered
   * adapter's most recent chat, which is what makes a single-chat deployment work
   * with no configuration at all.
   *
   * @returns the address, or `undefined` when nothing can be addressed.
   */
  defaultAddress(): ChannelAddress | undefined {
    return this.configuredDefault ?? this.lastSeen
  }

  /** Set from configuration at load. */
  configuredDefault: ChannelAddress | undefined

  /** The most recent chat anything was seen from. */
  private lastSeen: ChannelAddress | undefined

  // ── access ───────────────────────────────────────────────────────────────

  /** The resolved attachment scratch directory. For diagnostics. */
  get scratchDirectory(): string {
    return this.options.scratchDir
  }

  /** Whether a user may operate the system. */
  isAllowed(channel: string, userId: string): boolean {
    return this.policy.isAllowed(channel, userId)
  }

  /** The access policy, for a health report. */
  get access(): AccessPolicy {
    return this.policy
  }

  // ── incoming ─────────────────────────────────────────────────────────────

  /**
   * Route one incoming message.
   *
   * @param message the message.
   * @returns what the router decided, for the tests.
   */
  async handleIncoming(message: IncomingMessage): Promise<ReturnType<typeof decideRoute>> {
    // A redelivered message is not actioned twice. An adapter that retries after
    // a transient failure must not cause a second submission.
    if (this.seen.has(`${message.address.channel}:${message.id}`)) {
      return { kind: 'rejected', reason: 'duplicate' }
    }
    this.seen.add(`${message.address.channel}:${message.id}`)
    if (this.seen.size > 5_000) this.seen.clear()

    // An adapter that borrows another's identities is not where alerts should go.
    const identity = this.identityOf(message.address.channel)
    if (identity === message.address.channel) this.lastSeen = message.address

    const access = this.policy.check(identity, message.userId)
    if (!access.allowed) {
      await this.refuse(message, access.reason ?? 'not_listed')
      return { kind: 'rejected', reason: access.reason ?? 'not_listed' }
    }

    // A key never reaches a model, and is taken out of the chat. `/key` is the way
    // to send one; anything else that looks like a key is not routed at all.
    const keyCommand = KEY_COMMAND.test(message.text.trim())
    if (keyCommand || looksLikeSecret(message.text)) {
      const deleted = await this.deleteIncoming(message)
      if (!keyCommand) {
        await this.reply(
          message.address,
          `That looked like an API key, so it was not passed to any agent${deleted ? ' and the message was deleted' : ''}. ` +
            `To save a key: /key <provider> <key>.${deleted ? '' : ' Delete the message yourself.'}`,
        )
        return { kind: 'rejected', reason: 'secret' }
      }
      if (!deleted) {
        await this.runCommand(message.text, message)
        await this.reply(message.address, 'Delete your message yourself: it holds the key, and this chat could not delete it.')
        return { kind: 'command' }
      }
    }

    const activeProject = this.activeProjectOf(message.address)
    const route = decideRoute(message.text, {
      access,
      activeProject,
      hasOrchestrator: this.options.hasOrchestrator(),
      hasAttachments: (message.attachments?.length ?? 0) > 0,
    })

    switch (route.kind) {
      case 'command':
        await this.runCommand(route.line ?? message.text, message)
        return route
      case 'project':
        await this.submitToProject(message, route.projectId as string)
        return route
      case 'orchestrator':
        await this.forwardToOrchestrator(message)
        return route
      case 'help':
        await this.reply(message.address, unroutableText())
        return route
      default:
        return route
    }
  }

  /** Delete a message the user sent, when the adapter can; whether it did. */
  private async deleteIncoming(message: IncomingMessage): Promise<boolean> {
    const adapter = this.registry.get(message.address.channel)
    if (adapter?.delete === undefined) return false
    try {
      await adapter.delete({ channel: message.address.channel, chatId: message.address.chatId, messageId: message.id })
      return true
    } catch {
      return false
    }
  }

  /** Log a refusal and warn the admin, rate-limited. */
  private async refuse(message: IncomingMessage, reason: string): Promise<void> {
    // The log carries the identity and never the content: a stranger's text is
    // untrusted, and an operator's log is not the place for it.
    this.options.store.audit.record(
      {
        actor: message.userId,
        action: 'channel.refused',
        target: message.address.channel,
        details: { reason, chatId: message.address.chatId },
      },
      this.options.now(),
    )

    const now = this.options.now()
    if (!this.policy.shouldWarn(now)) return
    const admin = this.policy.admin
    if (admin === undefined) return
    await this.send(admin, {
      text: warningText(message.address.channel, message.userId, reason as 'not_listed', this.policy.suppressed),
    })
  }

  /** Run a command line and deliver its result. */
  private async runCommand(line: string, message: IncomingMessage): Promise<void> {
    const out = await this.options.commands.runCommand(line, {
      address: message.address,
      userId: message.userId,
      isAdmin: this.policy.isAdmin({ ...message.address, channel: this.identityOf(message.address.channel) }, message.userId),
      ...(this.activeProjectOf(message.address) === undefined
        ? {}
        : { activeProject: this.activeProjectOf(message.address) as string }),
      now: this.options.now(),
    })

    const buttons: Button[] | undefined =
      out.confirm === undefined
        ? undefined
        : out.buttons?.map((button) => ({
            // The button's `command` field is already the `/confirm <token> <yes|no>`
            // line the channel round-trips; its value carries that line so a press
            // is handled by the ordinary command path.
            value: button.command,
            label: button.label,
          }))

    // A file on disk larger than the adapter can send is named in the text instead,
    // as a run's produced files are: the operator can still fetch it.
    const maxBytes = this.registry.get(message.address.channel)?.limits.maxFileBytes ?? Number.POSITIVE_INFINITY
    const files: OutgoingFile[] = []
    let text = out.text
    for (const file of out.files ?? []) {
      if (!('path' in file)) files.push({ name: file.name, bytes: new TextEncoder().encode(file.content) })
      else if (file.sizeBytes <= maxBytes) files.push({ name: file.name, path: file.path })
      else text += `\nToo large to send here: ${file.path}`
    }

    await this.send(message.address, {
      text,
      ...(files.length === 0 ? {} : { files }),
      ...(buttons === undefined ? {} : { buttons }),
    })
  }

  /** Submit free text to a project, verbatim. */
  private async submitToProject(message: IncomingMessage, projectId: string): Promise<void> {
    const attachments = await this.saveAttachments(message, projectId)
    const content: ContentBlockLike[] = [
      ...(message.text.trim().length === 0 ? [] : [{ type: 'text' as const, text: message.text }]),
      ...attachments.map((path) => ({
        type: 'text' as const,
        text: `Attached file saved at ${path}`,
      })),
    ]

    let requestId: string
    try {
      const submitted = this.options.governor.submit({
        source: 'channel',
        target: { projectId },
        content,
        priority: 0,
        replyTo: message.address,
      })
      requestId = submitted.requestId
    } catch (error) {
      await this.reply(message.address, `Could not submit: ${(error as Error).message}`)
      return
    }

    this.replyTo.set(requestId, message.address)

    // Acknowledge only when the work did NOT start at once. A run that begins
    // immediately produces its own output a moment later, and "queued" followed
    // by the answer reads as two messages saying the same thing.
    const status = this.options.governor.status()
    const started = status.running.some(
      (run) => run.owner.kind === 'project' && run.owner.projectId === projectId,
    )
    if (!started) {
      await this.reply(message.address, `${prefixFor({ kind: 'project', projectId })}queued for ${projectId}`)
    }
  }

  /** Forward a free-text message to the orchestrator. */
  private async forwardToOrchestrator(message: IncomingMessage): Promise<void> {
    const attachments = await this.saveAttachments(message, undefined)
    this.options.orchestratorInput({
      // The inbound id IS the messageRef: it is what the store looks the original
      // text up by, which is what makes verbatim forwarding structural.
      messageRef: message.id,
      address: message.address,
      userId: message.userId,
      text: message.text,
      attachments,
    })
  }

  /**
   * Save a message's attachments and return their paths.
   *
   * A project's attachments go to `${cwd}/inbox/`, so the agent finds them in its
   * own workspace. With no project they go to the scratch directory, because the
   * orchestrator has no workspace of its own.
   */
  private async saveAttachments(message: IncomingMessage, projectId: string | undefined): Promise<string[]> {
    const attachments = message.attachments ?? []
    if (attachments.length === 0) return []

    const directory =
      projectId === undefined
        ? join(this.options.scratchDir, 'inbox')
        : join(this.projectCwdOf(projectId), 'inbox')
    mkdirSync(directory, { recursive: true })

    const saved: string[] = []
    for (const attachment of attachments) {
      if (attachment.bytes === undefined) {
        // An adapter that did not download the file still names it, so the agent
        // can be told where to look rather than being told nothing.
        saved.push(attachment.fileId ?? attachment.name)
        continue
      }
      const path = join(directory, safeName(attachment.name))
      writeFileSync(path, attachment.bytes)
      saved.push(path)
    }
    return saved
  }

  /** A project's working directory. */
  private projectCwdOf(projectId: string): string {
    const config = this.options.projects.configOf(projectId)
    return config?.cwd ?? join(this.options.scratchDir, projectId)
  }

  // ── buttons and questions ────────────────────────────────────────────────

  /**
   * Handle a button answer.
   *
   * The check happens here, before the answer reaches any promise: the adapter
   * contract says `ask` must not enforce the allowlist, so this is the only place
   * it can happen.
   *
   * @param answer the answer.
   */
  async handleButton(answer: ButtonAnswer): Promise<void> {
    if (!this.policy.isAllowed(this.identityOf(answer.address.channel), answer.userId)) {
      await this.refuse(
        {
          id: answer.questionId,
          address: answer.address,
          userId: answer.userId,
          text: '',
          timestamp: answer.timestamp,
        },
        'not_listed',
      )
      return
    }

    // Recorded BEFORE any await. `handleButton` is asynchronous but an adapter
    // calls it synchronously from its own button callback, so a caller awaiting the
    // question's promise resumes as soon as the adapter resolves it — which can be
    // before this function's later steps run. Recording at the end left
    // `answeredBy()` empty for exactly that caller, which is how an approval audit
    // row lost its `decided_by`.
    if (this.outstanding.has(answer.questionId)) this.lastAnswer = answer

    // A button's value is one of three things, and the channel is what knows the
    // difference — an adapter must not.
    //
    //   1. `__confirm:<token>:<yes|no>`  a confirmation from the command layer
    //   2. `/something …`                a command line
    //   3. anything else                 an answer to a question this service asked
    //
    // A confirmation is translated into the `/confirm` command rather than
    // dispatched directly, so answering one runs through the same registry, audit
    // and allowlist path as anything else.
    const confirmation = /^__confirm:([^:]+):(yes|no)$/.exec(answer.value)
    if (confirmation !== null) {
      await this.handleIncoming({
        id: `confirm-${confirmation[1]}-${answer.timestamp}`,
        address: answer.address,
        userId: answer.userId,
        text: `/confirm ${confirmation[1]} ${confirmation[2]}`,
        timestamp: answer.timestamp,
      })
      return
    }

    if (answer.value.startsWith('/')) {
      await this.handleIncoming({
        id: `button-${answer.questionId}-${answer.timestamp}`,
        address: answer.address,
        userId: answer.userId,
        text: answer.value,
        timestamp: answer.timestamp,
      })
      return
    }

    // A question value is handled by the ADAPTER, which owns the promise. The
    // channel has already done its part: the allowlist check above. An adapter
    // that resolves only through a call to its own API is driven by the caller
    // that pressed the button, which is what the console adapter's `answer()`
    // does and what Telegram does with an inline-keyboard callback.
    if (this.outstanding.has(answer.questionId)) this.lastAnswer = answer

    // Announced as well as resolved, so a plugin that OFFERED the button can act on
    // it. The service has no context of its own, so the plugin entry subscribes to
    // what the service records and re-emits it.
    this.options.onButtonAnswer?.(answer)
  }

  /**
   * Ask a question and wait for an answer.
   *
   * The adapter owns the deadline: it is passed the timeout and resolves
   * `'timeout'` itself. A second timer here would race it and could resolve the
   * same question twice.
   *
   * @param address where to ask.
   * @param question the text.
   * @param buttons the choices.
   * @param timeoutMs how long to wait.
   * @returns the answer, or `'timeout'`.
   * @throws {Error} when no adapter can reach the address.
   */
  async ask(
    address: ChannelAddress,
    question: string,
    buttons: readonly Button[],
    timeoutMs = 60_000,
    /** The id to correlate the answer by, when the caller needs to look up WHO answered. */
    questionId?: string,
  ): Promise<AnswerOrTimeout> {
    const adapter = this.registry.get(address.channel)
    if (adapter === undefined) {
      throw new Error(`no channel adapter named "${address.channel}" is registered`)
    }
    const id = questionId ?? randomUUID()
    // The ADAPTER owns the question and its deadline, so it is the one that
    // resolves. Registering a second promise here would mean two things racing to
    // answer the same question, and the channel's would never be resolved by a
    // press that the adapter handled itself.
    this.outstanding.add(id)
    // A second way in, for `answerQuestion`: another surface (the web dashboard)
    // may answer what this adapter asked. The adapter's own deadline still applies.
    let answeredElsewhere = false
    const elsewhere = new Promise<AnswerOrTimeout>((resolve) =>
      this.answerers.set(id, (answer) => {
        answeredElsewhere = true
        resolve(answer)
      }),
    )
    const asked = { id, text: question, buttons, timeoutMs }
    try {
      const answer = await Promise.race([adapter.ask(address, asked), elsewhere])
      if (answeredElsewhere && answer !== 'timeout' && adapter.closeQuestion !== undefined) {
        // The asking chat still shows live buttons: say who answered, and where.
        const label = buttons.find((button) => button.value === answer.value)?.label ?? answer.value
        const who = this.lastAnswer?.questionId === id ? ` by ${this.lastAnswer.userId} on ${this.lastAnswer.address.channel}` : ''
        // A failed close leaves the old buttons, which change nothing now: not worth more.
        adapter.closeQuestion(asked, `Answered${who}: ${label}`).catch(() => undefined)
      }
      return answer
    } finally {
      this.outstanding.delete(id)
      this.answerers.delete(id)
    }
  }

  /**
   * Answer a pending question from somewhere other than the adapter that asked it.
   *
   * The person must be allowed on the channel they answer from, as for a button.
   * The asking adapter closes its copy when it can (`closeQuestion`); otherwise its
   * buttons stay until its own timeout, and a press there changes nothing.
   *
   * @param questionId the id passed to {@link ask}.
   * @param value the chosen button's value.
   * @param from where the answer comes from, and who gave it.
   * @returns whether a question was waiting for it.
   */
  answerQuestion(questionId: string, value: string, from: { address: ChannelAddress; userId: string }): boolean {
    const resolve = this.answerers.get(questionId)
    if (resolve === undefined) return false
    if (!this.policy.isAllowed(this.identityOf(from.address.channel), from.userId)) return false
    this.lastAnswer = { questionId, value, address: from.address, userId: from.userId, timestamp: this.options.now() }
    resolve({ kind: 'button', value })
    return true
  }

  /** Resolvers for the questions {@link answerQuestion} may answer. */
  private readonly answerers = new Map<string, (answer: AnswerOrTimeout) => void>()

  /** The channel whose identities an adapter's users have. */
  private identityOf(channel: string): string {
    return this.registry.get(channel)?.identityChannel ?? channel
  }

  /** The most recent button answer, for an adapter that resolves on demand. */
  lastAnswer: ButtonAnswer | undefined

  /**
   * Who answered a specific question, from the last recorded answer.
   *
   * Correlated by `questionId`, not by value: two pending questions can both offer
   * an "approve" button, and attributing one project's approval to the person who
   * answered the other would make the audit trail wrong in exactly the case it
   * exists for.
   *
   * @param questionId the question id passed to {@link ask}.
   * @returns the answering user's id, or `undefined`.
   */
  answeredBy(questionId: string): string | undefined {
    return this.lastAnswer?.questionId === questionId ? this.lastAnswer.userId : undefined
  }

  /**
   * Whether the person who answered a question is the admin.
   *
   * @param questionId the question id passed to {@link ask}.
   * @returns whether its last answer came from the admin.
   */
  answeredByAdmin(questionId: string): boolean {
    const answer = this.lastAnswer
    if (answer?.questionId !== questionId) return false
    return this.policy.isAdmin({ ...answer.address, channel: this.identityOf(answer.address.channel) }, answer.userId)
  }

  /** How many questions are outstanding. For diagnostics. */
  get pendingQuestions(): number {
    return this.outstanding.size
  }

  // ── outgoing ─────────────────────────────────────────────────────────────

  /**
   * Send a message to an address.
   *
   * @param address the destination.
   * @param message the message.
   * @returns the handle, or `undefined` when no adapter can reach it.
   */
  async send(address: ChannelAddress, message: OutgoingMessage): Promise<MessageRef | undefined> {
    const adapter = this.registry.get(address.channel)
    if (adapter === undefined) return undefined
    return adapter.send(address, message)
  }

  /**
   * Deliver text to an address, falling back to the default when one is unknown.
   * @param address the destination, when known.
   * @param text the text.
   */
  async reply(address: ChannelAddress | undefined, text: string): Promise<void> {
    const target = address ?? this.defaultAddress()
    if (target === undefined) return
    await this.send(target, { text })
  }

  /**
   * Deliver a run's output.
   *
   * @param runId the run.
   * @param subject what the output is about.
   * @param content the output blocks.
   * @param produced files the run produced.
   */
  async deliverRunOutput(
    runId: string,
    subject: OutputSubject,
    content: readonly ContentBlockLike[],
    produced: readonly { readonly name: string; readonly path: string; readonly sizeBytes?: number }[] = [],
  ): Promise<void> {
    const address = this.addressFor(runId, subject)
    if (address === undefined) return
    const adapter = this.registry.get(address.channel)
    if (adapter === undefined) return

    const formatted = formatOutput(content, subject, adapter.limits, produced)
    await adapter.send(address, {
      text: formatted.text,
      ...(formatted.files.length === 0 ? {} : { files: formatted.files }),
    })
    this.progress.delete(runId)
    this.replyTo.delete(runId)
  }

  /**
   * Where a run's messages go.
   *
   * The address the request came from, when it is known; otherwise the default.
   * That fallback is what makes a scheduled run — which nobody asked for — still
   * reach the operator.
   */
  private addressFor(runId: string, subject: OutputSubject): ChannelAddress | undefined {
    const remembered = this.replyTo.get(runId)
    if (remembered !== undefined) return remembered
    // A run id is the inbound request id, so the stored reply address is the
    // durable record — it survives a restart that the in-memory map does not.
    const stored = this.options.store.inbound.get(runId)?.reply_chat
    if (stored !== null && stored !== undefined) {
      const address = decodeAddressSafe(stored)
      if (address !== undefined) return address
    }
    void subject
    return this.defaultAddress()
  }

  /**
   * Send files from an agent's own folder to the chat its run answers.
   *
   * The `send_file` tool's body. The owner comes from the calling agent, never from
   * an argument, and every path must stay inside that owner's folder. One file goes
   * as it is; several, or a folder, go as one zip made here. The answer is for the
   * model: what was sent, or why not.
   *
   * @param owner the calling agent's owner.
   * @param paths the files or folders, relative to the owner's folder.
   * @param caption optional text sent with it.
   * @returns what happened, for the model.
   */
  async sendFile(owner: Owner, paths: string | readonly string[], caption?: string, archiveName?: string): Promise<string> {
    if (owner.kind === 'orchestrator') return 'send_file is for projects and tasks; the front desk has no folder.'
    const root = owner.kind === 'project' ? this.options.projects.configOf(owner.projectId)?.cwd : this.options.projects.taskDirOf(owner.runId)
    if (root === undefined) return 'This agent has no folder to send from.'
    const list = (typeof paths === 'string' ? [paths] : [...paths]).map((path) => path.trim()).filter((path) => path.length > 0)
    if (list.length === 0) return 'paths is required: one or more files or folders, relative to your folder.'
    let folder = false
    for (const path of list) {
      if (!isInside(root, path)) return `${path} is outside your folder; only files inside ${root} can be sent.`
      try {
        folder ||= statSync(resolve(root, path)).isDirectory()
      } catch {
        return `${path} does not exist.`
      }
    }

    const run = this.options.store.runs.active().find((row) => row.owner_key === ownerKey(owner))
    const stored = run?.reply_chat
    const address = (stored === null || stored === undefined ? undefined : decodeAddressSafe(stored)) ?? this.defaultAddress()
    if (address === undefined) return 'There is no chat to send to.'
    const adapter = this.registry.get(address.channel)
    if (adapter === undefined) return `The ${address.channel} channel is not connected.`
    const subject: OutputSubject = owner.kind === 'project' ? { kind: 'project', projectId: owner.projectId } : { kind: 'adhoc' }

    const send = async (full: string): Promise<string> => {
      const name = basename(full)
      const size = statSync(full).size
      if (size > adapter.limits.maxFileBytes) {
        return `${name} is ${megabytes(size)}; ${address.channel} sends at most ${megabytes(adapter.limits.maxFileBytes)}. Send fewer files, or split it.`
      }
      await adapter.send(address, { text: `${prefixFor(subject)}${caption?.trim() || name}`, files: [{ name, path: full }] })
      return `Sent ${name} (${megabytes(size)}).`
    }
    if (list.length === 1 && !folder) return send(resolve(root, list[0]!))

    // Several files, or a folder: one zip, made here so the agent never builds an
    // archive by hand. `-y` keeps a symlink a link, so nothing outside the folder
    // is read through one.
    // A name the agent chose, kept to safe characters: it becomes a file name here.
    const chosen = (archiveName ?? '').replace(/\.zip$/i, '').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80)
    const base = chosen || (list.length === 1 ? basename(resolve(root, list[0]!)) : basename(resolve(root)))
    const temp = mkdtempSync(join(tmpdir(), 'argus-send-'))
    const archive = join(temp, `${base || 'files'}.zip`)
    try {
      const members = list.map((path) => `./${relative(resolve(root), resolve(root, path)) || '.'}`)
      await execFileAsync('zip', ['-r', '-q', '-y', archive, ...members], { cwd: root })
      return await send(archive)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'The zip command is not installed on this machine, so several files cannot be sent at once.'
      return `Could not make the archive: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }

  /** Remember where a run's output should go. */
  rememberReplyTo(runId: string, address: ChannelAddress): void {
    this.replyTo.set(runId, address)
  }

  /**
   * Update a run's progress message, throttled.
   *
   * @param runId the run.
   * @param subject what it is about.
   * @param text the progress text.
   */
  async reportProgress(runId: string, subject: OutputSubject, text: string): Promise<void> {
    if (!this.options.channel.progress_enabled) return
    const address = this.addressFor(runId, subject)
    if (address === undefined) return
    const adapter = this.registry.get(address.channel)
    if (adapter === undefined) return

    const existing = this.progress.get(runId)
    const now = this.options.now()
    const intervalMs = this.options.channel.progress_interval_s * 1_000

    // The throttle decision is the shared pure helper, so the rule has one
    // implementation and its own tests.
    if (
      existing !== undefined &&
      !shouldSendProgress(
        { messageId: existing.messageRef?.messageId, lastSentAt: existing.lastSentAt, sent: existing.sent },
        now,
        intervalMs,
      )
    ) {
      return
    }

    if (existing?.messageRef === undefined) {
      const ref = await adapter.send(address, { text })
      this.progress.set(runId, { messageRef: ref, lastSentAt: now, sent: true, address })
      return
    }
    await adapter.edit(existing.messageRef, { text })
    existing.lastSentAt = now
  }

  /** Forget a run's progress state. */
  forgetProgress(runId: string): void {
    this.progress.delete(runId)
  }

  /** How many runs have a progress message. For diagnostics. */
  get progressCount(): number {
    return this.progress.size
  }

  // ── deliveries for events ────────────────────────────────────────────────

  /** Deliver a stop notice. */
  async deliverStopped(runId: string, subject: OutputSubject, reason: string, detail: string): Promise<void> {
    await this.reply(this.addressFor(runId, subject), stoppedText(subject, reason, detail))
  }

  /** Deliver an interruption notice. */
  async deliverInterrupted(runId: string, subject: OutputSubject): Promise<void> {
    await this.reply(this.addressFor(runId, subject), interruptedText(subject, runId))
  }

  /** Deliver a budget threshold notice. */
  async deliverThreshold(
    scope: string,
    level: string,
    pct: number,
    spentMicros: number,
    limitMicros: number,
  ): Promise<void> {
    await this.reply(this.defaultAddress(), budgetText(scope, level, pct, spentMicros, limitMicros))
  }

  /** Deliver a stalled-queue notice. */
  async deliverStalled(
    requestId: string,
    projectId: string | null,
    waitedMs: number,
    reason: string | undefined,
  ): Promise<void> {
    await this.reply(this.defaultAddress(), stalledText(requestId, projectId, waitedMs, reason))
  }

  /** Tell the chat that sent a request why it was refused. */
  async deliverRejected(replyTo: ChannelAddress | undefined, code: string, message: string): Promise<void> {
    await this.reply(replyTo ?? this.defaultAddress(), rejectedText(code, message))
  }

  /** Tell the operator a price refresh moved the price of models in use. */
  async deliverPricesChanged(changes: Parameters<typeof pricesChangedText>[0]): Promise<void> {
    await this.reply(this.defaultAddress(), pricesChangedText(changes))
  }

  /** Tell the operator which project files are invalid, or valid again. */
  async deliverInvalidProjects(
    invalid: readonly { readonly id: string; readonly path: string; readonly reason: string }[],
    fixed: readonly string[],
  ): Promise<void> {
    await this.reply(this.defaultAddress(), invalidProjectsText(invalid, fixed))
  }

  /** Deliver a panic notice. */
  async deliverPanic(cancelled: number, tookMs: number): Promise<void> {
    await this.reply(this.defaultAddress(), panicText(cancelled, tookMs))
  }

  /** Deliver a schedule-skipped notice. */
  async deliverScheduleSkipped(name: string, reason: string, nextRunAt?: number): Promise<void> {
    await this.reply(this.defaultAddress(), scheduleSkippedText(name, reason, nextRunAt))
  }

  // ── chat context ─────────────────────────────────────────────────────────

  /** The active project for a chat. */
  activeProjectOf(address: ChannelAddress): string | undefined {
    return this.options.store.chatContext.get(address.channel, address.chatId)?.active_project_id ?? undefined
  }

  /** Stop every adapter and clear the in-memory state. */
  async dispose(): Promise<void> {
    this.outstanding.clear()
    this.progress.clear()
    this.replyTo.clear()
    await this.registry.disposeAll()
  }

  /** Whether two addresses are the same chat. */
  static sameAddress(a: ChannelAddress, b: ChannelAddress): boolean {
    return addressesEqual(a, b)
  }
}

/** Decode a stored address, tolerating a malformed one. */
function decodeAddressSafe(value: string): ChannelAddress | undefined {
  try {
    const parsed = JSON.parse(value) as ChannelAddress
    if (typeof parsed.channel !== 'string' || typeof parsed.chatId !== 'string') return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Make an attachment's name safe to write.
 *
 * A platform-provided name is attacker-controlled: `../../etc/passwd` would
 * escape the inbox. Only the basename is kept, and anything that could traverse
 * is replaced.
 */
function safeName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? 'attachment'
  const cleaned = base.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '')
  return cleaned.length === 0 ? 'attachment' : cleaned
}

export { safeName, encodeAddress }
export type { IncomingAttachment, OutgoingMessage }

const execFileAsync = promisify(execFile)

/** `/key <provider> <key>`: the form that carries a key (not `/key remove <provider>`). */
const KEY_COMMAND = /^\/key(@\S+)?\s+(?!remove\s)\S+\s+\S+/i

/** A size in megabytes, for a message. */
function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}
