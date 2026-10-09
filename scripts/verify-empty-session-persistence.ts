/**
 * Startup and /new must not materialize permission-only DSH sessions.
 * Real AgentLoop, SessionStore and JSONL; scripted model, temporary HOME,
 * no network or credentials. Covers both JSONL encodings, suffix handoff,
 * write failure/retry, disposal, concurrent factories and saved history.
 * Restart/update cases spawn real replacements, parse the real Config and
 * create/resume through the real Agent registry; no installer is invoked.
 *
 * A flush is not a publication either: the host projection cache checkpoints a
 * session from its `session/created` hook and from its own event throttle, and
 * draining on those checkpoints re-materialized exactly the permission-only
 * shell the deferral keeps out of JSONL. The checkpoint still participates, and
 * the first real event still publishes the complete log from seq 0.
 *
 * The other side of the same shell is the SEED. The four channel actions that
 * create a child from a source prefix (`/model`, `/fork`, `/rewind`, `/tree`)
 * copied a source nobody had used, and the host stores a seed at publication
 * (`dsh-agent-loop` `appendUnstoredSuffix` → `writer.append`) — so the copy,
 * not a flush, is what puts the child's log on disk before its first real
 * event. Each of them now asks whether the SOURCE HOLDS NO CONVERSATION: the
 * deferral's own `isUnstoredFreshSession` (`src/dsh-adapter/fresh-agent.ts`)
 * first, then the exit sweep's evidence rule (`src/dsh-adapter/unspoken-sessions.ts`'s
 * `conversationEvidence`, asked through its exported judges, read from the live
 * snapshot the seed is cut from). The second half is what an already-stored
 * shell satisfies and the first cannot see: a shell left by an earlier process,
 * one web created, or one whose `agent-preset/selected` already started the
 * deferral. A conversation-less source starts an unseeded fresh session
 * instead. Both halves are pinned here: the creation shapes below drive the
 * real host, `/fork` is driven end to end from an on-disk shell, and
 * `verifySeededWiring` reads the four actions to prove the verdict is what
 * selects the unseeded branch.
 *
 * Run: node --import tsx/esm scripts/verify-empty-session-persistence.ts
 *
 * Negative controls:
 *   1. In-process (re-runnable): add `--negative-controls`. It replays the
 *      pre-fix `guardedFlush` (start, drain the live snapshot, flush) on the
 *      same creation shape and asserts the shell DOES appear — the pair is what
 *      makes "the create-time checkpoint does not publish the permission-only
 *      shell" a discriminating assertion instead of a vacuous one. It also
 *      replays the pre-fix SEED for the same never-used sources and for an
 *      on-disk shell (asserting that the child DOES appear and that the pre-fix
 *      notice DOES advertise a resume command), and reverses the four wiring
 *      checks three ways — `=> sourceHoldsNoConversation` → `=> false`, the
 *      widened evidence line removed, and the verdict dropped entirely — to
 *      prove those checks can fail (LESSONS L-044 / L-048).
 *   2. Real revert (flush): restore `start(); await drain()` at the head of
 *      `guardedFlush` in src/dsh-adapter/fresh-agent.ts, then
 *      `node --import tsx/esm scripts/verify-empty-session-persistence.ts`
 *      → expect FAIL "the create-time checkpoint does not publish the
 *      permission-only shell" (plus the two narrowed checkpoint cases).
 *   3. Real revert (seed): make one action seed unconditionally — e.g. in
 *      src/dsh-adapter/channel/model-switch.ts replace
 *      `=> sourceHoldsNoConversation` with `=> false` — then the same command →
 *      expect FAIL "channel-model-switch: the never-used verdict selects the
 *      unseeded branch". The creation-shape cases stay green there: they drive
 *      the creation, the wiring check reads the action.
 *   4. Real revert (verdict narrowed): put the widening back to T-FIX-10's
 *      criterion in src/dsh-adapter/channel/session-fork.ts — replace the two
 *      lines `sourceHoldsNoConversation = isUnstoredFreshSession(source)` +
 *      `|| CONVERSATION_EVIDENCE.log({ … }) === undefined` with
 *      `sourceHoldsNoConversation = isUnstoredFreshSession(source)` — then the
 *      same command → expect FAIL "the fork notice for a conversation-less
 *      source is the new-session wording", FAIL "the /fork action took its
 *      unseeded branch for an on-disk shell" and FAIL "a fork of an on-disk
 *      shell publishes no child", plus the `channel-session-fork` wiring FAIL.
 *      The creation-shape cases stay green there too.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { settled, sleep } from './lib/term-test.mjs'

const handoffRole = process.env.DSH_TUI_EMPTY_HANDOFF_ROLE
if (handoffRole === 'driver') {
  const { restartTui } = await import('../src/update.js')
  const kind = process.env.DSH_TUI_EMPTY_HANDOFF_KIND === 'update' ? 'update' : 'restart'
  process.exit(await restartTui(process.env.DSH_TUI_EMPTY_HANDOFF_SESSION ?? '', {
    kind, kernel: 'dsh', env: { DSH_TUI_EMPTY_HANDOFF_ROLE: 'child' },
  }))
}
if (handoffRole === 'child') {
  const [{ Config }, { resumeTargetFromArgv }, { createFreshAgent }] = await Promise.all([
    import('../src/dsh-adapter/index.js'),
    import('../src/sessionHistory.js'),
    import('../src/dsh-adapter/fresh-agent.js'),
  ])
  const config = Config({ sessionId: process.env.DSH_TUI_RESUME_SESSION })
  const target = config.sessionId ?? resumeTargetFromArgv(process.argv.slice(2))
  const expected = process.env.DSH_TUI_EMPTY_HANDOFF_SESSION ?? ''
  const ctx = new Context()
  try {
    for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) await ctx.plugin(plugin)
    await ctx.plugin(JsonlSessionPersistence, { root: process.env.DSH_TUI_EMPTY_HANDOFF_ROOT, compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    const handle = target === undefined
      ? await createFreshAgent(ctx, ctx.agents, { sessionId: SessionId('handoff-fresh'), meta: { cwd: process.env.HOME } })
      : await ctx.agents.resume({ resumeSessionId: SessionId(target) })
    try {
      assert.deepEqual(process.argv.slice(2), JSON.parse(process.env.DSH_TUI_EMPTY_HANDOFF_ARGV!))
      if (expected === '') {
        assert.equal(Object.hasOwn(process.env, 'DSH_TUI_RESUME_SESSION'), false)
        assert.equal(config.sessionId, undefined)
        assert.equal(target, undefined)
        assert.equal(handle.agent.session.id, 'handoff-fresh')
        assert.equal((await ctx.sessionPersistence.list()).some(row => row.header.id === handle.agent.session.id && row.sizeBytes !== undefined), false)
      } else {
        assert.equal(config.sessionId, expected)
        assert.equal(handle.agent.session.id, expected)
        assert.ok(handle.agent.session.snapshotEvents().some(event => event.type === 'user/message'))
      }
    } finally { await handle.dispose() }
  } finally { await ctx.fiber.dispose() }
  console.log('PASS replacement Config and Agent startup')
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-fresh-persistence-'))
process.env.HOME = root
process.env.USERPROFILE = root
process.env.DSH_HOME = join(root, 'home')
process.env.DSH_TUI_LANG = 'en'
const { createFreshAgent, isUnstoredFreshSession } = await import('../src/dsh-adapter/fresh-agent.js')
const { createChannel } = await import('../src/dsh-adapter/channel.js')
const { createForkSessionAction } = await import('../src/dsh-adapter/channel/session-fork.js')
const { extractEntries } = await import('../src/dsh-adapter/sessionTree.js')
const { isExitResumable } = await import('../src/dsh-adapter/plugin.js')
const { concreteService } = await import('../src/dsh-adapter/host-access.js')
const { liveSessionCreateOptions } = await import('../src/dsh-adapter/compat/index.js')
const { t } = await import('../src/i18n.js')

const negativeControls = process.argv.includes('--negative-controls')

class ScriptedAdapter extends LlmAdapter {
  async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  async *stream() {
    yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
    yield { type: 'text-delta' as const, index: 0, text: 'saved reply' }
    yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: 'saved reply' } }
    yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
  }
}

const policyTypes = ['permission/preset', 'sandbox/mode', 'approval/policy']
const title = (session: Session, text: string): void => {
  session.append('session/title', { title: text, messageSeqs: [], source: { kind: 'user' } })
}

async function verify(compression: 'zstd' | 'none'): Promise<SessionId> {
  const ctx = new Context()
  const handles: AgentHandle[] = []
  const releaseWaiters: Array<() => void> = []
  const abandonedIds = new Set<SessionId>()
  const sessionsRoot = join(root, compression)
  let channel: ReturnType<typeof createChannel> | undefined
  let savedId: SessionId | undefined
  let teardownSession: Session | undefined
  try {
    for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) {
      await ctx.plugin(plugin)
    }
    const backend = await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter())
    // Reproduce the official permission service's session/created pinning, plus
    // the host projection cache's create-time checkpoint: both are listeners of
    // the same event, and the cache's `flushSoft('create')` reaches
    // `ctx.sessions.flush(session)` from inside the creation transaction.
    const createFlushes = new Set<string>()
    const writers = new Map<string, { writer: { append(events: readonly SessionEvent[]): Promise<void> }; flush: () => Promise<void> }>()
    let preFixId = ''
    ctx.on('session/created', session => {
      if (session.seq !== 0) return
      const append = session.append as (type: string, data: Record<string, unknown>) => unknown
      append.call(session, 'permission/preset', { preset: 'workspace-write' })
      session.append('sandbox/mode', { mode: 'workspace-write' })
      session.append('approval/policy', { policy: 'ask' })
      const id = String(session.id)
      if (!createFlushes.has(id)) return
      const captured = writers.get(id)
      if (negativeControls && id === preFixId && captured !== undefined) {
        // Pre-fix `guardedFlush`: start(), drain the live snapshot, then flush.
        const events = session.snapshotEvents()
        void (async () => {
          try {
            if (events.length > 0) await captured.writer.append(events)
            await captured.flush()
          } catch (error) { ctx.logger.warn(`negative control: pre-fix flush failed: ${String(error)}`) }
        })()
        return
      }
      void ctx.sessions.flush(session)
    })
    // Informational: a listener on a foreign fiber still observes a deferred
    // session (the gate only mutes the JSONL provider's own routing), which is
    // why the cache's event throttle also reaches the gate.
    const foreignSeen = new Map<string, number>()
    ctx.on('session/event', session => {
      const id = String(session.id)
      foreignSeen.set(id, (foreignSeen.get(id) ?? 0) + 1)
    })
    const seen = new Map<Session, SessionEvent[]>()
    ctx.on('session/event', (session, event) => {
      const events = seen.get(session) ?? []
      events.push(event)
      seen.set(session, events)
    }, { global: true })
    const persistence = concreteService(ctx.sessionPersistence)
    const originalCreate = persistence.create
    const artifact = (session: Session): string => persistence.locate(session.header).path
    const options = (id: string) => ({
      sessionId: SessionId(`${compression}-${id}`), meta: { cwd: root },
      agentOptions: { provider: 'scripted', model: 'scripted' },
    })
    const fresh = async (id: string): Promise<AgentHandle> => {
      const handle = await createFreshAgent(ctx, ctx.agents, options(id))
      handles.push(handle)
      return handle
    }
    const stored = async (session: Session): Promise<readonly SessionEvent[]> => {
      const reader = await persistence.open(session.id, 'read')
      try { return (await reader.read()).events }
      finally { await reader.close() }
    }
    const assertComplete = async (session: Session): Promise<void> => {
      const events = session.snapshotEvents()
      assert.deepEqual(await stored(session), events, 'persisted log equals the canonical Session, including seq and message ids')
      assert.deepEqual(seen.get(session), events, 'global consumers receive each original event exactly once')
    }

    const control = await ctx.agents.create(options('control'))
    handles.push(control)
    assert.ok(await settled(() => existsSync(artifact(control.agent.session))), 'ungated factory reproduces the permission-only artifact')
    await control.dispose()

    const startup = await fresh('startup')
    abandonedIds.add(startup.agent.session.id)
    assert.deepEqual(startup.agent.session.snapshotEvents().map(event => event.type), policyTypes, 'permissions are initialized before input')
    assert.equal(isUnstoredFreshSession(startup.agent.session), true, 'restart/update must not resume this unstored id')
    assert.equal(isExitResumable({ pendingCount: 1, liveAgent: startup.agent, startupAgent: startup.agent }), false, 'a parked TUI input cannot leave a marker for an unstored session')
    await sleep(250) // 固定窗:探针 — permission-only sessions must remain absent beyond JSONL's 200ms drain timer.
    assert.equal(existsSync(artifact(startup.agent.session)), false)
    await startup.dispose()
    assert.equal(existsSync(artifact(startup.agent.session)), false, 'idle exit does not save the initialization')
    assert.equal(await persistence.stat(startup.agent.session.id), undefined, 'the unmaterialized claim is released')

    const first = await fresh('new-start')
    channel = createChannel(ctx, first.agent, { handle: first, cwd: root, provider: 'scripted', model: 'scripted', activity: false })
    const emptySessions = [first.agent.session]
    for (let index = 0; index < 3; index++) {
      assert.equal(await channel.newSession(), true)
      const current = ctx.agents.get(SessionId(channel.agentId))!
      emptySessions.push(current.session)
      assert.deepEqual(current.session.snapshotEvents().map(event => event.type), policyTypes)
    }
    const current = ctx.agents.get(SessionId(channel.agentId))!
    channel.submit('first real prompt')
    assert.ok(await settled(() => channel!.rows.some(row => row.text === 'saved reply') && !channel!.working))
    await ctx.sessions.flush(current.session)
    assert.equal(isUnstoredFreshSession(current.session), false, 'a written conversation keeps its handoff id')
    assert.equal(isExitResumable({ pendingCount: 0, liveAgent: current, startupAgent: first.agent }), true, 'real user input leaves a resumable exit marker')
    await assertComplete(current.session)
    assert.deepEqual(current.session.snapshotEvents().slice(0, 3).map(event => event.type), policyTypes)
    assert.equal(current.session.snapshotEvents().filter(event => event.type === 'user/message').length, 1)
    for (const empty of emptySessions.slice(0, -1)) {
      abandonedIds.add(empty.id)
      assert.ok(await settled(() => ctx.agents.get(empty.id) === undefined), 'the replaced empty Agent closes')
      assert.equal(existsSync(artifact(empty)), false, '/new does not save the previous initialization')
    }
    savedId = current.session.id
    assert.equal(await channel.newSession(), true)
    const blank = ctx.agents.get(SessionId(channel.agentId))!
    assert.equal(isExitResumable({ pendingCount: 0, liveAgent: blank, startupAgent: current }), false, '/new cannot retain the previous conversation as its exit target')
    assert.equal((await channel.resumeTo(String(savedId))).ok, true)
    assert.ok(channel.rows.some(row => row.text === 'saved reply'), 'saved history resumes normally')
    channel.releaseContributions()
    channel = undefined

    // A checkpoint is not a publication: the host projection cache checkpoints
    // from `session/created` (and from its event throttle) while the session
    // still holds only initialization, so draining there re-materialized the
    // exact shell the deferral keeps out of JSONL. The checkpoint still
    // participates — callers keep observing a durability listener — and the
    // first real event still publishes the complete log from seq 0.
    persistence.create = async function (header, config) {
      const writer = await originalCreate.call(this, header, config)
      writers.set(String(header.id), { writer, flush: writer.flush.bind(writer) })
      return writer
    }
    const verifyCheckpointPublication = async (): Promise<void> => {
      const createFlushId = String(options('create-flush').sessionId)
      createFlushes.add(createFlushId)
      const createFlushed = await fresh('create-flush')
      assert.deepEqual(createFlushed.agent.session.snapshotEvents().map(event => event.type), policyTypes)
      await sleep(250) // 固定窗:探针 — beyond JSONL's 200ms live drain timer.
      assert.equal(existsSync(artifact(createFlushed.agent.session)), false, 'the create-time checkpoint does not publish the permission-only shell')
      assert.equal(isUnstoredFreshSession(createFlushed.agent.session), true, 'the create-time checkpoint does not hand the session off')
      console.log(`INFO deferred create-flush session: foreign listeners observed ${String(foreignSeen.get(createFlushId) ?? 0)} events`)
      title(createFlushed.agent.session, 'first real event')
      await ctx.sessions.flush(createFlushed.agent.session)
      assert.equal(isUnstoredFreshSession(createFlushed.agent.session), false, 'the first real event still hands the checkpointed session off')
      await assertComplete(createFlushed.agent.session)
      assert.deepEqual((await stored(createFlushed.agent.session)).map(event => event.seq), [0, 1, 2, 3], 'the published log is contiguous from seq 0')

      const explicit = await fresh('explicit-flush')
      assert.equal(await ctx.sessions.flush(explicit.agent.session), true, 'an idle checkpoint still reaches a participating listener')
      assert.equal(isUnstoredFreshSession(explicit.agent.session), true, 'an idle checkpoint does not publish the initialization')
      assert.equal(existsSync(artifact(explicit.agent.session)), false)
      title(explicit.agent.session, 'explicitly flushed')
      await ctx.sessions.flush(explicit.agent.session)
      assert.equal(isUnstoredFreshSession(explicit.agent.session), false, 'the first real event still hands the session off')
      await assertComplete(explicit.agent.session)
      const serviceFlush = await fresh('service-flush')
      await persistence.flush()
      assert.equal(existsSync(artifact(serviceFlush.agent.session)), false, 'the backend sweep does not publish an untouched session')
      title(serviceFlush.agent.session, 'after the sweep')
      await persistence.flush()
      await assertComplete(serviceFlush.agent.session)

      // The five channel actions that reached `agents.create` directly.
      // `/bg` starts an unseeded session, so it shares the gate: its creation
      // shape stays unpublished while idle, and the same shape without the gate
      // still publishes (this pair is what makes the case discriminative).
      const backgrounded = await fresh('channel-background-action')
      await sleep(250)
      assert.equal(existsSync(artifact(backgrounded.agent.session)), false, 'the /bg creation shape stays unpublished while idle')
      const ungated = await ctx.agents.create(options('channel-background-action-ungated'))
      handles.push(ungated)
      assert.ok(await settled(() => existsSync(artifact(ungated.agent.session))), 'the ungated /bg shape still publishes the shell')
      await ungated.dispose()

      // The other four channel actions (`/model`, `/fork`, `/rewind`, `/tree`)
      // copy a source prefix into the child, and the host appends that prefix
      // through the writer BEFORE `session/created` (dsh-agent-loop
      // `appendUnstoredSuffix` → writer.append → the JSONL backend materializes
      // on the first batch), so a flush-side gate cannot unmake a seeded child's
      // artifact: the file IS the inherited prefix. They are covered by
      // `verifySeededFamily` below, which is about the SOURCE they copy from.

      // Negative control (--negative-controls): replay the pre-fix
      // `guardedFlush` — start, drain the live snapshot, flush — for the same
      // creation shape and assert the shell DOES materialize.
      if (negativeControls) {
        preFixId = String(options('negative-control').sessionId)
        createFlushes.add(preFixId)
        const preFix = await fresh('negative-control')
        await sleep(250)
        assert.equal(existsSync(artifact(preFix.agent.session)), true, 'negative control: an unconditional drain+flush on the create checkpoint publishes the shell')
        console.log('PASS negative control: the pre-fix drain-on-flush semantics publish the shell')
      }
    }
    await verifyCheckpointPublication()
    persistence.create = originalCreate

    /**
     * The SEEDED family (`/model`, `/fork`, `/rewind`, `/tree`). Each of the
     * four copies a source prefix into a child, and the host stores a seed at
     * publication — the copy, not a flush, is what materializes the child. The
     * cases below drive BOTH shapes on real sources:
     *
     *  (a) a never-used source (`isUnstoredFreshSession` true) and the unseeded
     *      shape the action now takes: the create-time checkpoint still fires
     *      and the child's log must NOT appear until a real event, which then
     *      publishes it completely from seq 0;
     *  (b) a used source and the unchanged seeded shape: the whole prefix is
     *      copied and the child's log is complete at publication.
     *
     * `verifySeededWiring` pins which shape each action takes; these two halves
     * together are what make the pair discriminating.
     */
    const verifySeededFamily = async (): Promise<void> => {
      const unusedSource = await fresh('channel-seed-unused-source')
      assert.equal(isUnstoredFreshSession(unusedSource.agent.session), true, 'an untouched fresh session is the never-used verdict the four actions key on')
      const unusedSeed = unusedSource.agent.session.snapshotEvents()
      assert.deepEqual(unusedSeed.map(event => event.type), policyTypes, 'a never-used source holds initialization only')

      // Boundary of this change's coverage, asserted rather than argued: the
      // `/rewind` and `/tree` branches below are defense-in-depth while a
      // never-used source cannot be reached by either. Chat.tsx's rewind list
      // is human `user` rows only, and a tree entry comes from `extractEntries`
      // — both need real content, so a never-used source offers neither. If a
      // future projection starts offering one, this fails first and the two
      // branches need reachable coverage of their own.
      const unusedChannel = createChannel(ctx, unusedSource.agent, { handle: unusedSource, cwd: root, provider: 'scripted', model: 'scripted', activity: false })
      try {
        assert.equal(unusedChannel.rows.filter(row => row.kind === 'user' && row.label === undefined).length, 0, 'a never-used source offers no /rewind candidate (Chat.tsx rewindRows)')
      } finally { unusedChannel.releaseContributions() }
      assert.equal(extractEntries(String(unusedSource.agent.session.id), unusedSeed).length, 0, 'a never-used source offers no /tree entry to rewind or fork from')
      assert.equal(isUnstoredFreshSession(unusedSource.agent.session), true, 'mounting a channel over the source does not use it up')

      const usedSource = await fresh('channel-seed-used-source')
      const usedChannel = createChannel(ctx, usedSource.agent, { handle: usedSource, cwd: root, provider: 'scripted', model: 'scripted', activity: false })
      try {
        usedChannel.submit('a real prompt')
        assert.ok(await settled(() => usedChannel.rows.some(row => row.text === 'saved reply') && !usedChannel.working))
      } finally { usedChannel.releaseContributions() }
      await ctx.sessions.flush(usedSource.agent.session)
      assert.equal(isUnstoredFreshSession(usedSource.agent.session), false, 'a source with a real event is no longer never-used')
      const usedSeed = usedSource.agent.session.snapshotEvents()
      assert.ok(usedSeed.some(event => event.type === 'turn/start'), 'the used source holds a turn')
      assert.ok(usedSeed.some(event => event.type === 'user/message'), 'the used source holds the human prompt that started it')

      const sites: readonly { readonly name: string; readonly parentSession: SessionId | undefined }[] = [
        { name: 'channel-model-switch', parentSession: undefined },
        { name: 'channel-session-fork', parentSession: undefined },
        { name: 'channel-session-rewind', parentSession: usedSource.agent.session.id },
        { name: 'channel-session-tree-actions', parentSession: usedSource.agent.session.id },
      ]
      for (const site of sites) {
        // (a) The branch a never-used source takes: unseeded, and created
        // through the fresh-session gate (the shape `/new` and `/bg` use).
        const childId = SessionId(`${site.name}-unused`)
        createFlushes.add(String(childId))
        const child = await createFreshAgent(ctx, ctx.agents, {
          sessionId: childId,
          meta: { cwd: root },
          agentOptions: { provider: 'scripted', model: 'scripted' },
        })
        handles.push(child)
        await sleep(250) // 固定窗:探针 — beyond JSONL's 200ms live drain timer.
        assert.equal(existsSync(artifact(child.agent.session)), false, `${site.name}: a never-used source publishes no child`)
        assert.equal(isUnstoredFreshSession(child.agent.session), true, `${site.name}: the child starts as an unstored fresh session`)
        assert.deepEqual(child.agent.session.snapshotEvents().map(event => event.type), policyTypes, `${site.name}: the child starts from its own initialization`)
        title(child.agent.session, 'first real event')
        await ctx.sessions.flush(child.agent.session)
        assert.deepEqual((await stored(child.agent.session)).map(event => event.seq), [0, 1, 2, 3], `${site.name}: the child publishes completely from seq 0`)
        await assertComplete(child.agent.session)

        // (b) A source with real events keeps the unchanged branch: the prefix
        // is copied, and the create-time checkpoint adds nothing to it.
        const seededId = SessionId(`${site.name}-used`)
        createFlushes.add(String(seededId))
        const seeded = await ctx.agents.create(liveSessionCreateOptions({
          sessionId: seededId,
          seed: usedSeed,
          runtimeSession: usedSource.agent.session,
          inheritedCount: usedSeed.length,
          cwd: root,
          ...(site.parentSession === undefined ? {} : { parentSession: site.parentSession }),
          agentOptions: { provider: 'scripted', model: 'scripted' },
        }))
        handles.push(seeded)
        await sleep(250)
        const persisted = await stored(seeded.agent.session)
        assert.deepEqual(persisted.slice(0, usedSeed.length), usedSeed, `${site.name}: a used source still copies its whole prefix`)
        assert.deepEqual(persisted, seeded.agent.session.snapshotEvents(), `${site.name}: the seeded child stores exactly its own log`)
        assert.deepEqual(persisted.slice(0, 3).map(event => event.type), policyTypes, `${site.name}: no create-time checkpoint adds a suffix to the seeded child`)

        // Negative control (--negative-controls): the pre-fix DECISION for the
        // same never-used source — copy its initialization anyway. The host
        // stores a seed at publication, so the child's log appears; this is the
        // revert the wiring checks above refuse to let back in.
        if (negativeControls) {
          const preFix = await ctx.agents.create(liveSessionCreateOptions({
            sessionId: SessionId(`${site.name}-pre-fix-seed`),
            seed: unusedSeed,
            runtimeSession: unusedSource.agent.session,
            inheritedCount: unusedSeed.length,
            cwd: root,
            agentOptions: { provider: 'scripted', model: 'scripted' },
          }))
          handles.push(preFix)
          assert.equal(existsSync(artifact(preFix.agent.session)), true, `negative control: seeding a never-used source publishes the ${site.name} child`)
          console.log(`PASS negative control: seeding a never-used source publishes the ${site.name} child`)
        }
      }
    }
    await verifySeededFamily()

    /**
     * The face T-FIX-10's verdict could not see: a shell that is ALREADY on
     * disk. `isUnstoredFreshSession` answers for the deferral THIS process
     * installed, so a shell left behind by an earlier process — or one whose
     * `agent-preset/selected` already started the gate, or one web created — is
     * not in its WeakSet. The widened verdict asks what the source's log holds
     * instead, from the live snapshot in hand.
     *
     * The real `/fork` action is driven here, not just the creation shape it
     * takes: its notice is the user-facing half of the same decision, and a
     * seeded child would publish an artifact. Narrowing the verdict back to
     * `isUnstoredFreshSession` therefore reddens this case on all three counts.
     * The same action is then driven over a source that HAS content, which must
     * keep the seeded path exactly as it was.
     */
    const verifyOnDiskShellSource = async (): Promise<void> => {
      const shell = await ctx.agents.create(options('on-disk-shell'))
      handles.push(shell)
      assert.ok(await settled(() => existsSync(artifact(shell.agent.session))), 'the ungated shell publishes at creation')
      await shell.dispose()
      const resumed = await ctx.agents.resume({ resumeSessionId: options('on-disk-shell').sessionId })
      handles.push(resumed)
      const shellEvents = resumed.agent.session.snapshotEvents()
      // The shell's log is the shape an earlier process leaves behind: the
      // initialization it was created with (plus the constructor's own
      // `session/end-seed`), and nothing a person ever said.
      assert.deepEqual((await stored(resumed.agent.session)).slice(0, 3).map(event => event.type), policyTypes, 'the log on disk keeps the initialization it was created with')
      assert.equal(shellEvents.some(event => event.type === 'turn/start' || event.type === 'user/message'), false, 'the resumed shell carries no conversation evidence in the snapshot the verdict reads')
      assert.equal(isUnstoredFreshSession(resumed.agent.session), false, 'the never-used verdict cannot see a shell that is already on disk — the face this widening adds')

      const forks: AgentHandle[] = []
      const notices: string[] = []
      const created: string[] = []
      const fork = createForkSessionAction(
        ctx,
        { working: false, cwd: root, provider: 'scripted', model: 'scripted', sessionTitle: 'shell' },
        {
          owner: { current: () => true },
          settleCompaction: async () => {},
          notify: text => { notices.push(text) },
          source: () => resumed.agent.session,
          createDetachedHandle: async create => {
            const handle = await create()
            forks.push(handle)
            return { handle, release: async () => { await handle.dispose() } }
          },
        },
      )
      const driveFork = async (): Promise<string> => {
        notices.length = 0
        forks.length = 0
        created.length = 0
        persistence.create = async function (header, config) {
          created.push(String(header.id))
          return originalCreate.call(this, header, config)
        }
        try {
          assert.equal(await fork(), true, 'the /fork action completes')
        } finally { persistence.create = originalCreate }
        await sleep(250) // 固定窗:探针 — beyond JSONL's 200ms live drain timer.
        assert.equal(created.length, 1, 'the fork creates exactly one session')
        return created[0]!
      }

      // (a) A shell on disk: no notice may promise a resume, and no child log
      // may exist before the child's own first real event.
      const childId = await driveFork()
      const child = forks[0]!
      assert.equal(isUnstoredFreshSession(child.agent.session), true, 'the /fork action took its unseeded branch for an on-disk shell')
      assert.equal(existsSync(artifact(child.agent.session)), false, 'a fork of an on-disk shell publishes no child')
      const notice = notices.at(-1) ?? ''
      assert.equal(notice, t('fork-done-unstored', { id: childId }), 'the fork notice for a conversation-less source is the new-session wording')
      assert.equal(notice.includes('--resume'), false, 'a fork of a conversation-less source must not print a --resume command')
      assert.equal(notice.includes('DSH_TUI_RESUME_SESSION'), false, 'nor the POSIX resume form')

      // (b) The other direction at the same level: a source WITH content keeps
      // the seeded branch — a widening that swallowed every source would fail
      // here, and the copied prefix is still byte for byte the source log.
      const usedChannel = createChannel(ctx, resumed.agent, { handle: resumed, cwd: root, provider: 'scripted', model: 'scripted', activity: false })
      try {
        usedChannel.submit('a real prompt')
        assert.ok(await settled(() => usedChannel.rows.some(row => row.text === 'saved reply') && !usedChannel.working))
      } finally { usedChannel.releaseContributions() }
      await ctx.sessions.flush(resumed.agent.session)
      const usedEvents = resumed.agent.session.snapshotEvents()
      assert.ok(usedEvents.some(event => event.type === 'turn/start'), 'the source now holds a turn')
      const seededId = await driveFork()
      const seededChild = forks[0]!
      const seededNotice = notices.at(-1) ?? ''
      assert.equal(isUnstoredFreshSession(seededChild.agent.session), false, 'a source with real content still takes the seeded branch')
      assert.equal(existsSync(artifact(seededChild.agent.session)), true, '…and its child still publishes the copied prefix')
      assert.equal(seededNotice.includes(`--resume ${seededId}`) || seededNotice.includes(`DSH_TUI_RESUME_SESSION=${seededId}`), true, '…and the notice still says how to enter it')
      assert.deepEqual((await stored(seededChild.agent.session)).slice(0, usedEvents.length), usedEvents, 'the copied prefix is byte for byte the source log')
      console.log('PASS /fork on an on-disk shell: no resume command, no child log, and a used source still seeds')

      if (negativeControls) {
        // The pre-fix DECISION for the same on-disk shell: copy its
        // initialization into a child and advertise the resume command. Both
        // assertions above must be able to see this (L-044 / L-048).
        const preFixId = String(options('on-disk-shell-pre-fix').sessionId)
        const preFix = await ctx.agents.create(liveSessionCreateOptions({
          sessionId: SessionId(preFixId),
          seed: shellEvents,
          runtimeSession: resumed.agent.session,
          inheritedCount: shellEvents.length,
          cwd: root,
          agentOptions: { provider: 'scripted', model: 'scripted' },
        }))
        handles.push(preFix)
        assert.equal(isUnstoredFreshSession(preFix.agent.session), false, 'negative control: a seeded child of an on-disk shell is not an unstored fresh session')
        assert.equal(existsSync(artifact(preFix.agent.session)), true, 'negative control: seeding an on-disk shell publishes its child')
        assert.equal(t('fork-done', { id: preFixId, command: `dsh-tui --resume ${preFixId}` }).includes('--resume'), true, 'negative control: the pre-fix notice advertises a resume command')
        console.log('PASS negative control: seeding an on-disk shell publishes its child and the pre-fix notice advertises a resume command')
      }
    }
    await verifyOnDiskShellSource()

    // Hold the first suffix in the public writer while more events arrive,
    // then fail the next suffix. A checkpoint must retry that exact prefix.
    const entered = Promise.withResolvers<void>()
    const permit = Promise.withResolvers<void>()
    releaseWaiters.push(permit.resolve)
    let calls = 0
    persistence.create = async function (header, config) {
      const writer = await originalCreate.call(this, header, config)
      if (header.id === options('handoff').sessionId) {
        const append = writer.append.bind(writer)
        writer.append = async events => {
          calls++
          if (calls === 1) { entered.resolve(); await permit.promise }
          if (calls === 2) throw new Error('injected suffix failure')
          await append(events)
        }
      }
      return writer
    }
    const handoff = await fresh('handoff')
    persistence.create = originalCreate
    title(handoff.agent.session, 'during handoff')
    await entered.promise
    handoff.agent.session.append('sandbox/mode', { mode: 'read-only' })
    const failingFlush = ctx.sessions.flush(handoff.agent.session)
    permit.resolve()
    await assert.rejects(failingFlush, /injected suffix failure/)
    await ctx.sessions.flush(handoff.agent.session)
    await assertComplete(handoff.agent.session)
    title(handoff.agent.session, 'after handoff')
    await ctx.sessions.flush(handoff.agent.session)
    await assertComplete(handoff.agent.session)
    await handoff.dispose()

    // Teardown waits for a started handoff before closing the owned writer.
    const disposing = await fresh('disposing')
    title(disposing.agent.session, 'save before exit')
    disposing.agent.session.append('sandbox/mode', { mode: 'read-only' })
    await disposing.dispose()
    await assertComplete(disposing.agent.session)

    // Completing overlapping factories out of order must restore the public
    // create method and leave no stale capture or permission-only artifact.
    const aEntered = Promise.withResolvers<void>()
    const aPermit = Promise.withResolvers<void>()
    releaseWaiters.push(aPermit.resolve)
    const aPending = createFreshAgent(ctx, ctx.agents, {
      ...options('concurrent-a'), setup: async () => { aEntered.resolve(); await aPermit.promise },
    })
    await aEntered.promise
    const host = await ctx.agents.create(options('concurrent-host'))
    handles.push(host)
    title(host.agent.session, 'host history')
    await ctx.sessions.flush(host.agent.session)
    await assertComplete(host.agent.session)
    const b = await fresh('concurrent-b')
    aPermit.resolve()
    const a = await aPending
    handles.push(a)
    assert.equal(persistence.create, originalCreate, 'the temporary capture is completely removed')
    for (const handle of [a, b]) {
      abandonedIds.add(handle.agent.session.id)
      assert.deepEqual(handle.agent.session.snapshotEvents().map(event => event.type), policyTypes)
      await handle.dispose()
      assert.equal(existsSync(artifact(handle.agent.session)), false)
    }

    await assert.rejects(createFreshAgent(ctx, ctx.agents, {
      ...options('setup-failure'), setup: () => { throw new Error('injected setup failure') },
    }), /injected setup failure/)
    assert.equal(persistence.create, originalCreate, 'failed setup restores the capture')
    assert.equal(await persistence.stat(options('setup-failure').sessionId), undefined)

    // A publication commit's events are stored by the factory itself.
    const seeded = await createFreshAgent(ctx, ctx.agents, {
      ...options('setup-commit'), setup: (_scope, agent) => ({ commit: () => title(agent.session, 'setup history') }),
    })
    handles.push(seeded)
    title(seeded.agent.session, 'later history')
    await ctx.sessions.flush(seeded.agent.session)
    assert.deepEqual(await stored(seeded.agent.session), seeded.agent.session.snapshotEvents())

    const closeEntered = Promise.withResolvers<void>()
    const closePermit = Promise.withResolvers<void>()
    releaseWaiters.push(closePermit.resolve)
    persistence.create = async function (header, config) {
      const writer = await originalCreate.call(this, header, config)
      if (header.id === options('provider-teardown').sessionId) {
        const append = writer.append.bind(writer)
        let firstAppend = true
        writer.append = async events => {
          await append(events)
          if (firstAppend) {
            firstAppend = false
            closeEntered.resolve()
            await closePermit.promise
          }
        }
      }
      return writer
    }
    const teardown = await fresh('provider-teardown')
    persistence.create = originalCreate
    teardownSession = teardown.agent.session
    title(teardownSession, 'first suffix')
    await closeEntered.promise
    teardownSession.append('sandbox/mode', { mode: 'read-only' })
    let providerClosed = false
    const closingProvider = backend.dispose().then(() => { providerClosed = true })
    await setImmediate()
    assert.equal(providerClosed, false, 'provider teardown waits for the pending handoff')
    closePermit.resolve()
    await closingProvider
    console.log(`PASS ${compression}: startup, repeated /new, first prompt, resume, flush, suffix retry, exit and factory cleanup`)
  } finally {
    for (const release of releaseWaiters) release()
    channel?.releaseContributions()
    for (const handle of handles) await handle.dispose()
    await ctx.fiber.dispose()
  }
  const reopened = new Context()
  try {
    await reopened.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression })
    const rows = await reopened.sessionPersistence.list()
    assert.equal(rows.some(row => abandonedIds.has(row.header.id)), false, 'fresh readers cannot list abandoned empty sessions')
    assert.ok(rows.some(row => row.header.id === savedId), 'the real conversation survives a fresh backend')
    const reader = await reopened.sessionPersistence.open(savedId!, 'read')
    try {
      const events = (await reader.read()).events
      assert.deepEqual(events.slice(0, 3).map(event => event.type), policyTypes)
      assert.ok(events.some(event => event.type === 'user/message'))
    } finally { await reader.close() }
    const teardownReader = await reopened.sessionPersistence.open(teardownSession!.id, 'read')
    try {
      assert.deepEqual((await teardownReader.read()).events, teardownSession!.snapshotEvents(), 'provider-first teardown preserves every event of the handoff')
    } finally { await teardownReader.close() }
  } finally { await reopened.fiber.dispose() }
  return savedId!
}

