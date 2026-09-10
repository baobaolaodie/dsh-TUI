#!/usr/bin/env node
/**
 * Regression for change `composer-draft-screen-switch`: the composer draft
 * (text, newline structure and caret) must survive a full-screen view round
 * trip, while an empty composer keeps behaving exactly as before.
 *
 * Drives the REAL `Chat` + `PromptInput` through fake stdin and a headless
 * xterm (same harness as the investigation driver
 * `.specs/composer-draft-screen-switch/evidence/repro-draft-screen.tsx`).
 * Waits go through `scripts/lib/term-test.mjs` (`settled`/`settle`) so the
 * assertions observe the same predicate they wait on.
 *
 * Scenarios (REQUIREMENT「验证方式」):
 * - `ctrl-a`  (AC-1): draft with the caret mid-text, Ctrl+A, Esc — the input
 *   block AND the parked native caret (useDeclaredCursor) must match.
 * - `ctrl-t`  (AC-2): multi-line draft, Ctrl+T, q — block + caret match.
 * - `no-draft` (AC-7 basics): empty composer, Ctrl+A/Esc + Ctrl+T/q — no
 *   renderer error, no residual token, keys still land afterwards.
 *
 * Run from the checkout root:
 *   node --import tsx/esm scripts/verify-composer-draft-screen-switch.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const { mkdtempSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
// Isolate HOME before importing the app: i18n / preferences resolve at import.
const home = mkdtempSync(join(tmpdir(), 'dsh-tui-composer-draft-'))
process.env.HOME = home
process.env.USERPROFILE = home

const [
  { PassThrough, Writable },
  { default: React },
  { Terminal: XTerm },
  { render },
  { Chat },
  { QuestionStore },
  { LOCAL_COMMANDS, completeCommands },
  { settled, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100
const ROWS = 36
const ESC = '\x1b'
const CTRL_A = '\x01'
const CTRL_T = '\x14'
const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'
const BACKSPACE = '\x7f'
/**
 * CSI-u Shift+Enter encodes the modifier raw 0x0a cannot: 0x0a arrives as a
 * plain `return` (submit), while `ESC[13;2u` reports shift+return and takes
 * PromptInput's "insert newline" arm — the same path a modern terminal gives
 * the user for a multi-line draft.
 */
const SHIFT_ENTER = '\x1b[13;2u'

/**
 * Renderer errors (`logError` -> `process.stderr` with a `[dsh-tui]` prefix)
 * are collected instead of swallowed: an error in any scenario must fail the
 * run even when the screen happens to recover. Forwarded to the real stderr
 * so a failure still shows the original stack.
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

interface Harness {
  term: InstanceType<typeof XTerm>
  stdin: InstanceType<typeof PassThrough>
  unmount: () => void
}

function makeChannel() {
  const listeners = new Set<() => void>()
  return {
    whaleIdle: false,
    version: 0,
    rows: [{ id: 1, kind: 'user' as const, text: 'hi' }],
    status: 'idle',
    sessionTitle: 'probe',
    agentId: 'probe',
    model: 'deepseek-v4-flash',
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
    subagents: [] as unknown[],
    lastUserText: '',
    scrollGutter: 'timeline',
    subscribe(cb: () => void) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    submit: () => {},
    cancel: () => {},
    clear: () => {},
    notify: () => {},
    listModels: () => Promise.resolve([]),
    listSessions: () => Promise.resolve([]),
    deleteSession: () => Promise.resolve(true),
    renameSessionTo: () => Promise.resolve(true),
    setResumeTarget: () => {},
    loadOlder: () => {},
    mcpStatus: () => [],
    pushLocal: () => {},
    commandCompletions: (input: string) => completeCommands(input),
    stagedImageGeneration: () => 0,
    stagedImage: () => undefined,
    hasStagedImage: () => false,
    previewImages: () => [],
    subagentControl: { interrupt: () => {} },
    backgroundJobs: [] as unknown[],
    backgroundCurrent: async () => ({ ok: true, backgroundedSessionId: 'probe' }),
    closePluginScene: () => {},
  }
}

async function mountChat(): Promise<Harness> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
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
  const instance = await render(
    React.createElement(Chat, {
      channel: makeChannel(),
      questionStore: new QuestionStore(),
      fullscreen: true,
    }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  return { term, stdin, unmount: () => instance.unmount() }
}

const screen = (app: Harness): string[] => viewportLines(app.term, ROWS)

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

/**
 * The composer box: top border, content row(s), bottom border. Comparing this
 * slice before/after a round trip is the text + newline-structure assertion
 * (the transcript and hint rows outside it are not part of the draft).
 */
