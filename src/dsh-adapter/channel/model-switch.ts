import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { randomUUID } from 'node:crypto'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentSession } from '../../agent/session.js'
import { t } from '../../i18n.js'
import { WORKING_GATE_NOTICES } from '../../commands.js'
import { writeModelPref } from '../../modelPrefs.js'
import { touchSession } from '../../sessionHistory.js'
import { createDshSession, dshHandleOf } from '../backend/session.js'
import { liveSessionCreateOptions, sliceLiveSessionSeed, snapshotLiveSessionEvents } from '../compat/index.js'
import { createFreshAgent, isUnstoredFreshSession } from '../fresh-agent.js'
import { composePreset, runningPresetOf } from '../presets.js'
import { unspokenJudges } from '../unspoken-sessions.js'
import { reserveNewSession } from '../../sessionMounts.js'
import { attachSessionToWorkspace } from '../workspace.js'
import type { DshChannelBinding } from './binding.js'
import type { ChannelOwner } from './owner.js'
import { resetSessionProjection } from './session-reset.js'
import { childRecordsLineage } from './session-lineage.js'
import type { ChannelState } from './types.js'

type Binding = DshChannelBinding
type SwitchState = Parameters<typeof resetSessionProjection>[0] & Pick<ChannelState,
  'cwd' | 'working' | 'status' | 'agentId' | 'sessionId' | 'agentPreset' | 'provider' | 'model' | 'contextWindow' | 'effortLevels' | 'reasoningEffort' | 'emit'>

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

/** Model-route adoption transaction. It settles compaction before its fork snapshot and owns the post-commit reset. */
export function createModelSwitchAction(
  ctx: Context,
  state: SwitchState,
  deps: {
    owner: Pick<ChannelOwner, 'current'>
    binding: Pick<Binding, 'agent' | 'capture' | 'prepare' | 'isCurrent' | 'abandon' | 'adopt'>
    rowIds: { value: number }
    settleCompaction(): Promise<void>
    resetProjector(): void
    resetSubagents(): void
    resetJobs(): void
    replay(events: readonly SessionEvent[]): void
    settleReplay(): void
    bindAgent(): void
    refreshCommands(): void
    refreshLoadedContext(): Promise<void>
    refreshSkillCommands(): Promise<void>
    clearStagedImages(): void
    dropModelCompletion(): void
    notify: ChannelState['notify']
  },
) {
  return async (provider: string, model: string): Promise<boolean> => {
    const adoption = deps.binding.capture()
    if (state.working) { deps.notify(t(WORKING_GATE_NOTICES.model), { color: 'warning' }); return false }
    const agents = ctx.get('agents') as { create(options: CreateAgentOptions): Promise<AgentHandle> } | undefined
    if (agents === undefined) { deps.notify(t('model-switch-unavailable'), { color: 'error' }); return false }
    const source = deps.binding.agent.session
    // A source that holds no conversation is not one to continue, whether the
    // shell came from the deferral this process installed (the never-used
    // verdict) or was already on disk when the process started. A seed would
    // copy that shell, and the host stores every seed at publication (agent-loop
    // `appendUnstoredSuffix`), so the replacement's log would exist before its
    // first real event — the permission-only shell the fresh-session deferral
    // keeps out of JSONL. The evidence is read from the live snapshot in hand
    // (in memory, never a second read of the log), so a shell left behind by an
    // earlier process counts exactly like a local one; the fresh verdict answers
    // first, so a deferred session is not even snapshotted. The replacement
    // therefore starts unseeded, as an ordinary fresh session, under that same
    // deferral.
    let sourceHoldsNoConversation: boolean
    let seed: readonly SessionEvent[]
    try {
      // A compaction checkpoint may not settle after the model fork snapshot —
      // and the verdict must be read from the settled log, never from before it.
      await deps.settleCompaction()
      sourceHoldsNoConversation = isUnstoredFreshSession(source)
        || CONVERSATION_EVIDENCE.log({ events: snapshotLiveSessionEvents(source), complete: true }) === undefined
      // No boundary = the whole source log (continue the conversation). Slice
      // the SOURCE snapshot: sessions.fork() registers a real child, and its
      // snapshot length is not the inherited cut.
      seed = sourceHoldsNoConversation ? [] : sliceLiveSessionSeed(source)
    } catch (error) { deps.notify(t('model-switch-fork-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error' }); return false }
    const childId = SessionId(randomUUID())
    // Announce the id before the factory: from the moment `agents.create`
    // returns this process holds the only write handle on a log the publisher
    // will not name until its next beat.
    const { reservation } = await reserveNewSession(String(childId))
    const composed = await composePreset(ctx, runningPresetOf(source))
    let candidate: AgentSession
    try {
      const create = (): Promise<AgentHandle> => sourceHoldsNoConversation
        // No seed and no parent either: a conversation-less session has nothing
        // for lineage to describe, and the child stands as its own root
        // (session-lineage.ts).
        ? createFreshAgent(ctx, agents, {
          sessionId: childId,
          meta: { cwd: state.cwd, ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }) },
          agentOptions: { provider, model },
          setup: composed.setup,
        })
        : agents.create(liveSessionCreateOptions({
          sessionId: childId,
          seed,
          runtimeSession: source,
          inheritedCount: seed.length,
          cwd: state.cwd,
          // A session nobody has typed into has no conversation to relate, and
          // lineage would cost its first real prompt the generated title — the
          // child stands as its own root instead (session-lineage.ts).
          parentSession: childRecordsLineage(seed) ? source.id : undefined,
          agentPreset: composed.agentPreset,
          agentOptions: { provider, model },
          setup: composed.setup,
        }))
      candidate = await deps.binding.prepare(adoption, async () => createDshSession(ctx, await create()))
    } catch (error) { reservation.abandon(); deps.notify(t('model-switch-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 }); return false }
    try { await attachSessionToWorkspace(ctx, state.cwd, childId) }
    catch (error) { deps.notify(t('model-switch-attach-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'warning', timeoutMs: 8000 }) }
    if (!deps.binding.isCurrent(adoption) || !deps.owner.current()) { await deps.binding.abandon(candidate); reservation.abandon(); return false }
    const handle = dshHandleOf(candidate)
    let committed = false
    try {
      const result = deps.binding.adopt<boolean>(candidate, adoption, (_previous, disposePrevious) => {
        resetSessionProjection(state, deps.rowIds, deps.resetProjector, deps.resetSubagents, deps.resetJobs)
        state.status = handle.agent.status
        state.agentId = handle.agent.id
        state.sessionId = handle.agent.session.id
        state.agentPreset = composed.agentPreset
        state.provider = provider
        state.model = model
        state.contextWindow = undefined
        state.effortLevels = undefined
        state.reasoningEffort = undefined
        deps.dropModelCompletion()
        deps.replay(seed)
        deps.settleReplay()
        state.working = handle.agent.status === 'running'
        // Reset the input FIFO and pending-decision indicators BEFORE the first
        // emit: a submit from a session-changed subscriber must not chain onto
        // the replaced session's parked promise (main's bind → clear → refresh
        // order).
        deps.clearStagedImages()
        deps.bindAgent()
        deps.refreshCommands()
        void deps.refreshLoadedContext()
        void deps.refreshSkillCommands()
        touchSession(childId)
        state.emit()
        disposePrevious('dispose')
        if (!writeModelPref(provider, model)) deps.notify(t('model-pref-write-failed'), { color: 'warning' })
        return true
      })
      committed = true
      return result
    } finally {
      if (committed) reservation.settle()
      else reservation.abandon()
    }
  }
}
