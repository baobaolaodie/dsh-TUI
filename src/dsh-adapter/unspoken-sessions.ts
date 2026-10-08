/**
 * The unspoken-session sweep: delete the shells no person ever spoke to.
 *
 * A TUI session is created before it is bound to an agent, so booting the app
 * (or switching workspaces, or opening the agent view) leaves a persisted
 * session behind that nothing ever said a word in. Those shells show up in
 * `dsh web`'s sidebar and pile up on disk. This module decides which of them
 * may be removed and removes them — once, on the way out.
 *
 * The decision is three conservative layers, and **any** layer that does not
 * pass spares the session (DESIGN D5 / ADR-0012 decision 1):
 *
 *  1. INDEX — the TUI's own `derived.hasPrompt === false`
 *     (`sessions/store.ts:61-89`, written from `sessions/digest.ts:152-209`).
 *     It is monotone and treats every unknown as "prompted", so `false`
 *     implies the whole human turn surface was empty when it was derived.
 *     A missing entry or a missing `derived` record is NOT a candidate.
 *  2. LOG — a bounded re-read of the artifact must find neither a
 *     `turn/start` nor a human `user/message`. The human rule is
 *     `digest.ts:66-98`'s (`source` absent/null or `{kind:'user'}` is human;
 *     `agent/inbox/spliced` entries with `role: 'user'` count too). An
 *     absent, dangling, corrupt or budget-truncated log proves nothing and
 *     spares the session. The reader drops seq-less header rows and rows
 *     marked `ignorable` (`compat/sessionLog.ts:821`); neither can hide human
 *     evidence here — `ignorable` is set only on unrecognised, purely
 *     informational records (`dsh-session/lib/types/types.d.ts:503-507`), and
 *     every conversational event type is a known one.
 *  3. PROCESS — the session this process is bound to, a live background
 *     session, and any delegated run or descendant of one are spared. The
 *     shipping delete primitive has no `kind`/`parentSession` check
 *     (`compat/sessionLog.ts:1280-1304`; see ADR-0012's note that only the UI
 *     filters sub-agents), so this layer is ours to add.
 *
 * The action is the existing primitive plus the same per-session note cleanup
 * the picker's delete uses (`channel/session-metadata.ts:233-242`):
 * `deleteSessionLog` → `forgetSession` → `forgetAgentViewSession` → drop the
 * resume target when it names this session. The index is deliberately NOT
 * rewritten — `sessions/store.ts:253-259` documents that absence of a forget
 * path, and `sessions/list.ts:364-368` converges it on the next listing.
 * Projection caches and the workspace ledger are not session-scoped and are
 * never touched.
 *
 * The round is bounded, synchronous and fail-soft: at most
 * {@link DEFAULT_MAX_CANDIDATES} candidates and {@link DEFAULT_MAX_EVENTS_PER_LOG}
 * events per log are examined, a single failure is reported and skipped, and
 * nothing here throws, retries, or spawns a process — an exit path must never
 * be blocked by its own cleanup. Synchronous on purpose: an exit funnel can
 * call it inline without leaving pending I/O or an unawaited promise behind.
 *
 * @module @deepseek-harness-tui/dsh-tui/dsh-adapter/unspoken-sessions
 */
import { clearResumeTarget, forgetAgentViewSession, forgetSession, readResumeTarget } from '../sessionHistory.js'
import { deleteSessionLog, readSessionEventsFromLog } from './compat/sessionLog.js'
import { readIndex as readSessionIndex } from './sessions/store.js'

/** Candidates examined per round. Past it a shell is spared, not deleted. */
const DEFAULT_MAX_CANDIDATES = 512
/**
 * Events collected per log. A shell holds a handful; a conversation reaches
 * its `turn/start` within the first few. Anything longer than this cannot be
 * *proven* empty, so it is spared (`log-incomplete`).
 */
const DEFAULT_MAX_EVENTS_PER_LOG = 1024

/**
 * One index entry, as much of it as layer ① reads. `SessionIndex` satisfies
 * this structurally.
 */
export interface UnspokenIndexEntry {
  readonly derived?: { readonly hasPrompt: boolean } | undefined
}

