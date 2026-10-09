import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { AgentSession } from '../../agent/session.js'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { t } from '../../i18n.js'
import { createDshSession, dshHandleOf } from '../backend/session.js'
import { liveSessionCreateOptions, liveSessionOffset, sliceLiveSessionSeed, snapshotLiveSessionEvents } from '../compat/index.js'
import { createFreshAgent, isUnstoredFreshSession } from '../fresh-agent.js'
import { dispatchTuiDecision } from '../extension-events.js'
import { normalizeRewindDoneSummary } from './decisions.js'
import { composePreset, runningPresetOf } from '../presets.js'
import { unspokenJudges } from '../unspoken-sessions.js'
import { attachSessionToWorkspace } from '../workspace.js'
import { reserveNewSession } from '../../sessionMounts.js'
import type { DshChannelBinding } from './binding.js'
import type { ChannelOwner } from './owner.js'
import type { ChannelState, ChatRow } from './types.js'

type Binding = DshChannelBinding
type RewindState = Pick<ChannelState, 'working' | 'cwd' | 'provider' | 'model'>

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

async function waitForTurnEnd(
  session: unknown,
  fromSeq: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const last = snapshotLiveSessionEvents(session).at(-1)
    if (last !== undefined && last.type === 'turn/end' && last.seq >= fromSeq) return true
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return false
}

