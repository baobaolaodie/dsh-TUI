#!/usr/bin/env node
/**
 * verify-composer-draft-model-switch — a MODEL SWITCH keeps the unsent draft.
 *
 * `/model` FORKS the conversation, so the channel adopts a new agent and
 * `channel.agentId` changes. Both draft clear points in `Chat.tsx` fire on that
 * change — the composer's session-swap layout effect (`draftSessionRef`) and the
 * launchpad's `[channel, agentId, bindingGeneration]` effect — and neither can
 * tell "this adoption continued the conversation" from "this adoption replaced
 * it". Switching a model therefore throws the half-written prompt away exactly
 * like `/new` does (issue #1455).
 *
 * The behaviour under test is the fix's ONE read-only UI fact:
 * `channel.continuedFromAgentId` — "which agent id this binding continued from",
 * written only by the model-switch adoption and reset by every other adoption
 * through the shared `resetSessionProjection`. Each clear point skips its wipe
 * when that fact names the agent the screen was last rendered against; a real
 * replacement carries `undefined` and clears exactly as it does today.
 *
 * Scenarios (env `VERIFY_DRAFT_SWITCH_SCENARIOS=A,B`; unset runs all):
 *   A  chat page — text + caret survive a continuation switch verbatim
 *   B  launchpad — the draft survives AND the parameter row shows the new model
 *   C  replacement — a bare `agentId` change still clears (both screens, plus a
 *      stub that lacks the property entirely) = today's behaviour
 *   D  action layer — `createModelSwitchAction` writes the fact for the agent
 *      the binding came FROM, and `resetSessionProjection` clears it again
 *   E  images — a visible `[Image #N]` stays as text while its old capability
 *      stops being bound (`hasStagedImage` false)
 *
 * A/B/D/E are RED until the implementation lands; C pins existing behaviour and
 * passes on the pre-fix tree. That split is the point of this file: the RED run
 * is the evidence that the new assertions have discriminating power.
 *
 * Drives the REAL `Chat` (+ `PromptInput` / `Launchpad`) through fake stdin and a
 * headless xterm, like `verify-composer-draft-screen-switch.tsx`. Waits go
 * through `scripts/lib/term-test.mjs` (`settled`), and every switch is observed
 * through a transcript/parameter-row anchor so an assertion can never pass
 * before the commit that carried the switch.
 *
 * Run from the checkout root:
 *   node --import tsx/esm scripts/verify-composer-draft-model-switch.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const { existsSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
// L-055: i18n, the preference files and the session ledger resolve their data
// dir at import time, so the throwaway home must exist BEFORE any `src/` import.
const home = mkdtempSync(join(tmpdir(), 'dsh-tui-draft-model-switch-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = join(home, 'dsh')
// The composer's staged-image chip colour is part of scenario E; the
// terminal-image renderer itself is irrelevant here (and wants a real TTY).
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'
/** A real on-disk 1x1 PNG: `parsePastedImagePath` stats the path, the channel
 *  stub stages the bytes; nothing decodes the pixels. */
const pastedImagePath = join(home, 'draft-probe.png')
writeFileSync(
  pastedImagePath,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)

const [
  { PassThrough, Writable },
  { default: React },
  { Terminal: XTerm },
  { render },
  { Chat },
  { QuestionStore },
  { LOCAL_COMMANDS, completeCommands },
  { settled, viewportLines },
  { createModelSwitchAction },
  { resetSessionProjection },
  { setLang, t },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('./lib/term-test.mjs'),
  import('../src/dsh-adapter/channel/model-switch.js'),
  import('../src/dsh-adapter/channel/session-reset.js'),
  import('../src/i18n.js'),
])
// The script runs in zh (see `DSH_TUI_LANG` above). Set it explicitly rather
// than trusting the import-time detection: the one dictionary string read below
// decides whether the launchpad input is empty.
setLang('zh')

const COLS = 100
const ROWS = 36
/** The launchpad needs the room its own regression gives it (the parameter row
 *  and the entry chips share one screen). */
const LAUNCHPAD_COLS = 120
const BRACKET_PASTE_START = '\x1b[200~'
const BRACKET_PASTE_END = '\x1b[201~'
const ARROW_LEFT = '\x1b[D'
/** The draft the chat-page scenarios type: two lines (< FOLD_MIN_LINES, so it
 *  stays inline) and a caret that can sit in the middle of the second one. */
const DRAFT_TEXT = 'line-one\nline-two'
const STAGED_IMAGE_TOKEN = '[Image #1]'
/** Short model names keep the launchpad parameter row in its FIT tier — a
 *  truncated `…` would make the "row shows the new model" anchor ambiguous. */
const MODEL_BEFORE = 'probe-model-a'
const MODEL_AFTER = 'probe-model-b'
const AGENT_BEFORE = 'probe-agent'
const AGENT_AFTER = 'probe-agent-continued'
const LAUNCHPAD_PLACEHOLDER = t('launchpad-placeholder')
/** Ceiling for a mount, a first paint or a whole switch round trip. Generous so
 *  a loaded shared runner cannot make a correct build look broken. */