/**
 * `/bg` is the one channel create that starts an unseeded session, so it is the
 * one that can share the gate. The shape checks above drive `createFreshAgent`
 * directly and would stay green if the action went back to the ungated factory,
 * so pin the wiring itself.
 */
function verifyChannelWiring(): void {
  const source = readFileSync(new URL('../src/dsh-adapter/channel/background-action.ts', import.meta.url), 'utf8')
  assert.match(source, /import \{ createFreshAgent \} from '\.\.\/fresh-agent\.js'/, '/bg imports the fresh-session gate')
  assert.match(source, /createFreshAgent\(ctx, agents, \{/, '/bg creates through the gate')
  assert.equal(source.includes('agents.create('), false, '/bg no longer calls the ungated factory')
  console.log('PASS /bg creation wiring')
}

/**
 * The four seeded channel actions. `verifySeededFamily` drives the creation
 * SHAPES through the real host and `verifyOnDiskShellSource` drives `/fork`
 * itself; the SHAPES alone would stay green if an action went back to seeding
 * unconditionally, because they drive the creation rather than the action. So
 * pin the wiring: each action must ask the conversation verdict — the deferral's
 * `isUnstoredFreshSession` AND the sweep's evidence rule — and let THAT verdict
 * select the unseeded branch, in that order. Every marker is guarded (a missing
 * or reordered marker fails instead of passing on an empty window — LESSONS
 * L-048), and `--negative-controls` reverses the decision to prove the checks
 * can fail (L-044): seeded unconditionally, the widening narrowed back to
 * `isUnstoredFreshSession`, the verdict dropped, and `/fork`'s notice reverting
 * to an advertised resume command.
 */
const SEEDED_SITES: readonly {
  readonly name: string
  readonly file: string
  /** The widening's own line: the evidence rule the verdict now also asks. */
  readonly evidence: string
  /** The session expression the verdict is read from, for the "verdict dropped" reversal. */
  readonly subject: string
  /** A notice line, when the site has one, for the "resume command is back" reversal. */
  readonly notice?: string
  readonly markers: readonly string[]
}[] = [
  {
    name: 'channel-model-switch',
    file: 'model-switch.ts',
    evidence: '|| CONVERSATION_EVIDENCE.log({ events: snapshotLiveSessionEvents(source), complete: true }) === undefined',
    subject: 'source',
    markers: [
      'sourceHoldsNoConversation = isUnstoredFreshSession(source)',
      '|| CONVERSATION_EVIDENCE.log({ events: snapshotLiveSessionEvents(source), complete: true }) === undefined',
      'seed = sourceHoldsNoConversation ? [] : sliceLiveSessionSeed(source)',
      'const create = (): Promise<AgentHandle> => sourceHoldsNoConversation',
      '? createFreshAgent(ctx, agents, {',
      ': agents.create(liveSessionCreateOptions({',
    ],
  },
  {
    name: 'channel-session-fork',
    file: 'session-fork.ts',
    evidence: '|| CONVERSATION_EVIDENCE.log({ events: snapshotLiveSessionEvents(source), complete: true }) === undefined',
    subject: 'source',
    notice: "? t('fork-done-unstored', { id: String(childId) })",
    markers: [
      'sourceHoldsNoConversation = isUnstoredFreshSession(source)',
      '|| CONVERSATION_EVIDENCE.log({ events: snapshotLiveSessionEvents(source), complete: true }) === undefined',
      'seed = sourceHoldsNoConversation ? [] : sliceLiveSessionSeed(source)',
      'deps.createDetachedHandle(() => sourceHoldsNoConversation',
      '? createFreshAgent(ctx, agents, {',
      ': agents.create(liveSessionCreateOptions({',
      "? t('fork-done-unstored', { id: String(childId) })",
    ],
  },
  {
    name: 'channel-session-rewind',
    file: 'session-rewind.ts',
    evidence: '|| CONVERSATION_EVIDENCE.log({ events: snapshotLiveSessionEvents(source), complete: true }) === undefined',
    subject: 'source',
    markers: [
      'sourceHoldsNoConversation = isUnstoredFreshSession(source)',
      '|| CONVERSATION_EVIDENCE.log({ events: snapshotLiveSessionEvents(source), complete: true }) === undefined',
      'seed = sourceHoldsNoConversation ? [] : sliceLiveSessionSeed(source, boundary)',
      'const create = (): Promise<AgentHandle> => sourceHoldsNoConversation',
      '? createFreshAgent(ctx, agents, {',
      ': agents.create(liveSessionCreateOptions({',
    ],
  },
  {
    name: 'channel-session-tree-actions',
    file: 'session-tree-actions.ts',
    evidence: '|| CONVERSATION_EVIDENCE.log({ events: sourceEvents, complete: true }) === undefined',
    subject: 'entrySession',
    markers: [
      // A persisted foreign source is on disk and never in this state, so the
      // verdict is asked about the LIVE source only.
      'const sourceHoldsNoConversation = forkFromLive && (isUnstoredFreshSession(entrySession)',
      '|| CONVERSATION_EVIDENCE.log({ events: sourceEvents, complete: true }) === undefined',
      'const seed = sourceHoldsNoConversation ? [] : sourceEvents.filter(event => event.seq <= target.boundary)',
      'const create = (): Promise<AgentHandle> => sourceHoldsNoConversation',
      '? createFreshAgent(ctx, agents, {',
      ': agents.create(liveSessionCreateOptions({',
    ],
  },
]

/** Every wiring violation of one site's source text, in reading order. */
function seededWiringViolations(
  site: (typeof SEEDED_SITES)[number],
  source: string,
): string[] {
  const violations: string[] = []
  if (!/import \{ createFreshAgent, isUnstoredFreshSession \} from '\.\.\/fresh-agent\.js'/.test(source)) {
    violations.push('does not import createFreshAgent + isUnstoredFreshSession')
  }
  if (!/import \{ unspokenJudges \} from '\.\.\/unspoken-sessions\.js'/.test(source)) {
    violations.push('does not ask the sweep evidence rule through unspokenJudges')
  }
  let cursor = -1
  for (const marker of site.markers) {
    const at = source.indexOf(marker)
    if (at === -1) { violations.push(`missing: ${marker}`); continue }
    if (at <= cursor) violations.push(`out of order: ${marker}`)
    cursor = at
  }
  return violations
}

function verifySeededWiring(): void {
  for (const site of SEEDED_SITES) {
    const path = new URL(`../src/dsh-adapter/channel/${site.file}`, import.meta.url)
    const source = readFileSync(path, 'utf8')
    assert.deepEqual(seededWiringViolations(site, source), [], `${site.name}: the never-used verdict selects the unseeded branch`)
    if (negativeControls) {
      // The reversals this task forbids — seed unconditionally, narrow the
      // widened verdict back to T-FIX-10's criterion, drop the verdict, and put
      // the resume command back in `/fork`'s notice. Every one must be caught
      // (L-044 / L-048).
      const unconditional = seededWiringViolations(site, source.replaceAll('=> sourceHoldsNoConversation', '=> false'))
      assert.ok(unconditional.length > 0, `negative control: ${site.name} wiring catches seeding unconditionally`)
      const narrowed = seededWiringViolations(site, source.replace(site.evidence, ''))
      assert.ok(narrowed.length > 0, `negative control: ${site.name} wiring catches the widened verdict narrowed back to isUnstoredFreshSession`)
      const verdictless = seededWiringViolations(site, source.replaceAll(`isUnstoredFreshSession(${site.subject})`, 'false'))
      assert.ok(verdictless.length > 0, `negative control: ${site.name} wiring catches a dropped verdict`)
      const notice = site.notice === undefined
        ? []
        : seededWiringViolations(site, source.replace(site.notice, "t('fork-done', { id: String(childId), command })"))
      if (site.notice !== undefined) {
        assert.ok(notice.length > 0, `negative control: ${site.name} wiring catches a notice that advertises a resume command again`)
      }
      console.log(`PASS negative control: ${site.name} wiring catches "seed unconditionally", the widening narrowed away, a dropped verdict${site.notice === undefined ? '' : ' and the resume notice coming back'}`)
    }
    console.log(`PASS ${site.name} seeded wiring`)
  }
}

function verifyHandoffs(savedId: SessionId): void {
  const cases = [
    { name: 'startup empty /restart', kind: 'restart', session: '', args: [], expected: [] },
    { name: '/new then /restart from an inherited resume', kind: 'restart', session: '', args: ['--resume', 'old-session', '--fullscreen'], expected: ['--fullscreen'] },
    { name: '/new then /update from inherited resume flags', kind: 'update', session: '', args: ['--resume=old-session', '--continue', '-c', '--fullscreen'], expected: ['--fullscreen'] },
    { name: 'saved conversation /restart', kind: 'restart', session: savedId, args: ['--resume', 'old-session'], expected: ['--resume', 'old-session'] },
    { name: 'saved conversation /update', kind: 'update', session: savedId, args: [], expected: [] },
  ]
  for (const test of cases) {
    const run = spawnSync(process.execPath, ['--import', 'tsx/esm', fileURLToPath(import.meta.url), ...test.args], {
      encoding: 'utf8', timeout: 30000,
      env: {
        ...process.env,
        DSH_TUI_RESUME_SESSION: 'old-session',
        DSH_TUI_EMPTY_HANDOFF_ROLE: 'driver',
        DSH_TUI_EMPTY_HANDOFF_KIND: test.kind,
        DSH_TUI_EMPTY_HANDOFF_SESSION: test.session,
        DSH_TUI_EMPTY_HANDOFF_ROOT: join(root, 'none'),
        DSH_TUI_EMPTY_HANDOFF_ARGV: JSON.stringify(test.expected),
      },
    })
    assert.equal(run.status, 0, `${test.name}: ${run.error?.message ?? ''}\n${run.stderr}\n${run.stdout}`)
    assert.ok(run.stdout.includes('PASS replacement Config and Agent startup'), test.name)
    console.log(`PASS ${test.name}`)
  }
}

try {
  verifyChannelWiring()
  verifySeededWiring()
  const savedId = await verify('none')
  await verify('zstd')
  verifyHandoffs(savedId)
} finally {
  rmSync(root, { recursive: true, force: true })
}
