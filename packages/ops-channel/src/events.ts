// == ARGUS AGENT PROJECT ==
/**
 * Cordis event declarations owned by `ops-channel`.
 *
 * @module @argus-agent/channel/events
 */
import type { ChannelAddress, ContentBlockLike, Owner } from '@argus-agent/types'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Free text that belongs to no project, offered to the orchestrator.
     *
     * `ops-orchestrator` listens. When nothing listens and no orchestrator service
     * is mounted, `ops-channel` replies with instructions instead of sending this.
     *
     * @param payload.address where a reply goes.
     * @param payload.userId who sent it.
     * @param payload.text the text, VERBATIM.
     * @param payload.attachments absolute paths of saved attachments.
     * @mode emit
     */
    'ops/orchestrator-input'(payload: {
      /**
       * The inbound request id, which is the `messageRef` the orchestrator's
       * forwarding tools take.
       *
       * It is here because verbatim forwarding is the whole contract: the
       * orchestrator routes by reference, so the thing it needs is the reference,
       * not a copy of the text that could drift from it.
       */
      readonly messageRef: string
      readonly address: ChannelAddress
      readonly userId: string
      readonly text: string
      readonly attachments: readonly string[]
    }): void

    /**
     * A message was delivered to a chat.
     *
     * Emitted after the adapter accepted it, so a listener that reads state sees
     * the delivery as done. A delivery with no adapter is not emitted: nothing
     * reached anyone.
     *
     * @param payload.address the destination.
     * @param payload.kind what the message was about.
     * @param payload.runId the run, when the message was about one.
     * @mode emit
     */
    'ops/channel-delivered'(payload: {
      readonly address: ChannelAddress
      readonly kind: 'output' | 'stopped' | 'interrupted' | 'notice'
      readonly runId?: string
    }): void

    /**
     * A message from an unauthorized user was dropped.
     *
     * Carries the identity and never the content: a stranger's text is untrusted,
     * and an event is a broadcast.
     *
     * @param payload.channel the adapter.
     * @param payload.userId the platform user id.
     * @param payload.reason why it was refused.
     * @mode emit
     */
    'ops/channel-refused'(payload: {
      readonly channel: string
      readonly userId: string
      readonly reason: string
    }): void

    /**
     * A run produced output that a chat should receive.
     *
     * Emitted by the channel itself when it forwards a run's output, so a listener
     * can observe the delivery without holding the adapter.
     *
     * @param payload.owner the run's owner.
     * @param payload.runId the run.
     * @param payload.content what was sent.
     * @mode emit
     */
    /**
     * A button press whose value this channel did not consume.
     *
     * After the allowlist check and after the confirmation and command shapes have
     * been handled, a button value belongs to whoever offered it. This event is how
     * that owner learns of the press — a startup report's Retry button, for instance.
     *
     * @param payload.userId the answering user, already checked against the allowlist.
     * @mode emit
     */
    'ops/channel-button'(payload: {
      readonly value: string
      readonly userId: string
      readonly questionId: string
      readonly address: ChannelAddress
    }): void

    'ops/channel-output'(payload: {
      readonly owner: Owner
      readonly runId: string
      readonly content: readonly ContentBlockLike[]
    }): void
  }
}

export {}