function inputBlock(app: Harness): string[] | null {
  const range = inputRange(app)
  if (range === null) return null
  return screen(app).slice(range.top, range.bottom + 1)
}

/** First composer content row (`❯ …`) of the main view. */
function promptRow(app: Harness): string {
  return inputBlock(app)?.[1] ?? ''
}

/** Visible draft text on the single-line composer (affordances stripped). */
function draftText(app: Harness): string {
  return promptRow(app).replace('❯', '').replace('\u26f6', '').trim()
}

function composerHas(app: Harness, text: string): boolean {
  return inputBlock(app)?.join('\n').includes(text) ?? false
}

function cursorPos(app: Harness): { x: number; y: number } {
  const buffer = app.term.buffer.active
  return { x: buffer.cursorX, y: buffer.cursorY }
}

function dashboardVisible(app: Harness): boolean {
  return screen(app).some(line => line.includes('子代理面板'))
}

function trajectoryVisible(app: Harness): boolean {
  // The title row is unique; the rotating tip line can also mention 轨迹.
  return screen(app).some(line => line.includes('\u2726 轨迹'))
}

/** Ctrl+A -> dashboard -> Esc -> main view (composer remounted). */
async function roundTripDashboard(scenario: string, app: Harness): Promise<void> {
  app.stdin.write(CTRL_A)
  await waitFor(scenario, 'subagent dashboard to open', () => dashboardVisible(app))
  app.stdin.write(ESC)
  await waitFor(scenario, 'subagent dashboard to close', () => !dashboardVisible(app))
  await waitFor(scenario, 'composer to remount after dashboard', () => inputBlock(app) !== null)
}

/** Ctrl+T -> trajectory scene -> q -> main view (composer remounted). */
async function roundTripTrajectory(scenario: string, app: Harness): Promise<void> {
  app.stdin.write(CTRL_T)
  await waitFor(scenario, 'trajectory scene to open', () => trajectoryVisible(app))
  app.stdin.write('q')
  await waitFor(scenario, 'trajectory scene to close', () => !trajectoryVisible(app))
  await waitFor(scenario, 'composer to remount after trajectory', () => inputBlock(app) !== null)
}

/** AC-1: Ctrl+A round trip keeps text and caret. */
async function scenarioCtrlA(): Promise<string> {
  const scenario = 'ctrl-a'
  const app = await mountChat()
  let summary = ''
  try {
    await waitFor(scenario, 'composer to mount', () => inputBlock(app) !== null, 8000)

    app.stdin.write('hello world')
    await waitFor(scenario, 'typed draft', () => composerHas(app, 'hello world'))
    app.stdin.write(LEFT.repeat(6))
    await waitFor(scenario, 'caret parked mid-draft (offset 5)', () => cursorPos(app).x === 7)
    const midCaret = cursorPos(app)

    // Round trip 1 doubles as the listener-order warm-up: on a FRESH Chat
    // mount the composer's useInput effect registers before Chat's, so the
    // first Ctrl+A ALSO takes PromptInput's readline "beginning-of-line" arm
    // before the screen opens (pre-existing upstream behavior, not part of
    // this change). The draft must survive it; the caret is asserted on
    // round trip 2, once Chat's handler owns the key and stops propagation.
    await roundTripDashboard(scenario, app)
    assertEqual(scenario, 'draft text after first Ctrl+A -> Esc', 'hello world', draftText(app))

    const missing = midCaret.x - cursorPos(app).x
    if (missing > 0) app.stdin.write(RIGHT.repeat(missing))
    await waitFor(scenario, 'caret back mid-draft before measured trip', () => cursorPos(app).x === midCaret.x)
    const before = { block: inputBlock(app), cursor: cursorPos(app) }

    await roundTripDashboard(scenario, app)
    const after = { block: inputBlock(app), cursor: cursorPos(app) }

    assertEqual(scenario, 'composer block after Ctrl+A -> Esc', before.block, after.block)
    assertEqual(scenario, 'parked caret after Ctrl+A -> Esc', before.cursor, after.cursor)
    summary = `\nPASS  ${scenario}  caret=${JSON.stringify(after.cursor)}  snapshot=${JSON.stringify(after.block)}`
  } finally {
    app.unmount()
  }
  return summary
}

