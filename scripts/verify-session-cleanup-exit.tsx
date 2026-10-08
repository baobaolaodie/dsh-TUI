/**
 * Clean-exit sweep regression (ADR-0012 decisions 3/5 · AC-5 / AC-6):
 *
 *  - the normal-exit fall-through sweeps the never-spoken shells and folds the
 *    count into the notice `finishExit` writes. The notice lands immediately
 *    after the terminal cleanup, so the round has to be OVER before the call —
 *    an awaited sweep could never reach it (DESIGN D6);
 *  - no other exit path sweeps: the crash / `/update` / kernel-switch /
 *    `/restart` / startup-failure branches keep the notices they had;
 *  - a hostile dependency costs the round, never the shutdown: the terminal
 *    restore sequence and the process hand-off stay exactly where they were
 *    (D7, fail-soft);
 *  - layer ③ is fed with this process's real view — the bound session, the
 *    live agents the registry lists, and the delegated lineage of the listing;
 *  - a session whose log carries a human message but no `turn/start` survives
 *    (AC-6 ①), and a listing this process never made spares the whole index
 *    instead of guessing the lineage.
 *
 * The clean-exit branch itself is a closure inside `apply()`, so its wiring is
 * asserted against the source — the same shape verify-shutdown-fallback uses
 * for its crash hand-off — while every helper it calls is driven directly,
 * with the store seams faked and a throwaway session root.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import {
  composeExitNotice,
  finishExit,
  liveExitSessionIds,
  readExitListing,
  sweepUnspokenOnExit,
  type ExitSweepInput,
} from '../src/dsh-adapter/plugin.js'
import { sweepUnspokenSessions, type UnspokenSweepDeps, type UnspokenSweepResult } from '../src/dsh-adapter/unspoken-sessions.js'
import { getLang, setLang, t } from '../src/i18n.js'
import { DISABLE_KITTY_KEYBOARD, DISABLE_MODIFY_OTHER_KEYS, DISABLE_WIN32_INPUT_MODE } from '../src/ink/termio/csi.js'
import { DBP, DFE, DISABLE_MOUSE_TRACKING, SHOW_CURSOR } from '../src/ink/termio/dec.js'
import { CLEAR_ITERM2_PROGRESS } from '../src/ink/termio/osc.js'
import instances from '../src/ink/instances.js'

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

// ── the throwaway session root ──────────────────────────────────────────────
// Two shells nobody ever spoke in, and four that must survive: a conversation
// with a `turn/start`, one whose only evidence is a human message (no turn yet
// — the shape the web blank rule would call empty), a delegated run, a live
// background run, and the session this process is bound to. Every index entry
// says `hasPrompt: false` on purpose: the log layer and the process layer are
// what the assertions below actually exercise.
const SHELLS = ['shell-a', 'shell-b']
const SPARED = ['spoken', 'human-first', 'sub-run', 'bg', 'cur']
const root = mkdtempSync(join(tmpdir(), 'dsh-tui-exit-sweep-'))
const dirOf = (id: string): string => join(root, id)
const index = new Map(SHELLS.concat(SPARED).map(id => [id, { derived: { hasPrompt: false } }]))
const logs = new Map<string, { readonly events: readonly unknown[], readonly complete: boolean }>([
  ['shell-a', { events: [], complete: true }],
  ['shell-b', { events: [], complete: true }],
  ['spoken', { events: [{ type: 'turn/start' }], complete: true }],
  ['human-first', { events: [{ type: 'user/message', data: { source: { kind: 'user' } } }], complete: true }],
  ['sub-run', { events: [], complete: true }],
  ['bg', { events: [], complete: true }],
  ['cur', { events: [], complete: true }],
])
const ensureDirs = (): void => {
  for (const id of SHELLS.concat(SPARED)) mkdirSync(dirOf(id), { recursive: true })
}
const removed: string[] = []
ensureDirs()

/** The store seams: a fake index, fake logs, a real removal inside the temp root. */
const fixtureSeams = (overrides: Partial<UnspokenSweepDeps> = {}): Partial<UnspokenSweepDeps> => ({
  readIndex: () => index,
  readLog: id => logs.get(id),
  deleteLog: id => {
    removed.push(id)
    rmSync(dirOf(id), { recursive: true, force: true })
    return 'deleted'
  },
  ...overrides,
})

/** The exit helper as the clean-exit branch calls it, with the store faked. */
const sweepWithFixture = (
  input: ExitSweepInput,
  overrides: Partial<UnspokenSweepDeps> = {},
): UnspokenSweepResult | undefined =>
  sweepUnspokenOnExit({
    ...input,
    sweep: deps => sweepUnspokenSessions({ ...deps, ...fixtureSeams(overrides) }),
  })

