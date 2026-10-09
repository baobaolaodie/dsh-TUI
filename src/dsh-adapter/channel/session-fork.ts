import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { t } from '../../i18n.js'
import { WORKING_GATE_NOTICES } from '../../commands.js'
import { resolveDshProfileName } from '../../update.js'
import { appendSessionTitle, liveSessionCreateOptions, sliceLiveSessionSeed } from '../compat/index.js'
import { createFreshAgent, isUnstoredFreshSession } from '../fresh-agent.js'
import { composePreset, runningPresetOf } from '../presets.js'
import { unspokenJudges } from '../unspoken-sessions.js'
import { attachSessionToWorkspace } from '../workspace.js'
import { reserveMount, type MountReservation } from '../../sessionMounts.js'
import { mountFailureText } from '../../sessions/resumeFailure.js'
import type { ChannelOwner } from './owner.js'
import type { ChannelState } from './types.js'

type ForkState = Pick<ChannelState, 'working' | 'cwd' | 'provider' | 'model' | 'modelDisplay' | 'sessionTitle'>

/**
 * The exit sweep's own "did a person speak here" rule, asked through its
 * exported judges instead of restated here: `unspokenJudges().log` IS
 * `unspoken-sessions.ts`'s `conversationEvidence` (a `turn/start` or a human
 * message). A FOURTH human-speech rule is exactly what the three existing ones
 * must not become (KNOWN-ISSUES B-1). Its three process-layer facts are read
 * lazily by the `held` rule, which is never asked here, so they stay inert
 * rather than fabricated.
 */
const CONVERSATION_EVIDENCE = unspokenJudges({
  currentSessionId: () => undefined,
  liveSessionIds: () => new Set<string>(),
  isSubagentOrDescendant: () => false,
})

