#!/usr/bin/env node
/** Same-session model switches preserve mounted, parked and launchpad drafts.
 * Real channel + UI facade + Chat; only DSH services are fakes, with no requests.
 * Run: node --import tsx/esm scripts/verify-composer-draft-model-switch.tsx
 * Optional subset: VERIFY_DRAFT_SWITCH_SCENARIOS=A,B,G
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import type { PromptController } from '../src/components/PromptInput.js'
import { settled, viewportLines, screenHas } from './lib/term-test.mjs'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'
// Preference paths are resolved when the application modules are evaluated.
const home = mkdtempSync(join(tmpdir(), 'dsh-tui-draft-model-switch-'))
process.env.HOME = process.env.USERPROFILE = home
process.env.DSH_HOME = join(home, 'dsh')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const imagePath = join(home, 'draft.png')
writeFileSync(imagePath, png)
const [React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }, { t }, { Context }, { createChannel }, { mountChannelUi }, { registerTuiChannel }] = await Promise.all([
  import('react'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/screens/Chat.js'), import('../src/dsh-adapter/questions.js'),
  import('../src/i18n.js'), import('@deepseek-ai/cordis'),
  import('../src/dsh-adapter/channel.js'), import('../src/dsh-adapter/channel-ui.js'),
  import('../src/adapter/channel/host-registry.js'),
])

const ROWS = 36
const TOKEN = '[Image #1]'
const MODEL_BEFORE = 'probe-model-a'
const MODEL_AFTER = 'probe-model-b'
const DRAFT = 'line-one\nline-two'
const noop = () => {}
const runtimeErrors: string[] = []
const stderrWrite = process.stderr.write.bind(process.stderr)
;(process.stderr as { write: (...args: unknown[]) => unknown }).write = (chunk: unknown, ...args: unknown[]) => {
  if (String(chunk).includes('[dsh-tui]')) runtimeErrors.push(String(chunk))
  return (stderrWrite as (...args: unknown[]) => unknown)(chunk, ...args)
}
async function wait(label: string, predicate: () => boolean): Promise<void> {
  assert.equal(await settled(predicate, { timeoutMs: 8000 }), true, label)
}

function channelFixture() {
  const agent = (id: string) => ({
    id, status: 'idle', options: { provider: 'deepseek', model: MODEL_BEFORE },
    ctx: { on: () => noop },
    session: {
      id: `session-${id}`, seq: 1, header: { cwd: '/tmp/probe' },
      events: [{ seq: 0, time: 1, type: 'user/message', data: {
        id: 'initial-prompt', source: { kind: 'user' }, content: [{ type: 'text', text: 'probe transcript row' }],
      } }],
    },
    followup: noop, steer: noop, inbox: { remove: () => true }, cancel: noop, whenIdle: async () => {},
  })
  const ctx = new Context()
  const provide = (ctx as unknown as { provide(name: string, value: unknown): void }).provide.bind(ctx)
  let created = 0
  provide('agents', { get: () => undefined, create: async () => ({ agent: agent(`new-${++created}`), dispose: async () => {} }) })
  provide('attachments', {
    imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 1_000_000, maxImagesPerMessage: 8, maxMessageImageBytes: 8_000_000, maxImageDimension: 8192, maxImagePixels: 64_000_000 },
    saveImage: async (input: { data: Uint8Array }) => ({ attachmentId: 'image-1', mediaType: 'image/png', width: 1, height: 1, bytes: input.data.byteLength }),
    readImage: async () => ({ data: png }),
  })
  const raw = createChannel(ctx as never, agent('boot') as never, {
    model: MODEL_BEFORE, cwd: '/tmp/probe', provider: 'deepseek', activity: false, whale: false, whaleIdle: false,
  })
  const staged: string[] = []
  const stageImage = raw.stageComposerImage
  raw.stageComposerImage = async (input, generation) => {
    const handle = await stageImage(input, generation)
    staged.push(handle.stageId)
    return handle
  }
  const unregister = registerTuiChannel(ctx, raw)
  const mounted = mountChannelUi(ctx, raw, undefined, 'new')
  return {
    ui: mounted.channel, staged,
    get created() { return created },
    dispose() { mounted.dispose(); unregister(); raw.releaseContributions() },
  }
}
class Stdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
async function mount(fullscreen: boolean, columns: number, launchpad = false) {
  const term = new XTerm({ cols: columns, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { term.write(String(chunk), done) } }), { columns, rows: ROWS, isTTY: true })
  const stderr = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }), { isTTY: true })
  const stdin = new Stdin()
  const fixture = channelFixture()
  const controller = { current: null as PromptController | null }
  const app = await render(React.createElement(Chat, {
    channel: fixture.ui, questionStore: new QuestionStore(), fullscreen,
    launchpadOnBoot: launchpad, promptControllerRef: controller,
  }), { stdout: stdout as never, stdin: stdin as never, stderr: stderr as never, exitOnCtrlC: false, patchConsole: false })
  return { fixture, ui: fixture.ui, term, stdin, controller, unmount() { app.unmount(); fixture.dispose() } }
}
type Harness = Awaited<ReturnType<typeof mount>>
const paste = (app: Harness, text: string) => app.stdin.write(`\x1b[200~${text}\x1b[201~`)
function composer(app: Harness) {
  const rows = viewportLines(app.term)
  const bottom = rows.findLastIndex(row => row.includes('╰'))
  let top = bottom - 1
  while (top >= 0 && !rows[top]!.includes('╭')) top -= 1
  const block = rows.slice(top, bottom + 1).map(row => row.trimEnd())
  if (top < 0 || !block.some(row => row.includes('❯')) || !block.some(row => row.includes('⛶'))) return null
  // Transcript changes can move the box; compare the caret relative to it.
  return { block, caret: { x: app.term.buffer.active.cursorX, row: app.term.buffer.active.cursorY - top } }
}
const hasDraft = (app: Harness, text: string) => composer(app)?.block.join('\n').includes(text) ?? false
async function fence(app: Harness, text: string) {
  // A separate update fences effects and terminal writes from the prior frame.
  app.ui.notify(text, { timeoutMs: 0 })
  await wait(`post-update frame: ${text}`, () => screenHas(app.term, text))
}
function tokenIsChip(app: Harness) {
  const buffer = app.term.buffer.active
  const state = composer(app)
  if (state === null) return false
  const top = buffer.cursorY - state.caret.row
  for (let row = top; row < top + state.block.length; row += 1) {
    const line = buffer.getLine(buffer.baseY + row)
    const col = line?.translateToString(true).indexOf(TOKEN) ?? -1
    if (col < 0) continue
    const token = line?.getCell(col)
    const plain = line?.getCell(Math.max(0, col - 2))
    return token !== undefined && plain !== undefined && !token.isFgDefault() && token.getFgColor() !== plain.getFgColor()
  }
  return false
}
async function dashboard(app: Harness, open: boolean) {
  app.stdin.write(open ? '\x01' : '\x1b')
  await wait(open ? 'composer parked' : 'composer remounted', () => {
    const visible = viewportLines(app.term).some(line => /^\s*─+\s*子代理面板\s*─+\s*$/u.test(line))
    return visible === open && (composer(app) === null) === open
  })
}
async function chatCase(fullscreen: boolean, columns: number, parked: boolean) {
  const app = await mount(fullscreen, columns)
  const label = `${fullscreen ? 'fullscreen' : 'inline'} ${columns}, ${parked ? 'parked' : 'mounted'}`
  try {
    await wait('composer mounted', () => composer(app) !== null)
    paste(app, DRAFT)
    await wait('multiline draft painted', () => hasDraft(app, 'line-one') && hasDraft(app, 'line-two'))
    const end = app.term.buffer.active.cursorX
    for (let step = 1; step <= 3; step += 1) {
      app.stdin.write('\x1b[D')
      await wait('caret moved left', () => app.term.buffer.active.cursorX === end - step)
    }
    paste(app, imagePath)
    await wait('image staged', () => hasDraft(app, TOKEN))
    assert.equal(tokenIsChip(app), true, 'positive control for image binding')
    const images = () => app.controller.current?.previewImages?.().map(({ image, title }) => [image.id, title]) ?? []
    const refs = images()
    assert.equal(refs.length, 1)
    const stageId = app.fixture.staged[0]!
    const before = composer(app)
    await fence(app, 'CONTROL-FRAME')
    assert.deepEqual(composer(app), before, `${label}: neutral render`)
    if (parked) {
      await dashboard(app, true)
      await dashboard(app, false)
      await wait('control draft restored', () => hasDraft(app, TOKEN))
      assert.deepEqual(composer(app), before, `${label}: ordinary round trip`)
      await dashboard(app, true)
    }
    const identity = [app.ui.agentId, app.ui.sessionId, app.ui.agentBindingGeneration, app.ui.stagedImageGeneration()]
    assert.equal(await app.ui.switchModel('deepseek', MODEL_AFTER), true)
    assert.equal(app.fixture.created, 0, 'model switch never creates another agent')
    assert.deepEqual([app.ui.agentId, app.ui.sessionId, app.ui.agentBindingGeneration, app.ui.stagedImageGeneration()], identity)
    if (parked) await dashboard(app, false)
    await wait('new model painted', () => screenHas(app.term, MODEL_AFTER))
    await fence(app, 'POST-SWITCH-FRAME')
    assert.deepEqual(composer(app), before, `${label}: text and caret survive`)
    assert.deepEqual(images(), refs, 'draft keeps its original image capability')
    assert.equal(app.ui.hasStagedImage(stageId), true)
    assert.equal(tokenIsChip(app), true, 'image remains bound after model switch')
    if (fullscreen && columns === 48 && parked) console.log(composer(app)?.block.join('\n'))
    if (parked) await dashboard(app, true)
    assert.equal(await app.ui.newSession(), true)
    if (parked) await dashboard(app, false)
    await fence(app, 'POST-NEW-FRAME')
    assert.notEqual(app.ui.agentId, identity[0])
    await wait('replacement clears the draft', () => composer(app) !== null
      && app.controller.current?.text?.() === '' && !hasDraft(app, TOKEN))
    assert.equal(app.ui.hasStagedImage(stageId), false, 'new conversation revokes old images')
  } finally { app.unmount() }
}
function launchpadDraft(app: Harness) {
  const row = viewportLines(app.term).find(line => line.includes('❯'))
  if (row === undefined) return null
  const text = row.slice(row.indexOf('❯') + 1).replace(/│\s*$/u, '').trim()
  return text.startsWith(t('launchpad-placeholder')) ? '' : text
}
async function launchpadCase(fullscreen: boolean, columns: number) {
  const app = await mount(fullscreen, columns, true)
  try {
    await wait('launchpad mounted', () => screenHas(app.term, t('launchpad-placeholder')))
    paste(app, 'launch-draft-keep')
    await wait('launchpad draft painted', () => launchpadDraft(app) === 'launch-draft-keep')
    const beforeCaret = { x: app.term.buffer.active.cursorX, y: app.term.buffer.active.cursorY }
    assert.equal(await app.ui.switchModel('deepseek', MODEL_AFTER), true)
    await wait('new launchpad model painted', () => screenHas(app.term, MODEL_AFTER))
    await fence(app, 'LAUNCHPAD-SWITCH-FRAME')
    assert.equal(launchpadDraft(app), 'launch-draft-keep')
    assert.deepEqual({ x: app.term.buffer.active.cursorX, y: app.term.buffer.active.cursorY }, beforeCaret)
    assert.equal(app.fixture.created, 0)
    assert.equal(await app.ui.newSession(), true)
    await fence(app, 'LAUNCHPAD-NEW-FRAME')
    await wait('replacement keeps launchpad input mounted', () => launchpadDraft(app) !== null)
    await wait('replacement clears launchpad draft', () => launchpadDraft(app) === '')
    assert.equal(composer(app), null, 'launchpad stays open')
  } finally { app.unmount() }
}
const scenarios = [
  { id: 'A', name: 'mounted draft', run: chatCase, parked: false },
  { id: 'B', name: 'launchpad draft', run: launchpadCase, parked: false },
  { id: 'G', name: 'parked draft', run: chatCase, parked: true },
]
try {
  const selected = (process.env.VERIFY_DRAFT_SWITCH_SCENARIOS ?? '').split(',').map(id => id.trim().toUpperCase()).filter(Boolean)
  assert.ok(selected.every(id => scenarios.some(test => test.id === id)), 'unknown scenario selection')
  for (const test of scenarios.filter(test => selected.length === 0 || selected.includes(test.id))) {
    try {
      for (const fullscreen of [false, true]) {
        for (const columns of [100, 48]) await test.run(fullscreen, columns, test.parked)
      }
      console.log(`PASS ${test.id}: ${test.name} in both terminal modes and widths`)
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
