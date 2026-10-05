// == ARGUS AGENT PROJECT ==
/**
 * Message construction.
 *
 * This module exists because of a trap recorded in `docs/developer-docs.md#verified-dsh-facts`
 * (deviation 6): `UserMessage` **requires** `role: 'user'`, and dsh-session's
 * `assertMessageEventShape` enforces it when a stored log is replayed. A
 * `followup` whose message omits `role` writes a perfectly valid-looking log
 * that `ctx.agents.resume()` later rejects as corrupt — the failure surfaces
 * long after the write, in an unrelated part of the system.
 *
 * Every user message in Argus Agent and in its tests must therefore be built through
 * these constructors rather than as an inline object literal.
 *
 * @module @argus-agent/testkit/messages
 */
// The constructors live in `ops-types` so a PRODUCTION plugin can reach them; a
// plugin cannot depend on a test package, and two implementations of a
// role-carrying constructor is exactly the drift the trap warns about.
export { userMessage, userMessageBlocks, type MessageSource } from '@argus-agent/types'

