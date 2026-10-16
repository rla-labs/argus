// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/types/command` — splitting a command line the way the approval gate
 * and the allowlist both read it.
 *
 * @module @argus-agent/types/command
 */

/**
 * Split a command line into argv tokens.
 *
 * Handles quoting the way a shell would — single quotes verbatim, double quotes
 * with backslash escapes — because a rule written against an unquoted form must
 * not match a quoted one and vice versa. It does **not** interpret shell
 * metacharacters: `;`, `&&`, `|` and `$()` are ordinary characters, which is
 * exactly what makes the token comparison safe.
 *
 * Returns `[]` for a malformed line (an unterminated quote), which matches no rule
 * and therefore asks.
 *
 * @param line the command line.
 * @returns the tokens.
 */
export function tokenizeCommand(line: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | undefined

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string

    if (quote === "'") {
      if (char === "'") quote = undefined
      else current += char
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = undefined
      else if (char === '\\' && index + 1 < line.length) {
        index += 1
        current += line[index] as string
      } else current += char
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (char === '\\' && index + 1 < line.length) {
      index += 1
      current += line[index] as string
      started = true
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      // An unquoted line break ends a command, as `;` does: `a\nb` is two commands.
      if (char === '\n' && tokens.at(-1) !== ';') tokens.push(';')
      continue
    }
    current += char
    started = true
  }

  if (quote !== undefined) return [] // an unterminated quote: unusable, so it asks
  if (started) tokens.push(current)
  return tokens
}