const RENDER_TIMEOUT_MS = 8000
/** Ceiling for a state a commit is expected to reach right away. */
const SETTLE_TIMEOUT_MS = 4000
/**
 * Renderer errors (`logError` -> `process.stderr` with a `[dsh-tui]` prefix) are
 * collected instead of swallowed: an error inside a scenario must fail the run
 * even when the screen happens to recover. React's own dev warnings are
 * forwarded but not triaged — the assertions here never depend on them.
 */
const runtimeErrors: string[] = []
const realStderrWrite = process.stderr.write.bind(process.stderr)
;(process.stderr as { write: (...args: unknown[]) => unknown }).write = ((
  chunk: unknown,
  ...rest: unknown[]
) => {
  const text = typeof chunk === 'string' ? chunk : String(chunk)
  if (text.includes('[dsh-tui]')) runtimeErrors.push(text.trim())
  return (realStderrWrite as (...args: unknown[]) => unknown)(chunk, ...rest)
}) as typeof process.stderr.write

class VerifyFailure extends Error {
  readonly scenario: string
  readonly detail: string
  readonly expected: unknown
  readonly actual: unknown

  constructor(scenario: string, detail: string, expected: unknown, actual: unknown) {
    super(`${scenario}: ${detail}`)
    this.name = 'VerifyFailure'
    this.scenario = scenario
    this.detail = detail
    this.expected = expected
    this.actual = actual
  }
}

function assertTrue(scenario: string, detail: string, actual: unknown): void {
  if (actual !== true) throw new VerifyFailure(scenario, detail, true, actual)
}

function assertEqual(scenario: string, detail: string, expected: unknown, actual: unknown): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new VerifyFailure(scenario, detail, expected, actual)
  }
}

/** Wait for a predicate that must eventually hold; timeout = hard failure. */
async function waitFor(
  scenario: string,
  what: string,
  pred: () => boolean,
  timeoutMs?: number,
): Promise<void> {
  const ok = await settled(pred, timeoutMs === undefined ? {} : { timeoutMs })
  if (!ok) throw new VerifyFailure(scenario, `timeout waiting for ${what}`, true, false)
}

interface StubStagedImage {
  readonly id: string
  readonly path: string
}

interface StubRow {
  readonly id: number
  readonly kind: 'user'
  readonly text: string
}

/** Stable references: a fresh `[]`/callback per render would make Chat's
 *  `useSyncExternalStore` loop on unchanged snapshots. */
const EMPTY_LIST: readonly never[] = Object.freeze([])
const noopUnsubscribe = (): (() => void) => () => {}

/**
 * Stub channel: the seams the Chat tree needs plus the session identity the
 * model switch moves. Mutable slices are getters over `state` so a scenario can
 * mutate them and `bump()` exactly like the real channel's adoption transaction.
 *
 * `continuedFromAgentId` is mirrored here the way the fix declares it in
 * `ChannelUi`: a FLAT field on the channel view itself (present, `undefined` by
 * default) and NOT only a slice of the internal `state` bag — `Chat.tsx` reads
 * `channel.continuedFromAgentId` at both clear points, so a stub that keeps the
 * fact one level down leaves the exemption permanently undefined and makes the
 * assertions below fail for a reason that has nothing to do with the fix (T01
 * rework, L-044/L-052). `makeChannel({ legacy: true })` deletes it again to
 * model a stub / older host that never heard of the property (AC-6).
 */