/** The process view the clean-exit branch passes: bound session + live + lineage. */
const exitInput = (overrides: Partial<ExitSweepInput> = {}): ExitSweepInput => ({
  currentSessionId: () => 'cur',
  liveSessionIds: () => new Set(['bg']),
  listedSessions: () => [
    { id: 'sub-run', delegated: true, parent: 'cur' },
    { id: 'cur' },
  ],
  ...overrides,
})

// ── 1. the clean exit sweeps, and the count reaches the notice ──────────────
{
  const swept = sweepWithFixture(exitInput())
  check('clean exit: exactly the sessions no human spoke in are deleted',
    swept?.deleted.join(',') === 'shell-a,shell-b', String(swept?.deleted))
  check('clean exit: their log directories are gone from disk',
    !existsSync(dirOf('shell-a')) && !existsSync(dirOf('shell-b')))
  check('clean exit: a human message with no turn/start survives (AC-6 ①)', existsSync(dirOf('human-first')))
  check('clean exit: a conversation with a turn/start survives', existsSync(dirOf('spoken')))
  check('clean exit: a delegated run survives (AC-6 ③)', existsSync(dirOf('sub-run')))
  check('clean exit: the live background run and the bound session survive (AC-6 ④)',
    existsSync(dirOf('bg')) && existsSync(dirOf('cur')))
  check('clean exit: the spared set is reported as a full partition, not a log',
    swept !== undefined && swept.skipped.some(row => row.id === 'sub-run' && row.reason === 'subagent') &&
    swept.skipped.some(row => row.id === 'bg' && row.reason === 'live-session') &&
    swept.skipped.some(row => row.id === 'cur' && row.reason === 'current-session') &&
    swept.skipped.some(row => row.id === 'spoken' && row.reason === 'turn-start'),
    JSON.stringify(swept?.skipped))

  const original = getLang()
  setLang('zh')
  const zhNotice = composeExitNotice('Resume with the command below:\n/path', 2)
  setLang('en')
  const enNotice = composeExitNotice(undefined, 2)
  const enSingular = composeExitNotice(undefined, 1)
  setLang(original)
  check('notice: the resume hint is kept, and the count line follows it on its own line',
    zhNotice?.startsWith('Resume with the command below:\n/path\n') === true && zhNotice.split('\n').length === 3, String(zhNotice))
  check('notice: the count line is the dictionary entry, with the count substituted',
    zhNotice?.endsWith(t('exit-cleaned-unspoken-sessions', { count: 2 })) === true, String(zhNotice))
  check('notice: zh and en both report the number (localized, not hard-coded)',
    enNotice !== undefined && enNotice !== zhNotice && enNotice.includes('2'), String(enNotice))
  check('notice: English picks its plural form from the count',
    enSingular !== undefined && enSingular !== enNotice && enSingular.includes('1'), String(enSingular))
  check('notice: nothing cleaned leaves the notice byte-for-byte what it was',
    composeExitNotice('hint', 0) === 'hint' && composeExitNotice(undefined, 0) === undefined)
}

// ── 2. layer ③ is wired with this process's own view ───────────────────────
{
  let captured: UnspokenSweepDeps | undefined
  let rounds = 0
  const swept = sweepUnspokenOnExit({
    currentSessionId: () => 'cur',
    liveSessionIds: () => new Set(['bg']),
    listedSessions: () => [
      { id: 'sub-run', delegated: true, parent: 'root-1' },
      { id: 'fork-of-sub', parent: 'sub-run' },
      { id: 'root-1' },
    ],
    sweep: deps => {
      rounds += 1
      captured = deps
      return { deleted: ['x'], skipped: [] }
    },
  })
  check('layer ③: the sweep receives the bound session as currentSessionId',
    captured?.currentSessionId() === 'cur')
  check('layer ③: the sweep receives the live-session set', captured?.liveSessionIds().has('bg') === true)
  check('layer ③: a delegated run is spared', captured?.isSubagentOrDescendant('sub-run') === true)
  check('layer ③: a fork of a delegated run counts as a descendant',
    captured?.isSubagentOrDescendant('fork-of-sub') === true)
  check('layer ③: an ordinary conversation is not delegated',
    captured?.isSubagentOrDescendant('root-1') === false)
  check('layer ③: the round runs exactly once and its result is reported',
    rounds === 1 && swept?.deleted.join(',') === 'x')
}