/**
 * A bounded log read, as much of it as layer ② reads. `SessionLogRead`
 * (`compat/sessionLog.ts:766-783`) satisfies this structurally.
 */
export interface UnspokenLogRead {
  readonly events: readonly unknown[]
  /** False when the read stopped at a budget: absence is unproven. */
  readonly complete: boolean
  /** True when an existing log could not be decoded at all. */
  readonly failed?: boolean
}

/** Why a session was spared. Every value means "keep it". */
export type UnspokenSkipReason =
  /** ① The index says a human prompted here, or cannot say otherwise. */
  | 'index-has-prompt'
  /** ① The entry carries no derived record. */
  | 'index-unknown'
  /** Bound: this round's candidate budget was already spent. */
  | 'candidate-cap'
  /** ② No artifact was found for the entry (missing or dangling). */
  | 'log-absent'
  /** ② The artifact exists but could not be decoded. */
  | 'log-unreadable'
  /** ② The read hit its event budget, so emptiness is unproven. */
  | 'log-incomplete'
  /** ② The log carries a `turn/start`. */
  | 'turn-start'
  /** ② The log carries a human message. */
  | 'human-message'
  /** ③ This process is bound to the session right now. */
  | 'current-session'
  /** ③ This process holds the session as a live background run. */
  | 'live-session'
  /** ③ The session is a delegated run or descends from one. */
  | 'subagent'
  /** Sweep only: the delete primitive declined (absent or uncontained). */
  | 'delete-unavailable'
  /** A dependency threw; the session is spared rather than guessed at. */
  | 'unexpected-error'

/** One spared session and the layer that spared it. */
export interface UnspokenSkip {
  readonly id: string
  readonly reason: UnspokenSkipReason
}

export interface UnspokenCollection {
  /** Index entries that passed all three layers — deletion candidates. */
  readonly ids: readonly string[]
  /**
   * Every index entry that was not collected, with its reason. `ids` and
   * `skipped` partition the index, so nothing is silently dropped.
   */
  readonly skipped: readonly UnspokenSkip[]
}

export interface UnspokenSweepResult {
  /** Sessions whose log directory was actually removed, in index order. */
  readonly deleted: readonly string[]
  /** Everything spared, including deletes the primitive refused. */
  readonly skipped: readonly UnspokenSkip[]
}

/**
 * What the sweep cannot know from inside this module. The first three read
 * the local store and have real defaults; the process-layer facts are
 * required, because a missing one would silently widen the delete set.
 */
export interface UnspokenSweepDeps {
  /** ① Index snapshot. Defaults to the TUI session index. */
  readonly readIndex?: () => ReadonlyMap<string, UnspokenIndexEntry>
  /** ② Bounded log read. Defaults to the shipping bounded reader. */
  readonly readLog?: (sessionId: string, maxEvents: number) => UnspokenLogRead | undefined
  /** ③ The session this process is bound to, if any. */
  readonly currentSessionId: () => string | undefined
  /** ③ Sessions this process still holds (live background runs). */
  readonly liveSessionIds: () => ReadonlySet<string>
  /** ③ Whether a session is a delegated run or a descendant of one. */
  readonly isSubagentOrDescendant: (sessionId: string) => boolean
  /** Remove one session's log directory. Defaults to `deleteSessionLog`. */
  readonly deleteLog?: (sessionId: string) => 'deleted' | 'unavailable'
  /** Forget a deleted session's notes. Defaults to the picker's own trio. */
  readonly forgetState?: (sessionId: string) => void
  /** Candidate budget for one round. */
  readonly maxCandidates?: number
  /** Event budget for one log read. */
  readonly maxEventsPerLog?: number
}

/**
 * The three decision rules as pure functions. `undefined` means the layer
 * passed. Injectable so the regression can drive this exact pipeline with
 * reversed rules and prove the assertions have discriminating power
 * (AC-7 ③, LESSONS L-044).
 */
export interface UnspokenJudges {
  readonly index: (entry: UnspokenIndexEntry | undefined) => UnspokenSkipReason | undefined
  readonly log: (read: UnspokenLogRead | undefined) => UnspokenSkipReason | undefined
  readonly held: (sessionId: string) => UnspokenSkipReason | undefined
}

