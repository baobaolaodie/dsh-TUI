/**
 * `@` file-mention parsing (issue #15).
 *
 * A mention is an `@` that starts a whitespace-delimited token (string start
 * or after whitespace) — `hello@world` never triggers. The token body is
 * either a run of non-whitespace characters (`@src/a.ts`) or a double-quoted
 * path (`@"my dir/a.ts"`, for paths containing spaces). A token may carry a
 * trailing line-range suffix — `@src/a.ts#L12-14` or the official no-L
 * `#12-14` (issue #359) — exposed as 1-based `startLine`/`endLine`.
 */

export interface MentionToken {
  /** Start index of the `@` in the source text. */
  start: number
  /** End index (exclusive) of the whole token, quote included. */
  end: number
  /** The referenced path as typed (unquoted, no leading `@`). */
  path: string
  /** First line of a trailing `#L` range (1-based); set only when present. */
  startLine?: number
  /** Last line of the range (inclusive); only together with `startLine`. */
  endLine?: number
}

/** Trailing line-range suffix: `#L12`, `#L12-14` or the official `#12-14`.
 *  Anchored at the token end, so a mid-path `#` (`dir/#L2/x.ts`) never
 *  matches and a reversed range (`#L14-12`) is not a suffix (issue #359). */
const LINE_RANGE = /#(?:L)?(\d+)(?:-(\d+))?$/

/** Same shape anchored as a prefix, for the quoted form where the suffix
 *  rides right after the closing quote (`@"my dir/a.ts"#L3-5`). */
const GLUED_LINE_RANGE = /^#(?:L)?(\d+)(?:-(\d+))?/

/** Scan window for a glued suffix after the closing quote — every real
 *  line range fits far below this; longer runs are ordinary path text. */
const MAX_LINE_SUFFIX = 24

/** True when `ch` delimits a token (whitespace). Path separators and the
 *  quote char are ordinary token characters on every platform — Windows
 *  backslash paths must survive both caret tracking and submission. */
const isBoundary = (ch: string | undefined): boolean =>
  ch === undefined || /\s/.test(ch)

/**
 * Split a trailing `#L` line-range suffix off a mention path:
 * `src/a.ts#L12-14` -> `{ path: 'src/a.ts', startLine: 12, endLine: 14 }`.
 * Lines are 1-based; the official no-L form (`#12-14`) is accepted too.
 * Returns `undefined` when there is no valid suffix — a dangling `#L`, a
 * reversed range, or a `#` that is just part of the path.
 */
export function stripLineRange(
  raw: string,
): { path: string; startLine: number; endLine?: number } | undefined {
  const match = LINE_RANGE.exec(raw)
  if (!match) return undefined
  const startLine = Number(match[1])
  const endLine = match[2] === undefined ? undefined : Number(match[2])
  if (endLine !== undefined && endLine < startLine) return undefined
  return {
    path: raw.slice(0, raw.length - match[0].length),
    startLine,
    ...(endLine === undefined ? {} : { endLine }),
  }
}

/** Extract every `@` mention in `text` (typed order, duplicates kept out). */
export function extractMentions(text: string): MentionToken[] {
  const tokens: MentionToken[] = []
  const seen = new Set<string>()
  // Push unless this exact path was already mentioned (first wins).
  const pushUnique = (token: MentionToken) => {
    if (!seen.has(token.path)) {
      seen.add(token.path)
      tokens.push(token)
    }
  }
  let index = 0
  while (index < text.length) {
    const at = text.indexOf('@', index)
    if (at === -1) break
    index = at + 1
    if (!isBoundary(text[at - 1])) continue // email-style `a@b`, mid-token
    if (text[at + 1] === '"') {
      const close = text.indexOf('"', at + 2)
      if (close === -1) continue // unterminated quote — not a mention
      const end = close + 1
      // A line range may ride right after the closing quote
      // (`@"my dir/a.ts"#L3-5`); it must be followed by a boundary, else it
      // is just more token text (`@"a.ts"#L3-5tail`). An invalid range
      // (reversed `#L14-12`) keeps the original plain-path behavior.
      const suffix = GLUED_LINE_RANGE.exec(text.slice(end, end + MAX_LINE_SUFFIX))?.[0]
      const range =
        suffix !== undefined && isBoundary(text[end + suffix.length])
          ? stripLineRange(text.slice(at + 2, close) + suffix)
          : undefined
      if (range !== undefined && suffix !== undefined) {
        pushUnique({ start: at, end: end + suffix.length, ...range })
        index = end + suffix.length
        continue
      }
      const path = text.slice(at + 2, close)
      if (path) pushUnique({ start: at, end, path })
      index = close + 1
      continue
    }
    let end = at + 1
    while (end < text.length && !isBoundary(text[end])) end++
    const path = text.slice(at + 1, end)
    // A bare `@` or another trigger char (`@@`) carries no path.
    if (path && !path.startsWith('@')) {
      const range = stripLineRange(path)
      pushUnique(range ? { start: at, end, ...range } : { start: at, end, path })
    }
  }
  return tokens
}

/**
 * The mention token the caret is currently editing, if any: an `@` token
 * that starts at or before the caret with the caret inside it. Used by the
 * prompt's completion trigger so `@` works mid-message, not only at the
 * start of the input.
 */
export function mentionAtCaret(
  value: string,
  cursor: number,
): { start: number; end: number; query: string } | undefined {
  // Token start: scan back from the caret to the previous boundary.
  let start = cursor
  while (start > 0 && !isBoundary(value[start - 1])) start--
  if (value[start] !== '@') return undefined
  // Quoted form: the caret must sit before the closing quote.
  if (value[start + 1] === '"') {
    const close = value.indexOf('"', start + 2)
    if (close !== -1 && cursor > close) return undefined
    return { start, end: close === -1 ? value.length : close + 1, query: value.slice(start + 2, cursor) }
  }
  // Token end: first boundary at/after the caret.
  let end = cursor
  while (end < value.length && !isBoundary(value[end])) end++
  return { start, end, query: value.slice(start + 1, cursor) }
}