// ── 3. the listing seam: lineage mapping, and "unknown" is not "empty" ─────
{
  const lineages = readExitListing({
    cachedSessions: () => [
      { id: 'root-1', kind: { kind: 'root' } },
      { id: 'fork-1', kind: { kind: 'fork', parent: 'root-1' } },
      { id: 'sub-1', kind: { kind: 'subagent', parent: 'root-1', depth: 1 } },
      { id: 'sub-2', kind: { kind: 'subagent', parent: undefined, depth: 1 } },
    ],
  } as never)
  check('listing: a delegated run is flagged and carries its parent',
    lineages?.[2]?.delegated === true && lineages[2]?.parent === 'root-1')
  check('listing: a fork keeps its parent and is not itself delegated',
    lineages?.[1]?.delegated === false && lineages[1]?.parent === 'root-1')
  check('listing: a root records no parent',
    lineages?.[0]?.parent === undefined && lineages?.[0]?.delegated === false)
  check('listing: a parentless delegated run is still delegated', lineages?.[3]?.delegated === true)
  // Guard against lineage drift: a kind this build does not know must count as
  // delegated, because over-marking only spares — under-marking deletes.
  const unknownKind = readExitListing({ cachedSessions: () => [{ id: 'mystery', kind: { kind: 'imported' } }] } as never)
  check('listing: a kind this build does not know counts as delegated (over-marking only spares)',
    unknownKind?.[0]?.delegated === true)
  check('listing: an empty listing is empty, not unknown', readExitListing({ cachedSessions: () => [] } as never)?.length === 0)
  check('listing: a host without the cache reports unknown', readExitListing({} as never) === undefined)
  check('listing: a throwing cache reports unknown', readExitListing({
    cachedSessions: () => { throw new Error('cache boom') },
  } as never) === undefined)
}

// ── 4. no listing yet ⇒ no round: the index is spared, never guessed ───────
{
  ensureDirs()
  removed.length = 0
  const swept = sweepWithFixture(exitInput({ listedSessions: () => undefined }))
  check('unknown lineage: the round reports nothing and deletes nothing',
    swept === undefined && removed.length === 0)
  check('unknown lineage: every shell is still on disk', existsSync(dirOf('shell-a')) && existsSync(dirOf('shell-b')))
  check('unknown lineage: the notice stays the resume hint',
    composeExitNotice('hint', swept?.deleted.length ?? 0) === 'hint')
}

// ── 5. fail-soft: a hostile dependency never blocks the shutdown ───────────
{
  ensureDirs()
  removed.length = 0
  const cases: Array<[string, () => UnspokenSweepResult | undefined]> = [
    ['the listing throws', () => sweepWithFixture(exitInput({
      listedSessions: () => { throw new Error('listing boom') },
    }))],
    ['the index read throws', () => sweepWithFixture(exitInput(), {
      readIndex: () => { throw new Error('index boom') },
    })],
    ['a log read throws', () => sweepWithFixture(exitInput(), {
      readLog: () => { throw new Error('log boom') },
    })],
    ['the delete primitive throws', () => sweepWithFixture(exitInput(), {
      deleteLog: () => { throw new Error('delete boom') },
    })],
    ['the round itself throws', () => sweepUnspokenOnExit({
      ...exitInput(),
      sweep: () => { throw new Error('round boom') },
    })],
    ['the process-layer fact throws', () => sweepWithFixture(exitInput({
      currentSessionId: () => { throw new Error('bound boom') },
    }))],
  ]
  const outcomes: string[] = []
  let threw = false
  for (const [label, run] of cases) {
    try {
      const swept = run()
      outcomes.push(`${label}:${swept === undefined ? 'skipped' : swept.deleted.length}`)
    } catch (error) {
      threw = true
      outcomes.push(`${label}:THREW ${String(error)}`)
    }
  }
  check('fail-soft: no hostile dependency escapes as a throw', !threw, outcomes.join(' | '))
  check('fail-soft: a broken index, log or delete deletes nothing and reports the round',
    outcomes.slice(1, 4).join(',') === 'the index read throws:0,a log read throws:0,the delete primitive throws:0',
    outcomes.join(' | '))
  check('fail-soft: a throwing listing or round is reported as no round at all',
    outcomes[0] === 'the listing throws:skipped' && outcomes[4] === 'the round itself throws:skipped',
    outcomes.join(' | '))
  check('fail-soft: a shell whose dependencies failed is still on disk',
    existsSync(dirOf('shell-a')) && existsSync(dirOf('shell-b')))
}

// ── 6. the terminal restore sequence is unchanged, notice and all ──────────
class CapturingStream extends Writable {
  isTTY = true
  columns = 80
  rows = 24
  chunks: string[] = []
  _write(chunk: unknown, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(String(chunk))
    cb()
  }
}

const captured = new CapturingStream() as unknown as NodeJS.WriteStream
const originalStdout = process.stdout
const swapStdout = (stream: NodeJS.WriteStream): void => {
  Object.defineProperty(process, 'stdout', {
    value: stream,
    configurable: true,
    writable: true,
    enumerable: true,
  })
}