function makeChannel(options: { legacy?: boolean } = {}) {
  const listeners = new Set<() => void>()
  const state = {
    agentBindingGeneration: 0,
    /** Staged-image session epoch, mirroring the real channel: it advances
     *  whenever the capability map is cleared (`composer-images.ts:131-155`). */
    stagedImageEpoch: 0,
    staged: new Map<string, StubStagedImage>(),
    discarded: [] as string[],
    nextStage: 1,
    nextRow: 2,
    rows: [{ id: 1, kind: 'user' as const, text: 'probe transcript row' }] as StubRow[],
    submitted: [] as Array<{ text: string; images: readonly unknown[] }>,
    clearCalls: 0,
    notifyLog: [] as string[],
    subagents: EMPTY_LIST,
    /** The fact under test: which agent id this binding continued from. */
    continuedFromAgentId: undefined as string | undefined,
  }
  const channel = {
    whaleIdle: false,
    version: 0,
    status: 'idle' as const,
    sessionTitle: 'probe',
    agentId: AGENT_BEFORE,
    sessionId: 'probe-session',
    model: MODEL_BEFORE,
    modelDisplay: undefined as string | undefined,
    provider: 'deepseek',
    reasoningEffort: 'max',
    effortLevels: [] as string[],
    tokens: { input: 0, output: 0 },
    cwd: '/tmp/demo',
    displayCwd: '/tmp/demo',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    pending: [] as unknown[],
    commandList: LOCAL_COMMANDS,
    notifications: [] as unknown[],
    mode: { plan: false, sandbox: undefined },
    activityFrames: 'moon8',
    agentPreset: undefined,
    lastUserText: '',
    scrollGutter: 'timeline',
    state,
    get rows() {
      return state.rows
    },
    get agentBindingGeneration() {
      return state.agentBindingGeneration
    },
    get subagents() {
      return state.subagents
    },
    get backgroundJobs() {
      return EMPTY_LIST
    },
    /** The fact under test, on the SAME flat surface the real view exposes it on
     *  (`ChannelUi.continuedFromAgentId` -> `Chat.tsx:791` / `Chat.tsx:2032`).
     *  Every `state.continuedFromAgentId` write below is therefore readable by
     *  the UI, and the `legacy` delete really removes a property that existed. */
    get continuedFromAgentId(): string | undefined {
      return state.continuedFromAgentId
    },
    subscribe(cb: () => void) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    bump() {
      channel.version += 1
      for (const cb of listeners) cb()
    },
    submit(text: string, images: readonly unknown[] = []) {
      state.submitted.push({ text, images })
    },
    cancel: () => {},
    clear() {
      state.clearCalls += 1
    },
    notify: (message: string) => {
      state.notifyLog.push(String(message))
    },
    listModels: () => Promise.resolve([]),
    listSessions: () => Promise.resolve([]),
    deleteSession: () => Promise.resolve(true),
    renameSessionTo: () => Promise.resolve(true),
    setResumeTarget: () => {},
    loadOlder: () => {},
    mcpStatus: () => EMPTY_LIST,
    pushLocal: () => {},
    commandCompletions: (input: string) => completeCommands(input),
    stagedImageGeneration: () => state.stagedImageEpoch,
    stagedImage: (stageId: string) => state.staged.get(stageId),
    hasStagedImage: (stageId: string) => state.staged.has(stageId),
    discardStagedImage: (stageId: string) => {
      state.discarded.push(stageId)
      state.staged.delete(stageId)
    },
    stagedImageLimits: () => ({
      maxImageBytes: 1_000_000,
      maxImagesPerMessage: 8,
      maxImageDimension: 8192,
      maxImagePixels: 64_000_000,
    }),
    stageComposerImage: async () => {
      const stageId = `stage-${state.nextStage++}`
      state.staged.set(stageId, { id: stageId, path: pastedImagePath })
      return { stageId }
    },
    previewImages: () => EMPTY_LIST,
    subagentControl: { interrupt: () => {} },
    backgroundCurrent: async () => ({ ok: true, backgroundedSessionId: 'probe' }),
    agentViewRows: () => EMPTY_LIST,
    subscribeAgentView: noopUnsubscribe,
    settingsHost: () => undefined,
    settingsSections: () => EMPTY_LIST,
    subscribeSettingsSections: noopUnsubscribe,
    buildSessionTree: () => new Promise<null>(() => {}),
    // The launchpad reads these two: the preset roster names the parameter row's
    // preset segment, the permission snapshot its permission segment. An empty
    // roster / unavailable roster keeps the row to `model  ·  Max`, which is
    // exactly the anchor scenario B waits on.
    listPresets: () => Promise.resolve([]),
    permissionPresets: () => ({ availability: 'unavailable' as const, current: undefined }),
  }
  if (options.legacy === true) delete (channel as unknown as Record<string, unknown>)['continuedFromAgentId']
  return channel
}

interface Harness {
  term: InstanceType<typeof XTerm>
  stdin: InstanceType<typeof PassThrough>
  channel: ReturnType<typeof makeChannel>
  unmount: () => void
}

async function mountChat(options: { launchpad?: boolean; legacyChannel?: boolean } = {}): Promise<Harness> {
  const cols = options.launchpad === true ? LAUNCHPAD_COLS : COLS
  const term = new XTerm({ cols, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
      // L-034: xterm's write() queues asynchronously — the buffer only reflects
      // the frame once this callback fires, which is why every read below goes
      // through a polling predicate instead of a bare synchronous read.
      term.write(String(chunk), callback)
    }
  }
  class FakeStderr extends Writable {
    isTTY = true
    _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
      callback()
    }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() {
      return this
    }
    ref() {
      return this
    }
    unref() {
      return this
    }
  }
  const stdin = new FakeStdin()
  const stdout = new FakeStdout()
  const stderr = new FakeStderr()
  const questions = new QuestionStore()
  const channel = makeChannel({ legacy: options.legacyChannel === true })
  const chatNode = React.createElement(Chat, {
    channel,
    questionStore: questions,
    // fullscreen: true keeps the launchpad and the conversation on the SAME
    // plain screen (no alternate-screen wrapper) so both scenarios read one
    // viewport helper set.
    fullscreen: true,
    launchpadOnBoot: options.launchpad === true,
  })
  const instance = await render(
    chatNode,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  let unmounted = false
  return {
    term,
    stdin,
    channel,
    unmount: () => {
      if (unmounted) return
      unmounted = true
      instance.unmount()
    },
  }
}

const screen = (app: Harness): string[] => viewportLines(app.term, ROWS)
const screenHas = (app: Harness, text: string): boolean => screen(app).some(line => line.includes(text))

function inputRange(app: Harness): { top: number; bottom: number } | null {
  const rows = screen(app)
  let bottom = -1
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].includes('╰')) {
      bottom = i
      break
    }
  }
  if (bottom < 0) return null
  for (let i = bottom - 1; i >= 0; i -= 1) {
    if (rows[i].includes('╭')) return { top: i, bottom }
  }
  return null
}

