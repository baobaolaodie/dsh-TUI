#!/usr/bin/env node
/**
 * Model-switch draft regression: mounted/parked composer, launchpad, images,
 * replacement/legacy channels, and the real channel-to-UI projection.
 * Run: node --import tsx/esm scripts/verify-composer-draft-model-switch.tsx
 * Optional subset: VERIFY_DRAFT_SWITCH_SCENARIOS=A,B,E,F,G
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { settled, viewportLines, screenHas } from './lib/term-test.mjs'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'
// Preferences resolve HOME at module evaluation, before the first channel opens.
const home = mkdtempSync(join(tmpdir(), 'dsh-tui-draft-model-switch-'))
process.env.HOME = process.env.USERPROFILE = home
process.env.DSH_HOME = join(home, 'dsh')
const imagePath = join(home, 'draft.png')
writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))

const [React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }, { LOCAL_COMMANDS, completeCommands }, { t }, { Context }, { createChannel }, { mountChannelUi }, { registerTuiChannel }] = await Promise.all([
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('../src/i18n.js'),
  import('@deepseek-ai/cordis'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/channel-ui.js'),
  import('../src/adapter/channel/host-registry.js'),
])

const EMPTY: readonly never[] = Object.freeze([])
const ROWS = 36
const TOKEN = '[Image #1]'
const MODEL_BEFORE = 'probe-model-a'
const MODEL_AFTER = 'probe-model-b'
const DRAFT = 'line-one\nline-two'
const placeholder = t('launchpad-placeholder')
const noop = () => {}
const subscribeNone = () => noop
const runtimeErrors: string[] = []
const stderrWrite = process.stderr.write.bind(process.stderr)
;(process.stderr as { write: (...args: unknown[]) => unknown }).write = (chunk: unknown, ...args: unknown[]) => {
  if (String(chunk).includes('[dsh-tui]')) runtimeErrors.push(String(chunk))
  return (stderrWrite as (...args: unknown[]) => unknown)(chunk, ...args)
}

async function wait(label: string, predicate: () => boolean): Promise<void> {
  assert.equal(await settled(predicate, { timeoutMs: 8000 }), true, label)
}

function makeChannel(legacy: boolean) {
  const listeners = new Set<() => void>()
  const state = {
    generation: 0,
    imageGeneration: 0,
    nextImage: 1,
    continuedFromAgentId: undefined as string | undefined,
    staged: new Map<string, { id: string; path: string }>(),
    rows: [{ id: 1, kind: 'user' as const, text: 'probe transcript row' }],
  }
  const channel = {
    version: 0,
    agentId: 'probe-agent',
    sessionId: 'probe-session',
    model: MODEL_BEFORE,
    provider: 'deepseek',
    status: 'idle',
    sessionTitle: 'probe',
    whaleIdle: false,
    reasoningEffort: 'max',
    effortLevels: EMPTY,
    tokens: { input: 0, output: 0 },
    cwd: '/tmp/probe',
    displayCwd: '/tmp/probe',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    pending: EMPTY,
    commandList: LOCAL_COMMANDS,
    notifications: EMPTY,
    mode: { plan: false, sandbox: undefined },
    activityFrames: 'moon8',
    lastUserText: '',
    scrollGutter: 'timeline',
    subagents: EMPTY,
    backgroundJobs: EMPTY,
    get rows() { return state.rows },
    get agentBindingGeneration() { return state.generation },
    get continuedFromAgentId() { return state.continuedFromAgentId },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    bump() {
      channel.version += 1
      for (const listener of listeners) listener()
    },
    submit: noop,
    cancel: noop,
    clear: noop,
    notify: noop,
    listModels: async () => [],
    listSessions: async () => [],
    deleteSession: async () => true,
    renameSessionTo: async () => true,
    setResumeTarget: noop,
    loadOlder: noop,
    mcpStatus: () => EMPTY,
    pushLocal: noop,
    commandCompletions: (input: string) => completeCommands(input),
    stagedImageGeneration: () => state.imageGeneration,
    stagedImage: (id: string) => state.staged.get(id),
    hasStagedImage: (id: string) => state.staged.has(id),
    discardStagedImage: (id: string) => { state.staged.delete(id) },
    stagedImageLimits: () => ({ maxImageBytes: 1_000_000, maxImagesPerMessage: 8, maxImageDimension: 8192, maxImagePixels: 64_000_000 }),
    stageComposerImage: async () => {
      const stageId = `stage-${state.nextImage++}`
      state.staged.set(stageId, { id: stageId, path: imagePath })
      return { stageId }
    },
    previewImages: () => EMPTY,
    subagentControl: { interrupt: noop },
    backgroundCurrent: async () => ({ ok: true, backgroundedSessionId: 'probe' }),
    agentViewRows: () => EMPTY,
    subscribeAgentView: subscribeNone,
    settingsHost: () => undefined,
    settingsSections: () => EMPTY,
    subscribeSettingsSections: subscribeNone,
    buildSessionTree: () => new Promise<null>(() => {}),
    listPresets: async () => [],
    permissionPresets: () => ({ availability: 'unavailable' as const, current: undefined }),
  }
  if (legacy) delete (channel as Partial<typeof channel>).continuedFromAgentId
  return { channel, state }
}

class Stdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

async function mount(options: { launchpad?: boolean; legacy?: boolean; fullscreen?: boolean; columns?: number } = {}) {
  const cols = options.columns ?? (options.launchpad ? 120 : 100)
  const term = new XTerm({ cols, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = Object.assign(new Writable({
    write(chunk, _encoding, done) { term.write(String(chunk), done) },
  }), { columns: cols, rows: ROWS, isTTY: true })
  const stderr = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }), { isTTY: true })
  const stdin = new Stdin()
  const fixture = makeChannel(options.legacy === true)
  const app = await render(React.createElement(Chat, {
    channel: fixture.channel as never,
    questionStore: new QuestionStore(),
    fullscreen: options.fullscreen ?? true,
    launchpadOnBoot: options.launchpad === true,
  }), { stdout: stdout as never, stdin: stdin as never, stderr: stderr as never, exitOnCtrlC: false, patchConsole: false })
  return { ...fixture, term, stdin, unmount: () => app.unmount() }
}
type Harness = Awaited<ReturnType<typeof mount>>

function composer(app: Harness) {
  const rows = viewportLines(app.term)
  const bottom = rows.findLastIndex(row => row.includes('╰'))
  let top = bottom - 1
  while (top >= 0 && !rows[top]!.includes('╭')) top -= 1
  const block = rows.slice(top, bottom + 1).map(row => row.trimEnd())
  if (top < 0 || !block.some(row => row.includes('❯')) || !block.some(row => row.includes('⛶'))) return null
  // Transcript changes can move the whole box; only the caret within it matters.
  return { block, caret: { x: app.term.buffer.active.cursorX, row: app.term.buffer.active.cursorY - top } }
}
const hasDraft = (app: Harness, text: string) => composer(app)?.block.join('\n').includes(text) ?? false
const paste = (app: Harness, text: string) => app.stdin.write(`\x1b[200~${text}\x1b[201~`)
function anchor(app: Harness, text: string) {
  app.state.rows.push({ id: app.state.rows.length + 1, kind: 'user', text })
  app.channel.bump()
}
function adopt(app: Harness, continued: boolean) {
  app.state.continuedFromAgentId = continued ? app.channel.agentId : undefined
  app.channel.agentId = app.channel.sessionId = 'next-agent'
  app.channel.model = MODEL_AFTER
  app.state.generation += 1
  app.state.imageGeneration += 1
  app.state.staged.clear()
  anchor(app, 'SWITCH-COMMITTED')
}

function tokenIsChip(app: Harness): boolean {
  const buffer = app.term.buffer.active
  for (let row = 0; row < ROWS; row += 1) {
    const line = buffer.getLine(buffer.baseY + row)
    const col = line?.translateToString(true).indexOf(TOKEN) ?? -1
    if (col < 0) continue
    const token = line?.getCell(col)
    const plain = line?.getCell(Math.max(0, col - 2))
    return token !== undefined && plain !== undefined && !token.isFgDefault() && token.getFgColor() !== plain.getFgColor()
  }
  return false
}

async function typeDraft(app: Harness) {
  await wait('composer mounted', () => composer(app) !== null)
  paste(app, DRAFT)
  await wait('multiline draft painted', () => hasDraft(app, 'line-one') && hasDraft(app, 'line-two'))
  const end = app.term.buffer.active.cursorX
  for (let step = 1; step <= 3; step += 1) {
    app.stdin.write('\x1b[D')
    await wait('caret moved left', () => app.term.buffer.active.cursorX === end - step)
  }
}

async function chatCase(options: { continued: boolean; legacy?: boolean; image?: boolean }) {
  const app = await mount(options)
  try {
    if (options.legacy) assert.equal('continuedFromAgentId' in app.channel, false)
    await typeDraft(app)
    if (options.image) {
      paste(app, imagePath)
      await wait('image token painted', () => hasDraft(app, TOKEN))
      assert.equal(tokenIsChip(app), true, 'chip probe sees the live image before revocation')
    }
    const before = composer(app)
    anchor(app, 'CONTROL-COMMITTED')
    await wait('neutral render committed', () => screenHas(app.term, 'CONTROL-COMMITTED'))
    assert.deepEqual(composer(app), before, 'neutral render preserves text and caret')
    adopt(app, options.continued)
    await wait('switch committed', () => screenHas(app.term, 'SWITCH-COMMITTED'))
    if (options.continued) assert.deepEqual(composer(app), before, 'continuation preserves text and caret')
    else await wait('replacement clears the draft', () => !hasDraft(app, 'line-one'))
    if (options.image) {
      assert.equal(app.state.staged.size, 0)
      assert.equal(tokenIsChip(app), false, 'revoked capability becomes plain text')
    }
  } finally { app.unmount() }
}

function launchpadDraft(app: Harness) {
  const row = viewportLines(app.term).find(line => line.includes('❯')) ?? ''
  const text = row.slice(row.indexOf('❯') + 1).replace(/│\s*$/u, '').trim()
  return text.startsWith(placeholder) ? '' : text
}
const modelRow = (app: Harness) => viewportLines(app.term).findLast(row => row.includes('  ·  ')) ?? ''
async function launchpadCase(continued: boolean) {
  const app = await mount({ launchpad: true })
  try {
    await wait('launchpad mounted', () => screenHas(app.term, placeholder))
    paste(app, 'launch-draft-keep')
    await wait('launchpad draft painted', () => launchpadDraft(app) === 'launch-draft-keep')
    assert.ok(modelRow(app).includes(MODEL_BEFORE))
    adopt(app, continued)
    await wait('new model painted', () => modelRow(app).includes(MODEL_AFTER))
    // A second frame fences the launchpad's passive clear effect.
    app.channel.model = `${MODEL_AFTER}-tick`
    app.channel.bump()
    await wait('passive effect flushed', () => modelRow(app).includes(`${MODEL_AFTER}-tick`))
    assert.equal(launchpadDraft(app), continued ? 'launch-draft-keep' : '')
    assert.equal(composer(app), null, 'launchpad stays open')
  } finally { app.unmount() }
}

async function parkedCase() {
  for (const fullscreen of [false, true]) {
    for (const columns of [100, 48]) {
      for (const continued of [true, false]) {
        const app = await mount({ fullscreen, columns })
        const label = `${fullscreen ? 'fullscreen' : 'inline'} ${columns}, ${continued ? 'continuation' : 'replacement'}`
        const dashboard = () => viewportLines(app.term).some(line => /^\s*─+\s*子代理面板\s*─+\s*$/u.test(line))
        const park = async () => {
          app.stdin.write('\x01')
          await wait(`${label}: parked`, () => dashboard() && composer(app) === null)
        }
        const resume = async () => {
          app.stdin.write('\x1b')
          await wait(`${label}: remounted`, () => !dashboard() && composer(app) !== null)
        }
        try {
          await typeDraft(app)
          paste(app, imagePath)
          await wait('image staged', () => hasDraft(app, TOKEN))
          assert.equal(tokenIsChip(app), true)
          const before = composer(app)
          await park()
          await resume()
          await wait('control draft restored', () => hasDraft(app, TOKEN))
          assert.deepEqual(composer(app), before, `${label}: control round trip`)
          await park()
          adopt(app, continued)
          await resume()
          await wait('switch committed', () => screenHas(app.term, 'SWITCH-COMMITTED'))
          assert.equal(app.state.staged.size, 0)
          if (continued) {
            await wait('parked draft restored', () => hasDraft(app, TOKEN))
            assert.deepEqual(composer(app), before, label)
            assert.equal(tokenIsChip(app), false, 'revoked image stays plain text')
            if (fullscreen && columns === 48) console.log(composer(app)?.block.join('\n'))
          } else {
            assert.equal(hasDraft(app, 'line-one') || hasDraft(app, TOKEN), false, label)
          }
        } finally { app.unmount() }
      }
    }
  }
}

async function facadeCase() {
  const agent = (id: string) => ({
    id, status: 'idle', options: {}, ctx: { on: subscribeNone },
    session: { id: `session-${id}`, seq: 0, events: [], header: {} },
    followup: noop, steer: noop, inbox: { remove: () => true }, cancel: noop,
    whenIdle: async () => {},
  })
  const ctx = new Context()
  const provide = (ctx as unknown as { provide(name: string, value: unknown): void }).provide.bind(ctx)
  const roster = ['switched-agent', 'replaced-agent']
  provide('agents', {
    get: () => undefined,
    create: async () => {
      const id = roster.shift()
      assert.ok(id, 'unexpected extra agent creation')
      return { agent: agent(id), dispose: async () => {} }
    },
  })
  provide('sessions', { fork: () => ({ events: [] }) })
  const raw = createChannel(ctx as never, agent('boot-agent') as never, { model: MODEL_BEFORE, cwd: '/tmp/probe', provider: 'deepseek', activity: false })
  const unregister = registerTuiChannel(ctx, raw)
  const mounted = mountChannelUi(ctx, raw, undefined, 'new')
  const ui = mounted.channel
  try {
    assert.equal('continuedFromAgentId' in ui, true, 'production projection carries the property')
    assert.equal(ui.continuedFromAgentId, undefined)
    assert.equal(await ui.switchModel('deepseek', MODEL_AFTER), true)
    assert.equal(ui.agentId, 'switched-agent')
    assert.equal(ui.sessionId, 'session-switched-agent')
    assert.equal(ui.continuedFromAgentId, 'boot-agent', 'real model-switch action records the source')
    assert.equal(ui.continuedFromAgentId, raw.continuedFromAgentId, 'facade reads live state')
    assert.ok(existsSync(join(home, '.dsh-tui', 'last-used.json')) && existsSync(join(home, '.dsh-tui', 'model.json')), 'action preferences stay in the isolated home')
    assert.equal(await ui.newSession(), true)
    assert.equal(ui.agentId, 'replaced-agent')
    assert.equal(ui.continuedFromAgentId, undefined, 'replacement resets the fact')
  } finally {
    mounted.dispose()
    unregister()
    raw.releaseContributions()
  }
}

const scenarios = [
  { id: 'A', name: 'mounted draft text and caret', run: () => chatCase({ continued: true }) },
  { id: 'B', name: 'launchpad continuation', run: () => launchpadCase(true) },
  { id: 'C', name: 'replacement and legacy channels', run: async () => {
    await chatCase({ continued: false })
    await chatCase({ continued: false, legacy: true })
    await launchpadCase(false)
  } },
  { id: 'E', name: 'mounted image revocation', run: () => chatCase({ continued: true, image: true }) },
  { id: 'F', name: 'real action and facade projection', run: facadeCase },
  { id: 'G', name: 'parked drafts in both terminal modes and widths', run: parkedCase },
]
try {
  const selected = (process.env.VERIFY_DRAFT_SWITCH_SCENARIOS ?? '').split(',').map(id => id.trim().toUpperCase()).filter(Boolean)
  assert.ok(selected.every(id => scenarios.some(test => test.id === id)), 'unknown scenario selection')
  for (const test of scenarios.filter(test => selected.length === 0 || selected.includes(test.id))) {
    try {
      await test.run()
      console.log(`PASS ${test.id}: ${test.name}`)
    } catch (error) {
      console.error(`FAIL ${test.id}: ${test.name}`, error)
      process.exitCode = 1
    }
  }
  assert.deepEqual(runtimeErrors, [], 'renderer errors')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  process.stderr.write = stderrWrite as typeof process.stderr.write
  rmSync(home, { recursive: true, force: true })
}
process.exit(process.exitCode ?? 0)
