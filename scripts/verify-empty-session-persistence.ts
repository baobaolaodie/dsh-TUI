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
 * the first real event still publishes the complete log from seq 0. The five
 * channel actions that created sessions outside the gate are covered by their
 * creation shape.
 *
 * Run: node --import tsx/esm scripts/verify-empty-session-persistence.ts
 *
 * Negative controls:
 *   1. In-process (re-runnable): add `--negative-controls`. It replays the
 *      pre-fix `guardedFlush` (start, drain the live snapshot, flush) on the
 *      same creation shape and asserts the shell DOES appear — the pair is what
 *      makes "the create-time checkpoint does not publish the permission-only
 *      shell" a discriminating assertion instead of a vacuous one.
 *   2. Real revert: restore `start(); await drain()` at the head of
 *      `guardedFlush` in src/dsh-adapter/fresh-agent.ts, then
 *      `node --import tsx/esm scripts/verify-empty-session-persistence.ts`
 *      → expect FAIL "the create-time checkpoint does not publish the
 *      permission-only shell" (plus the two narrowed checkpoint cases).
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
const { isExitResumable } = await import('../src/dsh-adapter/plugin.js')
const { concreteService } = await import('../src/dsh-adapter/host-access.js')
const { liveSessionCreateOptions } = await import('../src/dsh-adapter/compat/index.js')

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

      // The other four copy a source prefix into the child. The host appends
      // that prefix through the writer BEFORE `session/created`
      // (dsh-agent-loop `appendUnstoredSuffix` → writer.append → the JSONL
      // backend materializes on the first batch), so a flush-side gate cannot
      // unmake a seeded child's artifact: the file IS the inherited prefix.
      // Verified shape, not silence: an idle seeded child stores exactly its own
      // log — the inherited prefix plus the child's own seed marker — and no
      // create-time checkpoint adds anything to it.
      const seedSource = await fresh('channel-seed-source')
      const seed = seedSource.agent.session.snapshotEvents()
      assert.deepEqual(seed.map(event => event.type), policyTypes)
      const seededSites: readonly { name: string; parentSession: SessionId | undefined }[] = [
        { name: 'channel-model-switch', parentSession: undefined },
        { name: 'channel-session-fork', parentSession: undefined },
        { name: 'channel-session-rewind', parentSession: seedSource.agent.session.id },
        { name: 'channel-session-tree-actions', parentSession: seedSource.agent.session.id },
      ]
      for (const site of seededSites) {
        const id = options(site.name).sessionId
        createFlushes.add(String(id))
        const child = await ctx.agents.create(liveSessionCreateOptions({
          sessionId: id,
          seed,
          runtimeSession: seedSource.agent.session,
          inheritedCount: seed.length,
          cwd: root,
          ...(site.parentSession === undefined ? {} : { parentSession: site.parentSession }),
          agentOptions: { provider: 'scripted', model: 'scripted' },
        }))
        handles.push(child)
        await sleep(250)
        const persisted = await stored(child.agent.session)
        assert.deepEqual(persisted, child.agent.session.snapshotEvents(), `${site.name}: an idle seeded child stores exactly its own log (inherited prefix plus the child's seed marker)`)
        assert.deepEqual(persisted.slice(0, 3).map(event => event.type), policyTypes, `${site.name}: no create-time checkpoint adds a suffix`)
      }

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
  const savedId = await verify('none')
  await verify('zstd')
  verifyHandoffs(savedId)
} finally {
  rmSync(root, { recursive: true, force: true })
}