/**
 * The line a listed session descends from, for {@link delegatedSessionIds}.
 */
export interface UnspokenSessionLineage {
  readonly id: string
  /** True for a delegated run: `SessionKind.kind === 'subagent'`
   *  (`sessions/header.ts:102-113`) or a header with `origin: 'subagent'`. */
  readonly delegated?: boolean
  /** Its parent session, when the header records one (fork or delegated). */
  readonly parent?: string | undefined
}

/**
 * Ids that are delegated runs or descend from one, by walking the parent
 * links of one listing. A `/rewind` fork of a sub-agent is a descendant even
 * though it is a real conversation, and ADR-0012 excludes it either way.
 * @param sessions - One entry per listed session.
 * @returns Every id that layer ③ must spare.
 */
export function delegatedSessionIds(sessions: Iterable<UnspokenSessionLineage>): ReadonlySet<string> {
  const parentOf = new Map<string, string>()
  const delegated = new Set<string>()
  for (const session of sessions) {
    if (session.delegated === true) delegated.add(session.id)
    if (session.parent !== undefined && session.parent.length > 0) parentOf.set(session.id, session.parent)
  }
  // Closure over the links; each pass adds at least one id or stops, so this
  // terminates in at most one pass per session.
  for (let grew = true; grew;) {
    grew = false
    for (const [id, parent] of parentOf) {
      if (delegated.has(id) || !delegated.has(parent)) continue
      delegated.add(id)
      grew = true
    }
  }
  return delegated
}

/** The shipping rules, bound to the injected process-layer facts. */
export function unspokenJudges(deps: UnspokenSweepDeps): UnspokenJudges {
  let binding: { readonly current: string | undefined, readonly live: ReadonlySet<string> } | undefined
  return {
    index: entry =>
      entry?.derived === undefined ? 'index-unknown' : entry.derived.hasPrompt ? 'index-has-prompt' : undefined,
    log: read => {
      if (read === undefined) return 'log-absent'
      if (read.failed === true) return 'log-unreadable'
      if (!read.complete) return 'log-incomplete'
      for (const event of read.events) {
        const evidence = conversationEvidence(event)
        if (evidence !== undefined) return evidence
      }
      return undefined
    },
    held: sessionId => {
      binding ??= { current: deps.currentSessionId(), live: deps.liveSessionIds() }
      if (sessionId === binding.current) return 'current-session'
      if (binding.live.has(sessionId)) return 'live-session'
      return deps.isSubagentOrDescendant(sessionId) ? 'subagent' : undefined
    },
  }
}

/**
 * What one collected event proves about whether a person ever spoke here.
 * Mirrors `digest.ts:66-98`; the one deliberate widening is that a payload
 * this code cannot read counts as human evidence, because "the log does not
 * say" must never become "the log says no" on an irreversible action.
 */
function conversationEvidence(event: unknown): 'turn-start' | 'human-message' | undefined {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return undefined
  const envelope = event as Record<string, unknown>
  const type = envelope['type']
  if (type === 'turn/start') return 'turn-start'
  if (type !== 'user/message' && type !== 'agent/inbox/spliced') return undefined
  const data = envelope['data']
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return 'human-message'
  const record = data as Record<string, unknown>
  if (type === 'user/message') return isHumanSource(record['source']) ? 'human-message' : undefined
  const inserted = record['inserted']
  if (!Array.isArray(inserted)) return 'human-message'
  for (const message of inserted) {
    if (message === null || typeof message !== 'object') continue
    const entry = message as Record<string, unknown>
    if (entry['role'] === 'user' && isHumanSource(entry['source'])) return 'human-message'
  }
  return undefined
}

/**
 * Whether a message's `source` marks it as typed by the person at the
 * keyboard — `digest.ts:66-70`, verbatim: plugin injections, instruction
 * snapshots, skill catalogues and sub-agent reports all arrive as user-role
 * messages too, and counting them would spare every shell there is.
 */