/** Create a detached `/fork` copy without adopting it into the foreground. */
export function createForkSessionAction(
  ctx: Context,
  state: ForkState,
  deps: {
    owner: Pick<ChannelOwner, 'current'>
    settleCompaction(): Promise<void>
    notify: ChannelState['notify']
    source(): Session
    createDetachedHandle(create: () => Promise<AgentHandle>): Promise<{ handle: AgentHandle; release(): Promise<void> }>
  },
) {
  return async (): Promise<boolean> => {
    const agents = ctx.get('agents') as
      | { create(options: CreateAgentOptions): Promise<AgentHandle> }
      | undefined
    if (!agents) {
      deps.notify(t('fork-unavailable'), { color: 'error' })
      return false
    }
    if (state.working) {
      deps.notify(t(WORKING_GATE_NOTICES.fork), { color: 'warning' })
      return false
    }
    await deps.settleCompaction()
    const source = deps.source()
    // The cut is what the child inherits, so the cut is what the verdict asks
    // about — never the session it was cut from. A `/fork` cut is the whole
    // source log, but the same verdict serves the actions whose cut can stop
    // short of the conversation (`/rewind`, `/tree`): judging the source there
    // would say "this one holds a conversation" while the prefix on offer holds
    // the initialization alone. A seed would copy that prefix, and the host
    // stores every seed at publication (agent-loop `appendUnstoredSuffix`), so
    // the fork's log would exist before its first real event — the
    // permission-only shell the fresh-session deferral keeps out of JSONL. The
    // evidence is read from the slice already in hand (in memory, never a
    // second read of the log), so a shell left behind by an earlier process
    // counts exactly like a local one; the fresh verdict answers first, so a
    // deferred session is not even sliced. There is nothing to copy anyway: the
    // fork starts unseeded, as an ordinary fresh session.
    let seed: readonly SessionEvent[]
    try {
      // No boundary: the whole (turn-closed) source log. Slice the SOURCE
      // snapshot — sessions.fork() would register a child and append
      // session/end-seed, so snapshot.length is not a lineage cut.
      seed = isUnstoredFreshSession(source) ? [] : sliceLiveSessionSeed(source)
      if (CONVERSATION_EVIDENCE.log({ events: seed, complete: true }) === undefined) seed = []
    } catch (error) {
      deps.notify(t('fork-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error' })
      return false
    }
    const cutHoldsNoConversation = seed.length === 0
    const childId = SessionId(randomUUID())
    const forkComposed = await composePreset(ctx, runningPresetOf(source))
    // Reserve BEFORE the factory, and hold it past `detached.release()`.
    //
    // A forked child is driven by this process for the whole creation and then
    // written to once more AFTER the handle is gone (`appendSessionTitle`
    // below), so "the handle was disposed" is not the moment this process stops
    // touching the log. The reservation covers both, and is given back at the
    // end: a fork is a standalone session the user resumes separately, not one
    // this terminal keeps mounted.
    const reserved = await reserveMount(String(childId))
    if (!reserved.ok && reserved.reason !== 'occupied') deps.notify(mountFailureText(reserved), { color: 'warning', timeoutMs: 8000 })
    const reservation: MountReservation = reserved.ok ? reserved.reservation : { settle: () => {}, abandon: () => {} }
    let detached: { handle: AgentHandle; release(): Promise<void> }
    try {
      detached = await deps.createDetachedHandle(() => cutHoldsNoConversation
        ? createFreshAgent(ctx, agents, {
          sessionId: childId,
          meta: { cwd: state.cwd, ...(forkComposed.agentPreset === undefined ? {} : { agentPreset: forkComposed.agentPreset }) },
          agentOptions: { provider: state.provider, model: state.model },
          setup: forkComposed.setup,
        })
        : agents.create(liveSessionCreateOptions({
          sessionId: childId,
          seed,
          runtimeSession: source,
          inheritedCount: seed.length,
          cwd: state.cwd,
          // NO parentSession: a /fork copy is an independent conversation
          // (kimi-code semantics), not a rewind branch — recording lineage
          // would fold it into the source's family in /resume.
          agentPreset: forkComposed.agentPreset,
          agentOptions: { provider: state.provider, model: state.model },
          setup: forkComposed.setup,
        })))
    } catch {
      reservation.abandon()
      deps.notify(t('fork-create-failed'), { color: 'error' })
      return false
    }
    if (!deps.owner.current()) { await detached.release(); reservation.abandon(); return false }
    try {
      await attachSessionToWorkspace(ctx, state.cwd, childId)
    } catch (error) {
      deps.notify(t('fork-attach-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'warning', timeoutMs: 8000 })
    }
    if (!deps.owner.current()) { await detached.release(); reservation.abandon(); return false }
    try {
      await detached.release()
    } catch (error: unknown) {
      ctx.logger.warn('dsh-tui: forked session dispose failed: %o', error)
    }
    try {
      const sourceTitle = state.sessionTitle.trim()
      // For a source that holds no conversation this is a silent no-op
      // (`appendSessionTitle` reports 'unavailable' for a missing log): the
      // child has no log yet, and a detached fork is released before it can
      // have one.
      appendSessionTitle(String(childId), `Fork: ${sourceTitle === '' ? String(source.id).slice(0, 8) : sourceTitle}`)
    } finally {
      // The offline title write is the last touch; from here the fork is the
      // user's to resume somewhere else.
      reservation.abandon()
    }
    const profile = resolveDshProfileName()
    const boot = profile === undefined ? 'dsh --config cordis.yml' : `dsh --profile ${profile}`
    const command = process.platform === 'win32'
      ? `dsh-tui --resume ${childId}`
      : `DSH_TUI_RESUME_SESSION=${childId} ${boot}`
    // Only a fork that HAS a log may be advertised for resume. The unseeded
    // branch keeps no artifact before its first real event, so the command
    // would name a session that does not exist — the notice says what is
    // missing instead ('fork-done-unstored').
    deps.notify(cutHoldsNoConversation
      ? t('fork-done-unstored', { id: String(childId) })
      : t('fork-done', { id: String(childId), command }), { timeoutMs: 8000 })
    return true
  }
}