/** The composer box: top border, content row(s), bottom border. Comparing this
 *  slice before/after a switch is the text + newline-structure assertion; the
 *  transcript outside it is not part of the draft. Trailing cell padding is
 *  stripped (a renderer frame artifact), the borders stay full width. */
function inputBlock(app: Harness): string[] | null {
  const range = inputRange(app)
  if (range === null) return null
  return screen(app).slice(range.top, range.bottom + 1).map(row => row.trimEnd())
}

/** True only for the MAIN composer box: the `❯` prompt glyph and the `⛶`
 *  affordance both have to be inside the same `╭ ╰` box (the launchpad draws a
 *  round box of its own, but has no `⛶`). */
function composerMounted(app: Harness): boolean {
  const block = inputBlock(app)
  return block !== null
    && block.some(line => line.includes('❯'))
    && block.some(line => line.includes('⛶'))
}

function composerBlock(app: Harness): string[] | null {
  return composerMounted(app) ? inputBlock(app) : null
}

function composerHas(app: Harness, text: string): boolean {
  return composerBlock(app)?.join('\n').includes(text) ?? false
}

function cursorPos(app: Harness): { x: number; y: number } {
  const buffer = app.term.buffer.active
  return { x: buffer.cursorX, y: buffer.cursorY }
}

interface ScreenState {
  block: string[] | null
  /**
   * The caret, measured RELATIVE to the composer block's top border. A
   * transcript row landing above the composer shifts the whole box down the
   * screen, and that shift says nothing about the draft; the offset inside the
   * box is what "the caret did not move" means.
   */
  caret: { x: number; row: number } | null
}

function composerState(app: Harness): ScreenState {
  const range = inputRange(app)
  if (range === null || !composerMounted(app)) return { block: null, caret: null }
  const cursor = cursorPos(app)
  return {
    block: screen(app).slice(range.top, range.bottom + 1).map(row => row.trimEnd()),
    caret: { x: cursor.x, row: cursor.y - range.top },
  }
}

function assertSameComposerState(
  scenario: string,
  label: string,
  before: ScreenState,
  after: ScreenState,
): void {
  assertEqual(scenario, `${label}: composer block`, before.block, after.block)
  assertEqual(scenario, `${label}: caret`, before.caret, after.caret)
}

/** A staged token is a capability-backed chip (theme accent), not plain text —
 *  scenario E uses it to show the OLD capability stopped being bound. Mirrors
 *  `verify-composer-image-tokens`' colour probe. */
function tokenIsChip(app: Harness, token: string): { ok: boolean; detail: string } {
  const buffer = app.term.buffer.active
  for (let row = 0; row < ROWS; row += 1) {
    const line = buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? ''
    const col = line.indexOf(token)
    if (col < 0) continue
    const cell = buffer.getLine(buffer.baseY + row)?.getCell(col)
    const plain = buffer.getLine(buffer.baseY + row)?.getCell(Math.max(0, col - 2))
    const ok = cell !== undefined && plain !== undefined
      && !cell.isFgDefault() && cell.getFgColor() !== plain.getFgColor()
    return { ok, detail: `row=${row} col=${col} tokenFg=${String(cell?.getFgColor())} plainFg=${String(plain?.getFgColor())}` }
  }
  return { ok: false, detail: 'token not visible' }
}

/** The launchpad's input row: its card is the only `❯` on screen (the entry
 *  chips carry no pointer glyph, and the main composer is not rendered). */
function launchpadInputRow(app: Harness): string {
  return screen(app).find(line => line.includes('❯')) ?? ''
}

/** What the user typed in the launchpad input: the cells between the `❯` prompt
 *  and the card's right border, with the placeholder read as "empty" (the
 *  placeholder is chrome, not a draft). */
function launchpadDraftText(app: Harness): string {
  const row = launchpadInputRow(app)
  const at = row.indexOf('❯')
  if (at < 0) return ''
  const rest = row.slice(at + 1)
  const border = rest.lastIndexOf('│')
  const text = (border < 0 ? rest : rest.slice(0, border)).trim()
  return text.startsWith(LAUNCHPAD_PLACEHOLDER) ? '' : text
}

/** The launchpad parameter row (`模型  ·  思考深度  ·  preset  ·  权限`): the
 *  LAST `·`-separated row, because a picker overlay stacked above it may use the
 *  same separator. */
function launchpadParamRow(app: Harness): string {
  const rows = screen(app)
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].includes('  ·  ')) return rows[i]
  }
  return ''
}

/** Bracketed paste: commits a whole string — newlines included — as ONE key
 *  event, which is the deterministic way to seed a multi-line draft. */
function pasteText(app: Harness, text: string): void {
  app.stdin.write(`${BRACKET_PASTE_START}${text}${BRACKET_PASTE_END}`)
}

/**
 * A model switch as the production channel emits it: the continuation fact is
 * written BEFORE the new identity (the adoption tail resets the projection,
 * writes the fact, then swaps `agentId`/`sessionId`/`model`, then emits once).
 *
 * `anchor` is a transcript change that lands in the SAME mutation. Every
 * scenario waits for that anchor, because "the draft is still there" is also
 * true BEFORE the commit — an assertion that ran early would pass on a broken
 * build.
 */