function isHumanSource(source: unknown): boolean {
  if (source === undefined || source === null) return true
  if (typeof source !== 'object') return false
  return (source as Record<string, unknown>)['kind'] === 'user'
}

/**
 * Decide which indexed sessions are unspoken shells. Read-only: the same
 * fixtures can be judged more than once (and by reversed judges).
 *
 * @param deps - The store seams and the process-layer facts.
 * @param judges - The decision rules. Overridden only to prove their
 *   discriminating power; production always uses {@link unspokenJudges}.
 * @returns The candidates and the full spared partition of the index.
 */
export function collectUnspokenSessionIds(
  deps: UnspokenSweepDeps,
  judges: UnspokenJudges = unspokenJudges(deps),
): UnspokenCollection {
  const ids: string[] = []
  const skipped: UnspokenSkip[] = []
  const readIdx: () => ReadonlyMap<string, UnspokenIndexEntry> = deps.readIndex ?? readSessionIndex
  const readLog: (sessionId: string, maxEvents: number) => UnspokenLogRead | undefined = deps.readLog ?? readSessionEventsFromLog
  const maxCandidates = deps.maxCandidates ?? DEFAULT_MAX_CANDIDATES
  const maxEventsPerLog = deps.maxEventsPerLog ?? DEFAULT_MAX_EVENTS_PER_LOG
  let index: ReadonlyMap<string, UnspokenIndexEntry>
  try {
    index = readIdx()
  } catch {
    // An unreadable index is not an empty index: spare everything.
    return { ids, skipped }
  }
  // A stable order, so a bounded round always makes the same choice.
  const entries = [...index.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  let examined = 0
  for (const [id, entry] of entries) {
    try {
      const indexed = judges.index(entry)
      if (indexed !== undefined) {
        skipped.push({ id, reason: indexed })
        continue
      }
      if (examined >= maxCandidates) {
        skipped.push({ id, reason: 'candidate-cap' })
        continue
      }
      examined += 1
      const logged = judges.log(readLog(id, maxEventsPerLog))
      if (logged !== undefined) {
        skipped.push({ id, reason: logged })
        continue
      }
      const held = judges.held(id)
      if (held !== undefined) {
        skipped.push({ id, reason: held })
        continue
      }
      ids.push(id)
    } catch {
      // One broken dependency costs one candidate, never the round.
      skipped.push({ id, reason: 'unexpected-error' })
    }
  }
  return { ids, skipped }
}

/**
 * Collect, then delete. Never throws; a refused or throwing delete is
 * reported as `delete-unavailable` and leaves the artifact in place.
 *
 * @param deps - See {@link collectUnspokenSessionIds}.
 * @param judges - See {@link collectUnspokenSessionIds}.
 * @returns The deleted ids and the full spared partition.
 */
export function sweepUnspokenSessions(
  deps: UnspokenSweepDeps,
  judges: UnspokenJudges = unspokenJudges(deps),
): UnspokenSweepResult {
  const collected = collectUnspokenSessionIds(deps, judges)
  const deleted: string[] = []
  const skipped: UnspokenSkip[] = [...collected.skipped]
  const removeLog: (sessionId: string) => 'deleted' | 'unavailable' = deps.deleteLog ?? deleteSessionLog
  const forgetState = deps.forgetState ?? defaultForgetState
  for (const id of collected.ids) {
    let outcome: 'deleted' | 'unavailable'
    try {
      outcome = removeLog(id)
    } catch {
      outcome = 'unavailable'
    }
    if (outcome !== 'deleted') {
      skipped.push({ id, reason: 'delete-unavailable' })
      continue
    }
    deleted.push(id)
    try {
      forgetState(id)
    } catch {
      // The notes are a cache; the log this session was is already gone.
    }
  }
  return { deleted, skipped }
}

/**
 * The per-session notes the picker's delete also drops
 * (`channel/session-metadata.ts:233-242`). Best effort by construction —
 * every callee swallows its own failures.
 */
function defaultForgetState(sessionId: string): void {
  forgetSession(sessionId)
  forgetAgentViewSession(sessionId)
  if (readResumeTarget() === sessionId) clearResumeTarget()
}