/** AC-2: Ctrl+T round trip keeps text, newline structure and caret. */
async function scenarioCtrlT(): Promise<string> {
  const scenario = 'ctrl-t'
  const app = await mountChat()
  let summary = ''
  try {
    await waitFor(scenario, 'composer to mount', () => inputBlock(app) !== null, 8000)

    app.stdin.write('scene draft')
    await waitFor(scenario, 'first draft line', () => composerHas(app, 'scene draft'))
    app.stdin.write(SHIFT_ENTER)
    await waitFor(scenario, 'second composer row after Shift+Enter', () => inputBlock(app)?.length === 4)
    app.stdin.write('second line')
    await waitFor(scenario, 'second draft line', () => composerHas(app, 'second line'))

    app.stdin.write(LEFT.repeat(6))
    const range = inputRange(app)
    if (range === null) throw new VerifyFailure(scenario, 'composer box missing before Ctrl+T', true, null)
    await waitFor(
      scenario,
      'caret parked mid-second-line',
      () => cursorPos(app).x === 7 && cursorPos(app).y === range.top + 2,
    )

    const before = { block: inputBlock(app), cursor: cursorPos(app) }
    await roundTripTrajectory(scenario, app)
    const after = { block: inputBlock(app), cursor: cursorPos(app) }

    assertEqual(scenario, 'two-line composer block after Ctrl+T -> q', before.block, after.block)
    assertEqual(scenario, 'parked caret after Ctrl+T -> q', before.cursor, after.cursor)
    assertTrue(scenario, 'newline structure kept (two content rows)', after.block?.length === 4)
    summary = `\nPASS  ${scenario}  caret=${JSON.stringify(after.cursor)}  snapshot=${JSON.stringify(after.block)}`
  } finally {
    app.unmount()
  }
  return summary
}

/** AC-7 basics: empty composer round trips are inert and keys stay live. */
async function scenarioNoDraft(): Promise<string> {
  const scenario = 'no-draft'
  const app = await mountChat()
  const errorStart = runtimeErrors.length
  let summary = ''
  try {
    await waitFor(scenario, 'composer to mount', () => inputBlock(app) !== null, 8000)
    assertTrue(scenario, 'input starts empty', draftText(app) === '')

    await roundTripDashboard(scenario, app)
    assertTrue(scenario, 'input still empty after Ctrl+A -> Esc', draftText(app) === '')
    assertTrue(
      scenario,
      'no [Image #N] token left by Ctrl+A -> Esc',
      !(inputBlock(app)?.join('\n') ?? '').includes('[Image #'),
    )

    await roundTripTrajectory(scenario, app)
    assertTrue(scenario, 'input still empty after Ctrl+T -> q', draftText(app) === '')
    assertTrue(
      scenario,
      'no [Image #N] token left by Ctrl+T -> q',
      !(inputBlock(app)?.join('\n') ?? '').includes('[Image #'),
    )

    // Keys must still land after both round trips (nothing latched/consumed).
    app.stdin.write('ping')
    await waitFor(scenario, 'typed key lands after round trips', () => draftText(app) === 'ping')
    app.stdin.write(BACKSPACE.repeat(4))
    await waitFor(scenario, 'backspace erases after round trips', () => draftText(app) === '')

    assertEqual(
      scenario,
      'renderer errors while driving empty composer',
      [],
      runtimeErrors.slice(errorStart),
    )
    summary = `\nPASS  ${scenario}  round-trips=2  keys=live  promptRow=${JSON.stringify(promptRow(app))}`
  } finally {
    app.unmount()
  }
  return summary
}

try {
  const results: string[] = []
  results.push(await scenarioCtrlA())
  results.push(await scenarioCtrlT())
  results.push(await scenarioNoDraft())
  assertEqual('harness', 'renderer errors across scenarios', [], runtimeErrors)
  console.log(results.join('\n'))
} catch (error) {
  if (error instanceof VerifyFailure) {
    console.error(`FAIL [${error.scenario}] ${error.detail}`)
    console.error(`  expected: ${JSON.stringify(error.expected)}`)
    console.error(`  actual:   ${JSON.stringify(error.actual)}`)
  } else {
    console.error(`FAIL [harness] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
  process.exitCode = 1
} finally {
  process.stderr.write = realStderrWrite as typeof process.stderr.write
  rmSync(home, { recursive: true, force: true })
}

if (process.exitCode === 1) process.exit(1)
console.log('verify-composer-draft-screen-switch OK')
process.exit(0)