function emitModelSwitch(
  app: Harness,
  next: { agentId: string; model: string; continued: boolean; dropImages?: boolean; anchor: string },
): void {
  const { channel } = app
  const { state } = channel
  state.continuedFromAgentId = next.continued ? channel.agentId : undefined
  channel.agentId = next.agentId
  channel.model = next.model
  if (next.dropImages === true) {
    // The real transaction revokes every staged capability (`clearStagedImages`)
    // and advances the epoch the composer fences its bindings against.
    state.staged.clear()
    state.stagedImageEpoch += 1
  }
  emitRenderAnchor(app, next.anchor)
}

/** Wait until a later render proves the switch commit landed. */
async function waitForSwitchCommit(scenario: string, app: Harness, anchor: string): Promise<void> {
  await waitFor(scenario, `the render that carried the switch (anchor ${JSON.stringify(anchor)})`,
    () => screenHas(app, anchor))
}

/**
 * Land `anchor` in the transcript as the observable that a new render committed.
 *
 * The composer is compared by its BLOCK plus the caret's position RELATIVE to
 * that block (see {@link composerState}), so the one thing this anchor must not
 * do is touch the draft itself — a transcript row above it may shift the whole
 * box down without that being a draft change.
 */
function emitRenderAnchor(app: Harness, anchor: string): void {
  const { channel } = app
  channel.state.rows.push({ id: channel.state.nextRow++, kind: 'user', text: anchor })
  channel.bump()
}

/** Type one chat draft and park the caret three cells into its second line. */
async function typeChatDraft(scenario: string, app: Harness): Promise<ScreenState> {
  await waitFor(scenario, 'composer to mount', () => composerMounted(app), RENDER_TIMEOUT_MS)
  pasteText(app, DRAFT_TEXT)
  await waitFor(
    scenario,
    'both draft lines inside the composer box',
    () => composerHas(app, 'line-one') && composerHas(app, 'line-two'),
    RENDER_TIMEOUT_MS,
  )
  const endCaret = cursorPos(app)
  for (let step = 1; step <= 3; step += 1) {
    app.stdin.write(ARROW_LEFT)
    const want = endCaret.x - step
    await waitFor(scenario, `the caret to move left (${step}/3)`, () => cursorPos(app).x === want)
  }
  return composerState(app)
}

/** ── A · chat page: a continuation switch keeps text + caret verbatim ────── */
async function scenarioChatContinuation(): Promise<void> {
  const scenario = 'A'
  const app = await mountChat()
  try {
    const before = await typeChatDraft(scenario, app)
    // Positive control: the comparison below is evidence only if it HOLDS across
    // a re-render that changes no identity — otherwise a failure after the
    // switch could as well be the comparison itself (L-044/L-048).
    emitRenderAnchor(app, 'CONTROL-ANCHOR-A')
    await waitForSwitchCommit(scenario, app, 'CONTROL-ANCHOR-A')
    assertSameComposerState(scenario, 'control: a neutral re-render', before, composerState(app))
    emitModelSwitch(app, {
      agentId: AGENT_AFTER,
      model: MODEL_AFTER,
      continued: true,
      anchor: 'SWITCH-ANCHOR-A',
    })
    await waitForSwitchCommit(scenario, app, 'SWITCH-ANCHOR-A')
    assertTrue(
      scenario,
      'a continuation model switch must keep the draft (today the composer clear point wipes it)',
      composerHas(app, 'line-two'),
    )
    assertSameComposerState(scenario, 'continuation model switch', before, composerState(app))
  } finally {
    app.unmount()
  }
}

/** ── B · launchpad: a continuation switch keeps the draft, row updates ───── */
async function scenarioLaunchpadContinuation(): Promise<void> {
  const scenario = 'B'
  const app = await mountChat({ launchpad: true })
  try {
    await waitFor(scenario, 'launchpad to paint', () => screenHas(app, LAUNCHPAD_PLACEHOLDER), RENDER_TIMEOUT_MS)
    const draft = 'launch-draft-keep'
    let typed = ''
    for (const character of draft) {
      app.stdin.write(character)
      typed += character
      const want = typed
      await waitFor(scenario, `launchpad input to show ${JSON.stringify(want)}`,
        () => launchpadDraftText(app) === want)
    }
    assertTrue(scenario, 'parameter row shows the boot model', launchpadParamRow(app).includes(MODEL_BEFORE))

    emitModelSwitch(app, {
      agentId: AGENT_AFTER,
      model: MODEL_AFTER,
      continued: true,
      anchor: 'SWITCH-ANCHOR-B',
    })
    // The launchpad's clear point is a PASSIVE effect, so the frame that carried
    // the switch does not prove it ran. Force one more render (same agentId, so
    // the effect cannot re-run) and wait for THAT frame: React flushes a pending
    // passive effect before the next commit, so the draft's fate is sealed by
    // the time this returns — an assertion before it would be vacuous.
    await waitFor(scenario, 'the parameter row to show the new model',
      () => launchpadParamRow(app).includes(MODEL_AFTER), RENDER_TIMEOUT_MS)
    app.channel.model = `${MODEL_AFTER}-tick`
    app.channel.bump()
    await waitFor(scenario, 'a later frame after the switch',
      () => launchpadParamRow(app).includes(`${MODEL_AFTER}-tick`), RENDER_TIMEOUT_MS)

    assertTrue(
      scenario,
      'a continuation model switch must keep the launchpad draft (today its effect clears it)',
      launchpadDraftText(app) === draft,
    )
    // "The launchpad is still up" cannot be anchored on LAUNCHPAD_PLACEHOLDER:
    // the placeholder is drawn only while the input is EMPTY, so that assertion
    // held exactly when the draft was wiped — the opposite of this scenario's
    // point (T01 rework, L-044). The input row is the anchor that survives a
    // non-empty draft, but on its own it would merely restate a sub-expression
    // of the draft assertion above (`launchpadDraftText` returns `''` when there
    // is no `❯` row, so a non-empty draft already proves the row is there). The
    // second conjunct is what "still up" adds: the switch did not fall back to
    // the conversation view, whose composer is the only other `⛶`-bearing box
    // (`⛶` lives only in `PromptInput.tsx`).
    assertTrue(
      scenario,
      'the launchpad is still up after the switch (the conversation composer did not take over)',
      launchpadInputRow(app).includes('❯') && !composerMounted(app),
    )
  } finally {
    app.unmount()
  }
}