{
  swapStdout(captured)
  instances.delete(captured)
  let done = false
  await finishExit(
    { logger: { debug() {} } } as never,
    { unmount() {} } as never,
    false,
    composeExitNotice('hint', 2),
    undefined,
    () => { done = true },
  )
  swapStdout(originalStdout)
  const written = captured.chunks.join('')
  const order = [DISABLE_MOUSE_TRACKING, DISABLE_MODIFY_OTHER_KEYS, DISABLE_KITTY_KEYBOARD, DISABLE_WIN32_INPUT_MODE, DFE, DBP, SHOW_CURSOR, CLEAR_ITERM2_PROGRESS]
  let at = -1
  let ordered = true
  for (const marker of order) {
    const found = written.indexOf(marker)
    if (found <= at) { ordered = false; break }
    at = found
  }
  check('shutdown: the terminal restore sequence is written in the shipped order', ordered, JSON.stringify(written))
  check('shutdown: the sweep line is the last thing written, after the restore sequence',
    written.endsWith(`${composeExitNotice('hint', 2) ?? ''}\n`), JSON.stringify(written.slice(-80)))
  check('shutdown: the notice still precedes the dispose hand-off',
    done && written.indexOf('hint') > written.indexOf(SHOW_CURSOR))
}

// ── 7. the wiring: only the clean-exit branch sweeps ──────────────────────
{
  const pluginSource = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
  const occurrences = (needle: string): number => pluginSource.split(needle).length - 1
  check('wiring: the projection mirror is attached once at the composition root',
    occurrences('attachSessionListMetadata(ctx)') === 1)
  check('wiring: the sweep has exactly one call site', occurrences('sweepUnspokenOnExit({') === 1)
  const sweepAt = pluginSource.indexOf('sweepUnspokenOnExit({')
  const cleanExit = pluginSource.indexOf('// Judge against the live session behind the channel')
  check('wiring: that call site is the normal-exit fall-through, not a handoff branch',
    cleanExit !== -1 && sweepAt > cleanExit, `sweep@${sweepAt} branch@${cleanExit}`)
  const noticeAt = pluginSource.indexOf('composeExitNotice(hint, swept?.deleted.length ?? 0)')
  const cleanExitCall = pluginSource.indexOf('void finishExit(', cleanExit)
  const cleanExitCallText = pluginSource.slice(cleanExitCall, pluginSource.indexOf('\n      )', cleanExitCall))
  check('wiring: the sweep runs before the notice is composed, and the notice is that call\'s own argument',
    sweepAt < noticeAt && noticeAt > cleanExitCall &&
    cleanExitCallText.includes('composeExitNotice(hint, swept?.deleted.length ?? 0)'),
    `sweep@${sweepAt} notice@${noticeAt} finishExit@${cleanExitCall}`)
  // The branch is a closure inside apply(), so its THREE process facts can only
  // be asserted here. This is the check that catches "wired with an empty set"
  // — the shape that silently widens the delete surface.
  const sweepCallText = pluginSource.slice(sweepAt, pluginSource.indexOf('\n      })', sweepAt))
  check('wiring: the branch feeds the sweep the bound session, the live set and the listing cache',
    sweepCallText.includes('currentSessionId: () => channel.agentId') &&
    sweepCallText.includes('liveSessionIds: () => liveExitSessionIds(ctx, channel.agentId)') &&
    sweepCallText.includes('listedSessions: () => readExitListing(channel)'),
    sweepCallText.replace(/\s+/gu, ' '))
  check('wiring: no other exit path composes a swept notice', occurrences('composeExitNotice(') === 2)
  const finishBody = pluginSource.slice(
    pluginSource.indexOf('export async function finishExit('),
    pluginSource.indexOf('function readInkShutdownState('),
  )
  check('wiring: finishExit itself stays sweep-free, so its five other callers cannot inherit it',
    !finishBody.includes('sweepUnspoken'))
  check('wiring: the crash / update / kernel-switch / restart / startup notices are untouched',
    pluginSource.includes('crashLine,') && pluginSource.includes('hintText,') &&
    pluginSource.includes("t('restart-starting'),") && pluginSource.includes('formatHandoffNotice(') &&
    pluginSource.includes('dsh-tui startup failed:'))
  check('wiring: the count line is read from the dictionary, not a literal',
    pluginSource.includes("t('exit-cleaned-unspoken-sessions'"))
}

rmSync(root, { recursive: true, force: true })
console.log(results.join('\n'))
console.log(`verify-session-cleanup-exit: ${results.length - failures}/${results.length} checks passed`)
if (failures > 0) process.exit(1)