/** Rewind a selected transcript row into a prepared, binding-owned fork. */
export function createRewindToAction(
  ctx: Context,
  state: RewindState,
  deps: {
    owner: Pick<ChannelOwner, 'current'>
    binding: Pick<Binding, 'agent' | 'capture' | 'prepare' | 'isCurrent' | 'abandon'>
    settleCompaction(): Promise<void>
    notify: ChannelState['notify']
    adoptForkedAgent(candidate: AgentSession, capture: ReturnType<Binding['capture']>, seed: readonly SessionEvent[], agentPreset: string | undefined, childId: SessionId): string
    notifySessionSwitched(kind: 'rewind', sessionId: string, previousSessionId: string): void
  },
) {
  return async (row: ChatRow, mode: string | null = null): Promise<string | null> => {
    if (row.seq === undefined) return null
    const adoption = deps.binding.capture()
    const agents = ctx.get('agents') as { create(options: CreateAgentOptions): Promise<AgentHandle> } | undefined
    if (!agents) {
      deps.notify(t('rewind-unavailable'), { color: 'error' })
      return null
    }
    const wasWorking = state.working
    const cancelSeq = liveSessionOffset(deps.binding.agent.session)
    if (wasWorking) deps.binding.agent.cancel({ kind: 'user' })
    if (wasWorking && !await waitForTurnEnd(deps.binding.agent.session, cancelSeq, 30000)) {
      deps.notify(t('rewind-settling'), { color: 'error' })
      return null
    }
    await deps.settleCompaction()
    const childId = SessionId(randomUUID())
    const events = snapshotLiveSessionEvents(deps.binding.agent.session)
    let boundary = row.seq
    for (let i = row.seq; i >= 0; i--) {
      const event = events[i]
      if (event === undefined) break
      if (event.type === 'turn/start') { boundary = event.seq - 1; break }
      if (event.type === 'turn/end') break
    }
    const source = deps.binding.agent.session
    // A source that holds no conversation is not one to continue, whether the
    // shell came from the deferral this process installed (the never-used
    // verdict) or was already on disk when the process started. A seed would
    // copy that shell, and the host stores every seed at publication (agent-loop
    // `appendUnstoredSuffix`), so the child's log would exist before its first
    // real event — the permission-only shell the fresh-session deferral keeps
    // out of JSONL. There is no history to cut, so such a source yields an
    // unseeded child instead; the evidence is read from the live snapshot in
    // hand (in memory, never a second read of the log). Reaching this branch at
    // all still needs a rewind row, and only real content offers one
    // (`Chat.tsx`), so it is the depth behind `/model` and `/fork`.
    let sourceHoldsNoConversation: boolean
    let seed: readonly SessionEvent[]
    try {
      if (boundary < 0) throw new Error('cannot rewind to the very first message')
      sourceHoldsNoConversation = isUnstoredFreshSession(source)
        || CONVERSATION_EVIDENCE.log({ events: snapshotLiveSessionEvents(source), complete: true }) === undefined
      // Slice the SOURCE snapshot through an inclusive seq. Never
      // sessions.fork(): that registers a real child whose snapshot includes
      // child-owned session/end-seed, so snapshot.length is not the inherited
      // cut. agents.create owns the new session id.
      seed = sourceHoldsNoConversation ? [] : sliceLiveSessionSeed(source, boundary)
    } catch (error) {
      deps.notify(t('rewind-fork-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error' })
      return null
    }
    const composed = await composePreset(ctx, runningPresetOf(source))
    // Announce the id before the factory: the rewind creates the child's log
    // here, and the publisher only learns the id from the registry on its next
    // beat.
    const { reservation } = await reserveNewSession(String(childId))
    let candidate: AgentSession
    try {
      const create = (): Promise<AgentHandle> => sourceHoldsNoConversation
        // No seed and no parent: a conversation-less session has no history to
        // cut and nothing for lineage to describe, so the child is an ordinary
        // fresh session and stands as its own root (session-lineage.ts).
        ? createFreshAgent(ctx, agents, {
          sessionId: childId,
          meta: { cwd: state.cwd, ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }) },
          agentOptions: { provider: state.provider, model: state.model },
          setup: composed.setup,
        })
        : agents.create(liveSessionCreateOptions({
          sessionId: childId,
          seed,
          runtimeSession: source,
          inheritedCount: seed.length,
          cwd: state.cwd,
          parentSession: source.id,
          agentPreset: composed.agentPreset,
          agentOptions: { provider: state.provider, model: state.model },
          setup: async (agentCtx, agent) => {
            // The cut keeps pre-turn inbox insertions but drops their claims.
            // Newer hosts replay those inherited splices, so cancel the restored
            // queue durably in the CHILD before publication or preset setup.
            // Clearing only state.pending would hide, not revoke, the old work.
            agent.inbox.clear()
            return composed.setup?.(agentCtx, agent)
          },
        }))
      candidate = await deps.binding.prepare(adoption, async () => createDshSession(ctx, await create()))
    } catch {
      reservation.abandon()
      deps.notify(t('rewind-create-failed'), { color: 'error' })
      return null
    }
    if (!deps.binding.isCurrent(adoption)) { await deps.binding.abandon(candidate); reservation.abandon(); return null }
    try {
      await attachSessionToWorkspace(ctx, state.cwd, childId)
    } catch (error) {
      deps.notify(t('rewind-attach-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'warning', timeoutMs: 8000 })
    }
    if (!deps.owner.current()) { await deps.binding.abandon(candidate); reservation.abandon(); return null }
    // `adoptForkedAgent` is the commit: the child is the session this process
    // now drives, so the reservation hands over to the registry. It THROWS when
    // the adoption transaction revokes the candidate, so it is guarded.
    try {
      const sourceSessionId = deps.adoptForkedAgent(candidate, adoption, snapshotLiveSessionEvents(dshHandleOf(candidate).agent.session), composed.agentPreset, childId)
      reservation.settle()
      try {
        void dispatchTuiDecision(ctx, 'tui/rewind-done', {
          text: row.text,
          mode,
          boundarySeq: boundary,
          sourceSessionId,
          childSessionId: String(childId),
          sessionId: String(childId),
          cwd: state.cwd,
        }, normalizeRewindDoneSummary).then(summary => {
          if (typeof summary === 'string') deps.notify(summary, { timeoutMs: 6000 })
        }).catch((error: unknown) => ctx.logger.warn('dsh-tui: tui/rewind-done dispatch failed: %o', error))
      } catch (error) {
        ctx.logger.warn('dsh-tui: tui/rewind-done dispatch failed: %o', error)
      }
      deps.notifySessionSwitched('rewind', String(childId), sourceSessionId)
      return row.text
    } catch (error) {
      reservation.abandon()
      throw error
    }
  }
}