/** ── C · replacement: a bare agentId change clears, exactly as today ─────── */
async function scenarioReplacementClears(): Promise<void> {
  const scenario = 'C'
  // C1 — chat page, the field present but undefined.
  {
    const app = await mountChat()
    try {
      await typeChatDraft(scenario, app)
      emitModelSwitch(app, {
        agentId: 'other-agent',
        model: MODEL_AFTER,
        continued: false,
        anchor: 'SWITCH-ANCHOR-C1',
      })
      await waitForSwitchCommit(scenario, app, 'SWITCH-ANCHOR-C1')
      const cleared = await settled(() => !composerHas(app, 'line-two'), { timeoutMs: SETTLE_TIMEOUT_MS })
      assertTrue(scenario, 'a replaced conversation must drop its draft (chat page)', cleared)
    } finally {
      app.unmount()
    }
  }
  // C2 — launchpad, the field present but undefined.
  {
    const app = await mountChat({ launchpad: true })
    try {
      await waitFor(scenario, 'launchpad to paint', () => screenHas(app, LAUNCHPAD_PLACEHOLDER), RENDER_TIMEOUT_MS)
      pasteText(app, 'launchpad-draft')
      await waitFor(scenario, 'launchpad draft committed', () => launchpadDraftText(app) === 'launchpad-draft')
      emitModelSwitch(app, {
        agentId: 'other-agent',
        model: MODEL_AFTER,
        continued: false,
        anchor: 'SWITCH-ANCHOR-C2',
      })
      await waitFor(scenario, 'the parameter row to show the new model',
        () => launchpadParamRow(app).includes(MODEL_AFTER), RENDER_TIMEOUT_MS)
      // Same passive-effect fence as scenario B.
      app.channel.model = `${MODEL_AFTER}-tick`
      app.channel.bump()
      await waitFor(scenario, 'a later frame after the switch',
        () => launchpadParamRow(app).includes(`${MODEL_AFTER}-tick`), RENDER_TIMEOUT_MS)
      const cleared = await settled(() => launchpadDraftText(app) === '', { timeoutMs: SETTLE_TIMEOUT_MS })
      assertTrue(scenario, 'a replaced conversation must drop its draft (launchpad)', cleared)
    } finally {
      app.unmount()
    }
  }
  // C3 — a stub that never heard of the property at all (AC-6): behaviour must
  // be identical, and the stub is asserted to really lack it.
  {
    const app = await mountChat({ legacyChannel: true })
    try {
      assertEqual(scenario, 'the legacy stub really lacks the property', false,
        'continuedFromAgentId' in (app.channel as unknown as Record<string, unknown>))
      await typeChatDraft(scenario, app)
      emitModelSwitch(app, {
        agentId: 'other-agent',
        model: MODEL_AFTER,
        continued: false,
        anchor: 'SWITCH-ANCHOR-C3',
      })
      await waitForSwitchCommit(scenario, app, 'SWITCH-ANCHOR-C3')
      const cleared = await settled(() => !composerHas(app, 'line-two'), { timeoutMs: SETTLE_TIMEOUT_MS })
      assertTrue(scenario, 'a channel without the property must still clear the draft', cleared)
    } finally {
      app.unmount()
    }
  }
}

/** ── D · action layer: the fact is written by the switch, cleared by reset ─ */
async function scenarioActionFactSource(): Promise<void> {
  const scenario = 'D'
  const OLD_AGENT_ID = 'old-agent-id'
  const NEW_AGENT_ID = 'new-agent-id'
  const oldSessionStub = { seq: 0, events: [], header: {} }
  const handle = {
    agent: {
      id: NEW_AGENT_ID,
      session: { id: 'new-session-id', seq: 0, events: [], header: {} },
      status: 'idle' as const,
    },
    dispose: async () => {},
  }
  const replayLog: unknown[] = []
  const notifications: string[] = []
  const state = {
    rows: [] as unknown[],
    todos: [] as unknown[],
    pending: [] as unknown[],
    goal: undefined as unknown,
    sessionTitle: '',
    sessionColor: '',
    tokens: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    mainCost: {} as Record<string, unknown>,
    subagentCost: [] as unknown[],
    responseChars: 0,
    activeToolCount: 0,
    lastUserText: '',
    working: false,
    compaction: undefined as unknown,
    cancelPending: false,
    spinnerMode: 'requesting',
    tps: undefined as unknown,
    tpsSamples: [] as unknown[],
    lastUsage: undefined as unknown,
    turnUsage: undefined as unknown,
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    costReport: undefined as unknown,
    attachedContexts: [] as unknown[],
    // SwitchState extras
    cwd: '/tmp/probe',
    status: 'idle' as const,
    agentId: OLD_AGENT_ID,
    sessionId: 'old-session-id',
    agentPreset: undefined as string | undefined,
    provider: 'deepseek',
    model: MODEL_BEFORE,
    contextWindow: undefined as number | undefined,
    effortLevels: undefined as string[] | undefined,
    reasoningEffort: undefined as string | undefined,
    emit: () => { emits += 1 },
    // The fact under test. Declared here (as `ChannelUi` will declare it) so the
    // assertion reads a real property instead of inventing one.
    continuedFromAgentId: undefined as string | undefined,
  }
  let emits = 0
  const capture = { agent: { session: oldSessionStub }, generation: 0 }
  const binding = {
    agent: { id: OLD_AGENT_ID, session: oldSessionStub },
    session: oldSessionStub,
    capture: () => capture,
    prepare: async (_capture: unknown, factory: () => Promise<unknown>) => await factory(),
    isCurrent: () => true,
    abandon: async () => {},
    adopt: <T,>(
      _candidate: unknown,
      _capture: unknown,
      tail: (previous: unknown, dispose: (next: string) => void) => T,
    ): T => {
      // The transaction hands the tail the binding it is REPLACING — the agent
      // the continuation fact must name (see DESIGN D2).
      const previous = { session: oldSessionStub, agent: binding.agent, handle: undefined, generation: 0 }
      return tail(previous, () => {})
    },
  }
  const ctx = {
    get: (name: string) => name === 'agents' ? { create: async () => handle } : undefined,
    on: () => () => {},
    logger: { warn: () => {} },
  }
  const rowIds = { value: 0 }
  const switchModel = createModelSwitchAction(
    ctx as never,
    state as never,
    {
      owner: { current: () => true },
      binding: binding as never,
      rowIds,
      settleCompaction: async () => {},
      resetProjector: () => {},
      resetSubagents: () => {},
      resetJobs: () => {},
      replay: (events: readonly unknown[]) => { replayLog.push(events) },
      settleReplay: () => {},
      bindAgent: () => {},
      refreshCommands: () => {},
      refreshLoadedContext: async () => {},
      refreshSkillCommands: async () => {},
      clearStagedImages: () => {},
      dropModelCompletion: () => {},
      notify: (text: string) => { notifications.push(text) },
    } as never,
  )

  const committed = await switchModel('deepseek', MODEL_AFTER)
  assertEqual(scenario, 'the model switch reports success', true, committed)
  assertEqual(scenario, 'the switch adopted the new agent', NEW_AGENT_ID, state.agentId)
  assertEqual(
    scenario,
    'a successful model switch records the agent the binding continued from '
      + '(today the fact does not exist, so this is undefined)',
    OLD_AGENT_ID,
    state.continuedFromAgentId,
  )
  // The message promises ONCE, so the predicate has to be `=== 1` too: `> 0`
  // would also accept a switch that double-emits. `model-switch.ts:122` is the
  // adoption transaction's only `state.emit()` and `resetSessionProjection`
  // emits nothing, so exactly one is the fact.
  assertEqual(scenario, 'the switch emitted exactly once', 1, emits)
  // L-049 / L-055: `DATA_DIR` is a module-level constant resolved at import
  // time, so "this run was isolated" has to be EVIDENCED, not assumed — the
  // transaction's own side effects (`touchSession`, `writeModelPref`) must have
  // landed in the throwaway home. A cold pair here would mean the real
  // `~/.dsh-tui` was written instead.
  assertTrue(
    scenario,
    'the switch wrote its preferences into the throwaway home (isolation evidenced)',
    existsSync(join(home, '.dsh-tui', 'last-used.json')) && existsSync(join(home, '.dsh-tui', 'model.json')),
  )

  resetSessionProjection(
    state as never,
    rowIds,
    () => {},
    () => {},
    () => {},
  )
  assertEqual(
    scenario,
    'resetSessionProjection (the shared adoption reset) clears the continuation fact',
    undefined,
    state.continuedFromAgentId,
  )
}

/** ── E · images: the visible token stays, the old capability is not bound ── */
async function scenarioImageTokenDegrades(): Promise<void> {
  const scenario = 'E'
  const app = await mountChat()
  try {
    await waitFor(scenario, 'composer to mount', () => composerMounted(app), RENDER_TIMEOUT_MS)
    app.stdin.write('caption ')
    await waitFor(scenario, 'caption text before the paste', () => composerHas(app, 'caption'))
    pasteText(app, pastedImagePath)
    await waitFor(scenario, 'the staged image token', () => composerHas(app, STAGED_IMAGE_TOKEN), RENDER_TIMEOUT_MS)
    const stageId = [...app.channel.state.staged.keys()].at(-1)!
    assertTrue(scenario, 'the capability is live before the switch', app.channel.hasStagedImage(stageId))

    emitModelSwitch(app, {
      agentId: AGENT_AFTER,
      model: MODEL_AFTER,
      continued: true,
      dropImages: true,
      anchor: 'SWITCH-ANCHOR-E',
    })
    await waitForSwitchCommit(scenario, app, 'SWITCH-ANCHOR-E')

    assertTrue(
      scenario,
      'a continuation model switch must keep the draft text including its image token '
        + '(today the composer clear point wipes the whole draft)',
      composerHas(app, STAGED_IMAGE_TOKEN),
    )
    assertEqual(
      scenario,
      'the old capability must not stay bound to the draft',
      false,
      app.channel.hasStagedImage(stageId),
    )
    const chip = tokenIsChip(app, STAGED_IMAGE_TOKEN)
    assertTrue(
      scenario,
      `the token must degrade to plain text, not stay a bound chip (${chip.detail})`,
      chip.ok === false,
    )
  } finally {
    app.unmount()
  }
}

interface Scenario {
  readonly id: string
  readonly name: string
  readonly run: () => Promise<void>
}

const RUNNERS: readonly Scenario[] = [
  { id: 'A', name: 'chat draft survives a continuation model switch', run: scenarioChatContinuation },
  { id: 'B', name: 'launchpad draft survives a continuation model switch', run: scenarioLaunchpadContinuation },
  { id: 'C', name: 'a replaced conversation still clears its draft', run: scenarioReplacementClears },
  { id: 'D', name: 'the switch writes the fact, resetSessionProjection clears it', run: scenarioActionFactSource },
  { id: 'E', name: 'an image token degrades without binding the old capability', run: scenarioImageTokenDegrades },
]

try {
  const selected = (process.env.VERIFY_DRAFT_SWITCH_SCENARIOS ?? '')
    .split(',')
    .map(name => name.trim().toUpperCase())
    .filter(name => name !== '')
  const known = new Set(RUNNERS.map(entry => entry.id))
  const unknown = selected.filter(id => !known.has(id))
  if (unknown.length > 0) {
    throw new VerifyFailure(
      'harness',
      'unknown VERIFY_DRAFT_SWITCH_SCENARIOS entries (expected a subset of the scenario ids)',
      [...known],
      unknown,
    )
  }
  const picked = RUNNERS.filter(entry => selected.length === 0 || selected.includes(entry.id))
  if (picked.length === 0) {
    throw new VerifyFailure('harness', 'VERIFY_DRAFT_SWITCH_SCENARIOS selected no scenario', RUNNERS.length, 0)
  }

  const failures: string[] = []
  for (const entry of picked) {
    try {
      await entry.run()
      console.log(`PASS  ${entry.id}  ${entry.name}`)
    } catch (error) {
      const detail = error instanceof VerifyFailure
        ? `${error.detail}\n        expected: ${JSON.stringify(error.expected)}\n        actual:   ${JSON.stringify(error.actual)}`
        : error instanceof Error ? error.stack ?? error.message : String(error)
      failures.push(entry.id)
      console.log(`FAIL  ${entry.id}  ${entry.name}\n        ${detail}`)
    }
  }

  let harnessFailed = false
  if (runtimeErrors.length > 0) {
    harnessFailed = true
    console.log(`FAIL  harness  renderer errors\n        ${runtimeErrors.join('\n        ')}`)
  }

  const passed = picked.filter(entry => !failures.includes(entry.id)).length
  console.log('')
  console.log(`verify-composer-draft-model-switch: ${passed}/${picked.length} scenarios passed`)
  for (const entry of picked) {
    console.log(`  ${failures.includes(entry.id) ? 'FAIL' : 'PASS'}  ${entry.id}  ${entry.name}`)
  }
  if (failures.length > 0 || harnessFailed) {
    if (failures.length > 0) console.log(`  failed: ${failures.join(', ')}`)
    if (harnessFailed) console.log('  failed: harness (renderer errors)')
    process.exitCode = 1
  }
} catch (error) {
  if (error instanceof VerifyFailure) {
    console.log(`FAIL [${error.scenario}] ${error.detail}`)
    console.log(`  expected: ${JSON.stringify(error.expected)}`)
    console.log(`  actual:   ${JSON.stringify(error.actual)}`)
  } else {
    console.log(`FAIL [harness] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
  process.exitCode = 1
} finally {
  process.stderr.write = realStderrWrite as typeof process.stderr.write
  rmSync(home, { recursive: true, force: true })
}

if (process.exitCode === 1) {
  console.log('verify-composer-draft-model-switch FAILED')
  process.exit(1)
}
console.log('verify-composer-draft-model-switch OK')
process.exit(0)
