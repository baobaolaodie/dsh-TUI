/**
 * Jump-back identity and capability contracts (DESIGN D2/D4/D7/D8, AC-1..AC-9).
 *
 * What this suite owns: the pane marker (minted once, published to the title
 * writer and to the activation URI), the pre-toast probe, the lazy protocol
 * registration, the documented marker file, the cleanup/stale sweep, and the
 * wiring that turns a capable probe into the toast's launch URI.
 *
 * What it deliberately does not repeat: the toast XML and AUMID state machine
 * (`verify-notify-transport`) and the delivery/fallback chain
 * (`verify-task-notifications-windows`). The helper's five-point UIA
 * verification needs a real Windows Terminal and stays the UAT pass; what is
 * assertable in CI is the order this process prepares the promise in.
 *
 * Every system side effect is an injected port: the runner records instead of
 * spawning, the helper path is a string that is never compiled, and each
 * orchestration gets its own temporary data directory. The environment is
 * redirected before the import and the final assertion proves the production
 * data directory was never reached (L-049).
 *
 * Run: node --import tsx/esm scripts/verify-jumpback.ts
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { TaskCompletionDelivery, TaskCompletionJumpBack } from '../src/dsh-adapter/plugin.js'
import type { PluginManagerView } from '../src/dsh-adapter/plugin-manager.js'
import type { JumpBackProbe } from '../src/ink/jumpback.js'
import type { WindowsToastInput, WindowsToastResult } from '../src/ink/terminal-notification-windows.js'
import type { ExecFileNoThrowOptions, ExecFileNoThrowResult } from '../src/utils/execFileNoThrow.js'

/** The throwaway tree every path in this suite resolves under. */
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-jumpback-'))
const sandboxHome = join(sandbox, 'home')
mkdirSync(sandboxHome)
// `DATA_DIR` is a module-level constant: the redirect has to be in place before
// the first import that reads it, or the suite writes the user's profile (L-049).
process.env.HOME = sandboxHome
process.env.USERPROFILE = sandboxHome
process.env.DSH_HOME = join(sandbox, 'dsh-home')
process.on('exit', () => {
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* the fixture is gone already */ }
})

const { DATA_DIR } = await import('../src/utils/paths.js')
const { createJumpBack } = await import('../src/ink/jumpback.js')
const { getJumpBackState, setJumpBackEnabled, subscribeJumpBack } = await import('../src/ink/jumpback-state.js')
const { jumpBackTitleSuffix } = await import('../src/ink/hooks/use-terminal-title.js')
const { applyJumpBackSetting, deliverTaskCompletionOnWindows } = await import('../src/dsh-adapter/plugin.js')

/** The title the renderer passes today (`src/i18n.ts`). */
const TITLE = 'dsh-TUI · 任务已完成'
/** A marker with the documented shape; fixed so argv expectations are literal. */
const MARKER = '0123456789abcdef'
/** Above every platform's pid ceiling, so no live process can own it (D8 sweep). */
const DEAD_PID = 2_147_483_647
const DAY_MS = 24 * 60 * 60 * 1_000
/** The clock every time-dependent case reads, so "a week old" is deterministic. */
const NOW = 1_700_000_000_000
const WINDIR = 'C:\\WINDOWS'
// Composed with `join` like the module does: this suite also runs on POSIX CI,
// where a hardcoded backslash path would never equal what the module built.
const REG_EXE = join(WINDIR, 'System32', 'reg.exe')
/**
 * The URI scheme root Windows resolves a toast click through (D7). Literal on
 * purpose: importing the module's constants would let a wrong key agree with
 * itself, and this suite is the only guard on the documented shape.
 */
const PROTOCOL_KEY = 'HKCU\\Software\\Classes\\dsh-tui'
/** The subkey whose default value is the command a click runs. */
const PROTOCOL_COMMAND_KEY = `${PROTOCOL_KEY}\\shell\\open\\command`
const HELPER = join(sandbox, 'helper', 'activate.exe')
/** The per-orchestration data directory; the suite never lets it default. */
const PROFILE = join(sandbox, 'profile')
const MARKER_DIR = join(PROFILE, 'notify', 'jumpback')
/**
 * The two argv rows a full registration writes (D7/F-1). A fresh write and a
 * rewrite after an external change share them, so the self-heal expectations
 * cannot drift from the registration contract.
 */
const REGISTRATION_WRITES = [
  ['add', PROTOCOL_KEY, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f'],
  ['add', PROTOCOL_COMMAND_KEY, '/ve', '/t', 'REG_SZ', '/d', `"${HELPER}" --activate "%1" -DataDir "${PROFILE}"`, '/f'],
] as const

/** The process runner the ports are given, as `execFileNoThrow` provides it. */
type RunCommand = (
  file: string,
  args: readonly string[],
  options?: ExecFileNoThrowOptions,
) => Promise<ExecFileNoThrowResult>
type RunCall = { file: string, args: readonly string[], timeout: number | undefined }
type RunOutcome = { code: number | null, stdout?: string, stderr?: string }

/** The map key for one registry value, so a case can delete or rewrite it. */
function registryValueId(key: string, name: string | null): string {
  return `${key}\u0000${name ?? ''}`
}

/**
 * Stands in for execFileNoThrow: records the invocation, spawns nothing. The
 * default applies the `reg.exe` verbs this suite uses to an in-memory value map,
 * so a later `reg query` answers what earlier `reg add` calls wrote. A case can
 * delete or rewrite a value between notifications, which is how an external
 * change (another instance, the user's registry tool) reaches the orchestration
 * without touching HKCU (R4).
 * @param outcome - Overrides the default answers for the `reg.exe` calls.
 */
function recordingRunner(
  outcome?: (call: { file: string, args: readonly string[] }, index: number) => RunOutcome | Promise<RunOutcome>,
) {
  const calls: RunCall[] = []
  const values = new Map<string, string>()

  /** Apply the verb to the value map, or answer a helper run with success. */
  const applyRegistryVerb = (call: { file: string, args: readonly string[] }): RunOutcome => {
    const [verb, key, ...rest] = call.args
    if (key === undefined) return { code: 1 }
    if (verb === 'add') {
      const name = rest[0] === '/ve' ? null : rest[0] === '/v' ? rest[1] ?? null : null
      const dataAt = rest.indexOf('/d')
      values.set(registryValueId(key, name), dataAt === -1 ? '' : rest[dataAt + 1] ?? '')
      return { code: 0 }
    }
    if (verb === 'delete') {
      for (const id of [...values.keys()]) {
        const existing = id.slice(0, id.indexOf('\u0000'))
        if (existing === key || existing.startsWith(`${key}\\`)) values.delete(id)
      }
      return { code: 0 }
    }
    if (verb === 'query') {
      const name = rest[0] === '/ve' ? null : rest[1] ?? null
      const data = values.get(registryValueId(key, name))
      if (data === undefined) {
        return { code: 1, stderr: 'ERROR: The system was unable to find the specified registry key or value.' }
      }
      return {
        code: 0,
        stdout: `${key}\r\n    ${name ?? '(Default)'}    REG_SZ${data === '' ? '' : `    ${data}`}\r\n`,
      }
    }
    // Anything else is the helper run the probe tests drive, not a registry verb.
    return { code: 0 }
  }

  const run: RunCommand = async (file, args, options) => {
    const index = calls.length
    calls.push({ file, args, timeout: options?.timeout })
    const settled = await (outcome === undefined ? applyRegistryVerb({ file, args }) : outcome({ file, args }, index))
    return { code: settled.code, stdout: settled.stdout ?? '', stderr: settled.stderr ?? '' }
  }
  return { calls, run, values }
}

/** The keys a `reg.exe` sequence leaves behind; `delete <key> /f` removes the whole subtree. */
function keysAfter(calls: readonly RunCall[]): Set<string> {
  const keys = new Set<string>()
  for (const call of calls) {
    const [verb, key] = call.args
    if (key === undefined) continue
    if (verb === 'add') {
      keys.add(key)
    } else if (verb === 'delete') {
      for (const existing of [...keys]) {
        if (existing === key || existing.startsWith(`${key}\\`)) keys.delete(existing)
      }
    }
  }
  return keys
}

/**
 * The protocol keys a recorded sequence leaves under the scheme root. This stands
 * in for the `reg query` UAT would run: the model applies the same subtree
 * semantics `reg.exe` has, so "the root key is gone" is assertable without ever
 * touching HKCU.
 * @param calls - The recorded `reg.exe` invocations, in order.
 * @returns The surviving protocol keys, sorted, with the root first.
 */
function protocolKeys(calls: readonly RunCall[]): string[] {
  return [...keysAfter(calls)]
    .filter(key => key === PROTOCOL_KEY || key.startsWith(`${PROTOCOL_KEY}\\`))
    .sort()
}

/** One orchestration with every port stubbed; nothing here reaches the machine. */
function makeJumpBack(options: {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  run?: ReturnType<typeof recordingRunner>
  /** The resolver's answer; `null` means "cannot be compiled". */
  helper?: string | null
  now?: () => number
  dataDir?: string
  /** Liveness for marker owners; the production default asks the OS (R4). */
  pidAlive?: (pid: number) => boolean
} = {}) {
  const runner = options.run ?? recordingRunner()
  let resolverCalls = 0
  const instance = createJumpBack({
    platform: options.platform ?? 'win32',
    env: options.env ?? { WINDIR },
    run: runner.run,
    helperPath: async () => {
      resolverCalls += 1
      return options.helper === null ? undefined : options.helper ?? HELPER
    },
    now: options.now ?? (() => NOW),
    dataDir: options.dataDir ?? PROFILE,
    pidAlive: options.pidAlive,
  })
  return { instance, runner, resolverCalls: () => resolverCalls }
}

/**
 * Run one body with the debug logger on and stderr captured. The suite asserts
 * the stage/reason trail AC-3 and D8 require, and a failed assertion must still
 * print through the real stderr, so the patch is restored in `finally`.
 * @param body - The call(s) whose debug output matters.
 * @returns The body's result and the captured lines.
 */
async function captureDebug<T>(body: () => T | Promise<T>): Promise<{ result: T, lines: string[] }> {
  const realWrite = process.stderr.write.bind(process.stderr)
  const lines: string[] = []
  const previous = process.env.DSH_TUI_DEBUG
  process.env.DSH_TUI_DEBUG = '1'
  process.stderr.write = ((chunk: unknown): boolean => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    return { result: await body(), lines }
  } finally {
    process.stderr.write = realWrite
    if (previous === undefined) delete process.env.DSH_TUI_DEBUG
    else process.env.DSH_TUI_DEBUG = previous
  }
}

/** The stage a probe reported, or undefined when it promised a jump. */
function unavailableStage(probe: JumpBackProbe): string | undefined {
  return probe.capable ? undefined : probe.stage
}

/** The reason a probe reported, for the failure cases only. */
function reasonOf(probe: JumpBackProbe): string {
  return probe.capable ? '' : probe.reason
}

/** Turn the setting on and answer the marker the title writer would append. */
function enableJumpBack(): string {
  setJumpBackEnabled(true)
  const { marker } = getJumpBackState()
  assert.ok(marker !== null, 'the suite needs the marker the title writer appends')
  return marker
}

let passed = 0
async function check(name: string, body: () => void | Promise<void>): Promise<void> {
  await body()
  passed += 1
  process.stdout.write(`ok ${passed} - ${name}\n`)
}

// --- the marker in the pane title (D2/D3, AC-1/AC-2) ---------------------------

await check('the pane title carries the marker only on Windows, once enabled', () => {
  assert.equal(jumpBackTitleSuffix({ enabled: false, marker: null }, 'win32'), '', 'off by default: the title must not change (AC-1)')
  assert.equal(
    jumpBackTitleSuffix({ enabled: false, marker: MARKER }, 'win32'),
    '',
    'a retained marker is not a licence to write it while the setting is off',
  )
  assert.equal(
    jumpBackTitleSuffix({ enabled: true, marker: null }, 'win32'),
    '',
    'an enabled switch without a minted marker has nothing to name',
  )
  assert.equal(
    jumpBackTitleSuffix({ enabled: true, marker: MARKER }, 'linux'),
    '',
    'no other host resolves the marker, so tagging would only rename the tab (D2)',
  )
  assert.equal(
    jumpBackTitleSuffix({ enabled: true, marker: MARKER }, 'win32'),
    ` [dsh-tui:${MARKER}]`,
    'the documented suffix is appended after the title',
  )
})

// --- one published identity (D2, L-080) ---------------------------------------

await check('enabling mints one 16-hex marker and publishes it once', () => {
  assert.deepEqual(getJumpBackState(), { enabled: false, marker: null }, 'a fresh process starts off with no identity')
  const before = getJumpBackState()
  const seen: number[] = []
  const unsubscribe = subscribeJumpBack(() => seen.push(1))
  setJumpBackEnabled(true)
  const state = getJumpBackState()
  assert.notEqual(state, before, 'a real change publishes a new snapshot, or useSyncExternalStore never re-renders')
  assert.equal(state.enabled, true)
  assert.match(String(state.marker), /^[0-9a-f]{16}$/u, 'the marker is 16 lowercase hex characters (D2/AC-2)')
  assert.deepEqual(seen, [1], 'subscribers are told exactly once')
  unsubscribe()
})

await check('republishing the same switch changes nothing, and an unsubscribed listener is not told', () => {
  const state = getJumpBackState()
  const seen: number[] = []
  const unsubscribe = subscribeJumpBack(() => seen.push(1))
  setJumpBackEnabled(true)
  assert.equal(getJumpBackState(), state, 'an unchanged switch must not replace the snapshot')
  assert.deepEqual(seen, [], 'nor wake the title writer')
  unsubscribe()
  setJumpBackEnabled(false)
  assert.deepEqual(seen, [], 'an unsubscribed listener stops hearing about changes')
  setJumpBackEnabled(true)
})

await check('disabling hides the marker, and enabling again reuses the same identity', () => {
  const marker = getJumpBackState().marker
  assert.match(String(marker), /^[0-9a-f]{16}$/u)
  setJumpBackEnabled(false)
  assert.equal(getJumpBackState().marker, marker, 'the identity survives the switch: an already-delivered toast keeps pointing at this pane')
  assert.equal(jumpBackTitleSuffix(getJumpBackState(), 'win32'), '', 'while it is off the title loses the suffix immediately (D3)')
  setJumpBackEnabled(true)
  assert.equal(getJumpBackState().marker, marker, 're-enabling must not rename the pane (AC-2)')
  assert.equal(jumpBackTitleSuffix(getJumpBackState(), 'win32'), ` [dsh-tui:${marker}]`)
})

// --- the pre-toast probe (D4, AC-3) -------------------------------------------

await check('a malformed marker is refused before the helper is even resolved', async () => {
  const { instance, runner, resolverCalls } = makeJumpBack()
  const malformed = ['', '0123456789ABCDEF', '0123456789abcde', '0123456789abcdef0', '0123456789abcdeg', '0123 456789abcde']
  for (const marker of malformed) {
    const probe = await instance.probe(marker)
    assert.equal(unavailableStage(probe), 'marker', `${JSON.stringify(marker)} is not the documented marker shape`)
  }
  assert.equal(resolverCalls(), 0, 'a wrong marker needs no compiler')
  assert.deepEqual(runner.calls, [], 'and no child process')
})

await check('exit 0 is capable and names the helper, with the data directory passed explicitly', async () => {
  const { instance, runner } = makeJumpBack()
  assert.deepEqual(await instance.probe(MARKER), { capable: true, helperPath: HELPER }, 'only exit 0 promises a jump (D4)')
  assert.deepEqual(runner.calls.map(call => call.file), [HELPER], 'the helper itself is spawned')
  assert.deepEqual(
    runner.calls[0].args,
    ['--probe', MARKER, '-DataDir', PROFILE],
    'L-077: the shell-started helper inherits no environment, so the data directory travels as argv',
  )
  assert.equal(runner.calls[0].timeout, 1_500, 'D4 budgets 1.5 s for a probe; a stuck helper must not delay the notification')
})

await check('the helper\'s own failure exit codes degrade with its line kept in the reason', async () => {
  const cases = [
    { code: 2, stderr: 'usage: --probe <marker>' },
    { code: 3, stderr: 'no reachable target' },
  ]
  for (const settled of cases) {
    const { instance, runner } = makeJumpBack({ run: recordingRunner(() => settled) })
    const { result, lines } = await captureDebug(() => instance.probe(MARKER))
    assert.equal(unavailableStage(result), 'probe', `exit ${settled.code} is not a promise`)
    assert.ok(reasonOf(result).includes(`code ${settled.code}`), 'the exit code is in the reason')
    assert.ok(reasonOf(result).includes(settled.stderr), 'and the helper\'s own line is the only clue for the post-mortem')
    assert.match(lines.join(''), /"stage":"probe"/u, 'the stage and reason reach the debug log (AC-3)')
    assert.equal(runner.calls.length, 1)
  }
})

await check('a probe that never exits is a timeout, not a hang', async () => {
  const { instance } = makeJumpBack({ run: recordingRunner(() => ({ code: null })) })
  const probe = await instance.probe(MARKER)
  assert.equal(unavailableStage(probe), 'probe')
  assert.match(reasonOf(probe), /timed out after 1500 ms/u, 'the reason says what happened to the child')
})

await check('a throwing runner degrades instead of rejecting', async () => {
  const { instance } = makeJumpBack({ run: { calls: [], run: async () => { throw new Error('spawn exploded') } } })
  const probe = await instance.probe(MARKER)
  assert.equal(unavailableStage(probe), 'unexpected', 'the notification path must not inherit the error (AC-3)')
  assert.match(reasonOf(probe), /spawn exploded/u)
})

await check('a helper that cannot be compiled is unavailable before anything runs', async () => {
  const { instance, runner } = makeJumpBack({ helper: null })
  assert.equal(unavailableStage(await instance.probe(MARKER)), 'helper')
  assert.deepEqual(runner.calls, [], 'no child process is started for a helper that does not exist')
})

await check('off Windows the probe compiles and spawns nothing', async () => {
  const { instance, runner, resolverCalls } = makeJumpBack({ platform: 'linux' })
  assert.equal(unavailableStage(await instance.probe(MARKER)), 'not-win32')
  assert.equal(resolverCalls(), 0, 'no csc run either')
  assert.deepEqual(runner.calls, [])
})

// --- the lazy protocol registration (D7, AC-1/AC-9) ---------------------------

await check('registration writes the scheme root marker and the command, quoted', async () => {
  const { instance, runner } = makeJumpBack()
  assert.equal(await instance.ensureProtocol(HELPER), true)
  assert.deepEqual(runner.calls.map(call => call.file), [REG_EXE, REG_EXE], 'the in-box registry tool is resolved from %WINDIR%, never PATH')
  assert.deepEqual(
    runner.calls.map(call => call.args),
    REGISTRATION_WRITES,
    'Windows resolves dsh-tui: only when the root carries the empty URL Protocol value; the command below it is the default value (D7/F-1)',
  )
  assert.ok(
    runner.calls.every(call => typeof call.timeout === 'number' && call.timeout > 0),
    'a stuck reg.exe must not hold the notification',
  )
})

await check('registration is verified after the first write, and a burst of notifications writes the key once', async () => {
  const cached = makeJumpBack()
  assert.equal(await cached.instance.ensureProtocol(HELPER), true)
  assert.equal(await cached.instance.ensureProtocol(HELPER), true)
  assert.deepEqual(
    cached.runner.calls.map(call => call.args[0]),
    ['add', 'add', 'query', 'query'],
    'the second notification proves both values are still ours instead of trusting the cache (D7/R4)',
  )

  const burst = makeJumpBack()
  const answers = await Promise.all([
    burst.instance.ensureProtocol(HELPER),
    burst.instance.ensureProtocol(HELPER),
    burst.instance.ensureProtocol(HELPER),
  ])
  assert.deepEqual(answers, [true, true, true])
  assert.equal(burst.runner.calls.length, 2, 'concurrent notifications share the one registration in flight (D7)')
  assert.deepEqual(burst.runner.calls.map(call => call.args[0]), ['add', 'add'], 'and none of them re-checks a key that is still in flight')
})

await check('a key deleted outside this process is written again before the next notification', async () => {
  for (const vanished of ['root value', 'command value'] as const) {
    const runner = recordingRunner()
    const { instance } = makeJumpBack({ run: runner })
    assert.equal(await instance.ensureProtocol(HELPER), true)
    runner.values.delete(vanished === 'root value'
      ? registryValueId(PROTOCOL_KEY, 'URL Protocol')
      : registryValueId(PROTOCOL_COMMAND_KEY, null))
    const before = runner.calls.length
    assert.equal(await instance.ensureProtocol(HELPER), true, `${vanished} gone: the next notification still promises the click`)
    assert.deepEqual(
      runner.calls.slice(before).map(call => call.args),
      vanished === 'root value'
        ? [['query', PROTOCOL_KEY, '/v', 'URL Protocol'], ...REGISTRATION_WRITES]
        : [['query', PROTOCOL_KEY, '/v', 'URL Protocol'], ['query', PROTOCOL_COMMAND_KEY, '/ve'], ...REGISTRATION_WRITES],
      `${vanished} gone: the cache is only a hint; both values are rewritten before the promise (D7/R4)`,
    )
  }
})

await check('a command rewritten to another helper is replaced before the next notification', async () => {
  const runner = recordingRunner()
  const { instance } = makeJumpBack({ run: runner })
  assert.equal(await instance.ensureProtocol(HELPER), true)
  runner.values.set(
    registryValueId(PROTOCOL_COMMAND_KEY, null),
    `"C:\\other\\activate.exe" --activate "%1" -DataDir "C:\\other"`,
  )
  const before = runner.calls.length
  assert.equal(await instance.ensureProtocol(HELPER), true)
  assert.deepEqual(
    runner.calls.slice(before).map(call => call.args),
    [
      ['query', PROTOCOL_KEY, '/v', 'URL Protocol'],
      ['query', PROTOCOL_COMMAND_KEY, '/ve'],
      ...REGISTRATION_WRITES,
    ],
    'a value that points at someone else\'s helper is not this process\'s registration (R4)',
  )
  assert.equal(
    runner.values.get(registryValueId(PROTOCOL_COMMAND_KEY, null)),
    `"${HELPER}" --activate "%1" -DataDir "${PROFILE}"`,
    'and the click is rewritten to this process\'s helper and data directory',
  )
})

await check('either refused value answers false and is retried later', async () => {
  for (const refused of [0, 1]) {
    const runner = recordingRunner((_call, index) => (index === refused
      ? { code: 1, stderr: 'ERROR: Access is denied.' }
      : { code: 0 }))
    const { instance } = makeJumpBack({ run: runner })
    const { result, lines } = await captureDebug(() => instance.ensureProtocol(HELPER))
    assert.equal(result, false, `refusing write ${refused + 1} must not claim the key is registered`)
    assert.equal(runner.calls.length, refused + 1, 'a refused write stops the pair: the other value alone is not a registration')
    assert.match(lines.join(''), /protocol registration failed/u, 'and the refusal keeps its cause')
    assert.equal(await instance.ensureProtocol(HELPER), true, 'and must not be cached: the next notification retries (D7/R3)')
    assert.equal(runner.calls.length, refused + 1 + 2, 'the retry writes both values again')
  }
})

await check('an unquotable helper is refused before reg.exe runs', async () => {
  const { instance, runner } = makeJumpBack()
  assert.equal(await instance.ensureProtocol('C:\\a"b\\activate.exe'), false)
  assert.equal(await instance.ensureProtocol(''), false, 'an empty path is not a helper either')
  assert.deepEqual(runner.calls, [], 'recording a handler that cannot start would be a silent dead click (R8)')
})

await check('off Windows, or with no Windows directory, nothing is written', async () => {
  const linux = makeJumpBack({ platform: 'linux' })
  assert.equal(await linux.instance.ensureProtocol(HELPER), false)
  assert.deepEqual(linux.runner.calls, [])

  const rootless = makeJumpBack({ env: {} })
  assert.equal(await rootless.instance.ensureProtocol(HELPER), false, 'without %WINDIR% the absolute reg.exe path cannot be built')
  assert.deepEqual(rootless.runner.calls, [], 'and PATH is never used as a fallback')
})

await check('unregistering deletes the whole scheme root, and a key that is already gone is not an error', async () => {
  const { instance, runner } = makeJumpBack({
    run: recordingRunner(() => ({ code: 1, stderr: 'ERROR: The system was unable to find the specified registry key.' })),
  })
  const { lines } = await captureDebug(() => instance.unregisterProtocol())
  assert.deepEqual(
    runner.calls.map(call => call.args),
    [['delete', PROTOCOL_KEY, '/f']],
    'the scheme root, force-deleted: deleting only `...\\command` would leave the empty protocol key behind (F-2)',
  )
  assert.match(lines.join(''), /unregistration failed/u, 'another instance may have removed it first; the refusal is recorded, not thrown (R4)')
})

await check('after unregistering, no protocol key is left behind', async () => {
  const { instance, runner } = makeJumpBack()
  assert.equal(await instance.ensureProtocol(HELPER), true)
  const afterRegistration = protocolKeys(runner.calls)
  assert.ok(afterRegistration.includes(PROTOCOL_KEY), 'the scheme root is created')
  assert.ok(afterRegistration.includes(PROTOCOL_COMMAND_KEY), 'and so is the command subkey under it')
  await instance.cleanup()
  assert.deepEqual(
    protocolKeys(runner.calls),
    [],
    'a normal exit leaves no protocol key at all, not just no command subkey (AC-1 / CHANGE line 3)',
  )
})

// --- the documented marker file (D8, AC-9, R8) --------------------------------

await check('the marker file is the documented JSON at the documented path', () => {
  const { instance } = makeJumpBack({ dataDir: join(sandbox, 'marker-schema') })
  const path = instance.writeMarker('session-abc', MARKER)
  assert.equal(
    path,
    join(sandbox, 'marker-schema', 'notify', 'jumpback', 'session-abc.json'),
    'D8 names the file for the session',
  )
  assert.ok(path !== undefined)
  assert.deepEqual(
    JSON.parse(readFileSync(path, 'utf8')),
    { schemaVersion: 1, marker: MARKER, pid: process.pid, startedAt: new Date(NOW).toISOString() },
    'AC-9: exactly the four documented fields, so an external plugin can build the URI it describes',
  )
})

await check('a session id that could leave the marker directory is refused', () => {
  const dir = join(sandbox, 'marker-refuse')
  const { instance } = makeJumpBack({ dataDir: dir })
  for (const sessionId of ['../escape', '..\\escape', 'a/b', 'a\\b', '', 'x'.repeat(129), 'two words', 'bad:name']) {
    assert.equal(instance.writeMarker(sessionId, MARKER), undefined, `${JSON.stringify(sessionId)} must not name a file`)
  }
  assert.equal(instance.writeMarker('session-abc', 'NOT-A-MARKER'), undefined, 'and a wrong marker is no better')
  // `..` is not a traversal once `.json` is appended; it names a file, not the
  // directory. Whatever the guard accepts must still stay inside the directory.
  const dotdot = instance.writeMarker('..', MARKER)
  if (dotdot !== undefined) {
    assert.equal(resolve(dirname(dotdot)), resolve(join(dir, 'notify', 'jumpback')), 'no accepted id may escape the marker directory')
  }
})

await check('off Windows no marker file is written', () => {
  const dir = join(sandbox, 'marker-linux')
  const { instance } = makeJumpBack({ platform: 'linux', dataDir: dir })
  assert.equal(instance.writeMarker('session-abc', MARKER), undefined, 'AC-1: a POSIX process leaves no trace')
  assert.equal(existsSync(join(dir, 'notify')), false)
})

await check('an unwritable marker directory degrades instead of throwing', async () => {
  const file = join(sandbox, 'not-a-directory')
  writeFileSync(file, 'x')
  const { result, lines } = await captureDebug(() => makeJumpBack({ dataDir: file }).instance.writeMarker('session-abc', MARKER))
  assert.equal(result, undefined, 'the notification path must not inherit a filesystem error')
  assert.match(lines.join(''), /marker file unwritable/u)
})

// --- cleanup and the stale sweep (D7/D8) --------------------------------------

await check('cleanup removes the key it registered and the files it wrote, once', async () => {
  const dir = join(sandbox, 'cleanup')
  const { instance, runner } = makeJumpBack({ dataDir: dir })
  assert.equal(await instance.ensureProtocol(HELPER), true)
  const markerPath = instance.writeMarker('session-cleanup', MARKER)
  assert.ok(markerPath !== undefined)
  const foreign = join(dir, 'notify', 'jumpback', 'foreign.json')
  writeFileSync(foreign, '{}')
  await instance.cleanup()
  assert.deepEqual(
    runner.calls.map(call => call.args[0]),
    ['add', 'add', 'delete'],
    'both values this process wrote are removed by the one root deletion, and nothing else is touched',
  )
  assert.equal(existsSync(markerPath), false, 'the marker file this process wrote is removed')
  assert.equal(existsSync(foreign), true, 'another instance\'s file is not ours to delete (R4)')
  await instance.cleanup()
  assert.equal(runner.calls.length, 3, 'cleanup is idempotent')
})

await check('a process that never registered or wrote leaves everything alone', async () => {
  const dir = join(sandbox, 'cleanup-empty')
  mkdirSync(join(dir, 'notify', 'jumpback'), { recursive: true })
  const foreign = join(dir, 'notify', 'jumpback', 'session-other.json')
  writeFileSync(foreign, '{}')
  const { instance, runner } = makeJumpBack({ dataDir: dir })
  await instance.cleanup()
  assert.deepEqual(runner.calls, [], 'a disabled process must not delete a key another instance registered')
  assert.equal(existsSync(foreign), true)
})

await check('cleanup yields the shared key to a live instance, and removes it when no one else is alive', async () => {
  const liveDir = join(sandbox, 'cleanup-yield')
  const liveMarkerDir = join(liveDir, 'notify', 'jumpback')
  mkdirSync(liveMarkerDir, { recursive: true })
  const sibling = join(liveMarkerDir, 'session-sibling.json')
  writeFileSync(sibling, markerRecord({ pid: 4_242 }))
  const live = makeJumpBack({ dataDir: liveDir, pidAlive: pid => pid === 4_242 })
  assert.equal(await live.instance.ensureProtocol(HELPER), true)
  const own = live.instance.writeMarker('session-own', MARKER)
  const { lines } = await captureDebug(() => live.instance.cleanup())
  assert.deepEqual(
    live.runner.calls.map(call => call.args[0]),
    ['add', 'add'],
    'a live sibling still needs the shared key: removing it would make its next toast click dead (R4)',
  )
  assert.equal(existsSync(sibling), true, 'the sibling keeps its identity')
  assert.ok(own !== undefined)
  assert.equal(existsSync(own), false, 'this process still removes the file it wrote')
  assert.match(lines.join(''), /left the protocol key/u, 'and the reason survives in the debug log')

  const quietDir = join(sandbox, 'cleanup-dead-sibling')
  const quietMarkerDir = join(quietDir, 'notify', 'jumpback')
  mkdirSync(quietMarkerDir, { recursive: true })
  writeFileSync(join(quietMarkerDir, 'gone.json'), markerRecord({ pid: DEAD_PID }))
  const quiet = makeJumpBack({ dataDir: quietDir })
  assert.equal(await quiet.instance.ensureProtocol(HELPER), true)
  await quiet.instance.cleanup()
  assert.deepEqual(
    quiet.runner.calls.map(call => call.args[0]),
    ['add', 'add', 'delete'],
    'a dead owner is not a live instance: the last one out removes the key (D7/F-2)',
  )
  assert.deepEqual(
    quiet.runner.calls.at(-1)?.args,
    ['delete', PROTOCOL_KEY, '/f'],
    'and it removes the whole scheme root, not just the command below it',
  )
})

/** One marker file body, with the fields the sweep inspects overridable. */
function markerRecord(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    marker: MARKER,
    pid: process.pid,
    startedAt: new Date(NOW).toISOString(),
    ...overrides,
  })
}

await check('the sweep removes a gone owner and a file older than a week', () => {
  const markerDir = join(sandbox, 'sweep-remove', 'notify', 'jumpback')
  mkdirSync(markerDir, { recursive: true })
  const gone = join(markerDir, 'gone.json')
  writeFileSync(gone, markerRecord({ pid: DEAD_PID }))
  const old = join(markerDir, 'old.json')
  writeFileSync(old, markerRecord({ startedAt: new Date(NOW - 8 * DAY_MS).toISOString() }))
  makeJumpBack({ dataDir: join(sandbox, 'sweep-remove'), now: () => NOW }).instance.sweepStale()
  assert.equal(existsSync(gone), false, 'a pid nobody answers cannot own a live pane (D8)')
  assert.equal(existsSync(old), false, 'a file older than the 7-day ceiling is stale even when its pid answers')
})

await check('the sweep keeps a live owner and every file it cannot interpret', () => {
  const markerDir = join(sandbox, 'sweep-keep', 'notify', 'jumpback')
  mkdirSync(markerDir, { recursive: true })
  const files: Record<string, string> = {
    'live.json': markerRecord(),
    'corrupt.json': '{not json',
    'nopid.json': markerRecord({ pid: undefined }),
    'nostart.json': markerRecord({ startedAt: undefined }),
    'note.txt': 'not a marker',
  }
  for (const [name, body] of Object.entries(files)) writeFileSync(join(markerDir, name), body)
  makeJumpBack({ dataDir: join(sandbox, 'sweep-keep'), now: () => NOW }).instance.sweepStale()
  assert.deepEqual(
    readdirSync(markerDir).sort(),
    Object.keys(files).sort(),
    'a live pane keeps its identity, and an unreadable file is not proof its owner is gone (D8)',
  )
})

await check('off Windows the sweep deletes nothing', () => {
  const markerDir = join(sandbox, 'sweep-linux', 'notify', 'jumpback')
  mkdirSync(markerDir, { recursive: true })
  const gone = join(markerDir, 'gone.json')
  writeFileSync(gone, markerRecord({ pid: DEAD_PID }))
  makeJumpBack({ platform: 'linux', dataDir: join(sandbox, 'sweep-linux') }).instance.sweepStale()
  assert.equal(existsSync(gone), true)
})

/** Stands in for the orchestration's lifecycle side: a setting flip calls exactly these. */
function recordingLifecycle() {
  const steps: string[] = []
  const markerWrites: [string, string][] = []
  return {
    steps,
    markerWrites,
    jumpback: {
      sweepStale(): void { steps.push('sweepStale') },
      async cleanup(): Promise<void> { steps.push('cleanup') },
      writeMarker(sessionId: string, marker: string): string | undefined {
        steps.push('writeMarker')
        markerWrites.push([sessionId, marker])
        return undefined
      },
    },
  }
}

/** The session a settings flip names, standing in for `rawChannel.sessionRef.sessionId`. */
const FLIP_SESSION = 'session-flip'

await check('flipping the setting cleans up on disable, sweeps once on enable, and refreshes the marker file', () => {
  const marker = enableJumpBack()
  const port = recordingLifecycle()
  applyJumpBackSetting(port.jumpback, false, FLIP_SESSION, 'win32')
  assert.deepEqual(
    port.steps,
    ['cleanup'],
    'on→off is a cleanup point of its own: the key and marker files this process left must go (AC-1/AC-9)',
  )
  assert.equal(getJumpBackState().enabled, false)
  applyJumpBackSetting(port.jumpback, false, FLIP_SESSION, 'win32')
  assert.deepEqual(port.steps, ['cleanup'], 'republishing off publishes nothing and cleans up nothing twice')

  applyJumpBackSetting(port.jumpback, true, FLIP_SESSION, 'win32')
  assert.deepEqual(
    port.steps,
    ['cleanup', 'sweepStale', 'writeMarker'],
    'off→on sweeps stale marker files once and refreshes the documented seam for the current session (D8)',
  )
  assert.deepEqual(
    port.markerWrites,
    [[FLIP_SESSION, marker]],
    'the enable-time refresh names the current session with this pane\'s marker, so an external reader finds it before the first completion (AC-9)',
  )
  assert.equal(getJumpBackState().marker, marker, 'the flip keeps this pane\'s identity (AC-2)')
  applyJumpBackSetting(port.jumpback, true, FLIP_SESSION, 'win32')
  assert.deepEqual(port.steps, ['cleanup', 'sweepStale', 'writeMarker'], 'republishing on neither sweeps nor refreshes again')
  assert.deepEqual(port.markerWrites, [[FLIP_SESSION, marker]], 'repeated true writes the seam exactly once (D8)')

  // The refresh is only a Windows, session-named promise: another host or a
  // boot without a session yet has no documented file to publish (D2/D8).
  applyJumpBackSetting(port.jumpback, false, FLIP_SESSION, 'win32')
  applyJumpBackSetting(port.jumpback, true, undefined, 'win32')
  applyJumpBackSetting(port.jumpback, false, FLIP_SESSION, 'win32')
  applyJumpBackSetting(port.jumpback, true, FLIP_SESSION, 'linux')
  assert.deepEqual(
    port.markerWrites,
    [[FLIP_SESSION, marker]],
    'off Windows, or with no session to name, enabling publishes no marker file',
  )
})

await check('an enable whose marker refresh fails keeps the switch on and leaves the reason', async () => {
  setJumpBackEnabled(false)
  const throwing = {
    sweepStale(): void {},
    async cleanup(): Promise<void> {},
    writeMarker(): string | undefined { throw new Error('marker port exploded') },
  }
  const { lines } = await captureDebug(() => applyJumpBackSetting(throwing, true, FLIP_SESSION, 'win32'))
  assert.equal(getJumpBackState().enabled, true, 'a failed refresh must not roll the switch back')
  assert.match(lines.join(''), /enabled marker file could not be refreshed/u, 'the reason stays in the log instead of the user losing the switch')
})

// --- the toast wiring (T07, D4/D7/D8, AC-3/AC-7/AC-10) -----------------------

type Step = { name: string, args: string[] }

/** Stands in for this process's orchestration: records each step and its answer. */
function recordingJumpBack(options: {
  probe?: JumpBackProbe | (() => Promise<JumpBackProbe>)
  register?: boolean
  markerPath?: string
  throwOn?: 'writeMarker' | 'probe' | 'ensureProtocol'
  /** Also reports each step into a shared log, so ordering against another port is assertable. */
  onStep?: (name: string) => void
} = {}) {
  const steps: Step[] = []
  const record = (name: string, args: string[]): void => {
    steps.push({ name, args })
    options.onStep?.(name)
  }
  const probeAnswer = options.probe ?? { capable: true, helperPath: HELPER }
  const jumpback: TaskCompletionJumpBack = {
    writeMarker(sessionId, marker) {
      if (options.throwOn === 'writeMarker') throw new Error('marker port exploded')
      record('writeMarker', [sessionId, marker])
      return options.markerPath
    },
    async probe(marker) {
      if (options.throwOn === 'probe') throw new Error('probe port exploded')
      record('probe', [marker])
      return typeof probeAnswer === 'function' ? await probeAnswer() : probeAnswer
    },
    async ensureProtocol(helper) {
      if (options.throwOn === 'ensureProtocol') throw new Error('registry port exploded')
      record('ensureProtocol', [helper])
      return options.register ?? true
    },
  }
  return { steps, jumpback }
}

type PluginRow = Awaited<ReturnType<PluginManagerView['listPlugins']>>[number]

/** The external notifier the delivery chain yields to (D4/AC-6). */
function notifierRow(): PluginRow {
  return {
    entryId: 'notifier' as PluginRow['entryId'],
    moduleName: '@baobaolaodie/cc-dsh-notifier',
    enabled: true,
    fiberPhase: 'active',
    readOnlyReason: 'unaddressable',
  }
}

/** One completion through the real host function; only the ports are stubs. */
async function deliver(options: {
  jumpback: TaskCompletionJumpBack
  platform?: NodeJS.Platform
  sessionId?: string
  plugins?: PluginRow[]
  toast?: WindowsToastResult
  /** Reports the inventory read into a shared log, for ordering against the ports. */
  onInventory?: () => void
}): Promise<{ toastInputs: WindowsToastInput[], terminal: [string, string][] }> {
  const toastInputs: WindowsToastInput[] = []
  const terminal: [string, string][] = []
  const delivery: TaskCompletionDelivery = {
    toast: async input => {
      toastInputs.push(input)
      return options.toast ?? { status: 'shown' }
    },
    terminal: (title, message) => { terminal.push([title, message]) },
    jumpback: options.jumpback,
    sessionId: options.sessionId,
    platform: options.platform,
    pluginManager: options.plugins === undefined ? undefined : {
      listPlugins: async () => {
        options.onInventory?.()
        return options.plugins ?? []
      },
    },
  }
  await deliverTaskCompletionOnWindows(TITLE, '摘要一行', 'dsh', delivery)
  return { toastInputs, terminal }
}

await check('an off switch, or a non-Windows host, sends the plain toast without asking any port', async () => {
  setJumpBackEnabled(false)
  const off = recordingJumpBack()
  const disabled = await deliver({ jumpback: off.jumpback, platform: 'win32' })
  assert.deepEqual(off.steps, [], 'the setting is the cheapest gate: nothing is probed, written or registered (AC-1)')
  assert.equal(disabled.toastInputs.length, 1)
  assert.equal(disabled.toastInputs[0].launch, undefined, 'and the toast is the plain one')

  enableJumpBack()
  const elsewhere = recordingJumpBack()
  const posix = await deliver({ jumpback: elsewhere.jumpback, platform: 'linux' })
  assert.deepEqual(elsewhere.steps, [], 'the title is untagged here, so a promised jump would be the L-080 dead point')
  assert.equal(posix.toastInputs[0].launch, undefined)
})

await check('a capable probe prepares the documented URI, in the documented order', async () => {
  const marker = enableJumpBack()
  const recorder = recordingJumpBack({ markerPath: join(MARKER_DIR, 'session-abc.json') })
  const delivery = await deliver({ jumpback: recorder.jumpback, platform: 'win32', sessionId: 'session-abc' })
  assert.deepEqual(
    recorder.steps,
    [
      { name: 'writeMarker', args: ['session-abc', marker] },
      { name: 'probe', args: [marker] },
      { name: 'ensureProtocol', args: [HELPER] },
    ],
    'AC-9 refreshes the documented file before the probe, and D7 only registers the handler the URI will call',
  )
  assert.equal(
    delivery.toastInputs[0].launch,
    `dsh-tui:activate?m=${marker}`,
    'the URI carries the same published marker the title carries (L-080)',
  )
})

await check('a probe that cannot prove a single target sends the plain toast', async () => {
  enableJumpBack()
  const recorder = recordingJumpBack({ probe: { capable: false, stage: 'probe', reason: 'two panes carry the marker' } })
  const delivery = await deliver({ jumpback: recorder.jumpback, platform: 'win32' })
  assert.deepEqual(
    recorder.steps.map(step => step.name),
    ['writeMarker', 'probe'],
    'the marker file is still refreshed, but no handler is registered for a promise that will not be made',
  )
  assert.equal(delivery.toastInputs[0].launch, undefined, 'AC-3/AC-7: an unverifiable layout gets an ordinary toast')
})

await check('a refused protocol registration sends the plain toast', async () => {
  enableJumpBack()
  const recorder = recordingJumpBack({ register: false })
  const delivery = await deliver({ jumpback: recorder.jumpback, platform: 'win32' })
  assert.equal(delivery.toastInputs[0].launch, undefined, 'a URI whose handler was not registered is a dead click (D7)')
})

await check('a throwing port costs the jump-back promise, not the notification', async () => {
  enableJumpBack()
  for (const throwOn of ['writeMarker', 'probe', 'ensureProtocol'] as const) {
    const recorder = recordingJumpBack({ throwOn })
    const { result, lines } = await captureDebug(() => deliver({ jumpback: recorder.jumpback, platform: 'win32' }))
    assert.equal(result.toastInputs.length, 1, `a ${throwOn} failure must still deliver a notification (AC-3/AC-10)`)
    assert.equal(result.toastInputs[0].launch, undefined)
    assert.match(lines.join(''), /the launch could not be prepared/u, 'and the reason is in the log, not swallowed')
  }
})

await check('an external notifier still gets the seam refreshed, but is never probed or registered', async () => {
  const marker = enableJumpBack()
  // One ordered log across the jump-back ports and the inventory read: the
  // refresh has to happen before the ownership question, or an external plugin
  // reading the seam at completion time may see the previous session (D8/AC-9).
  const order: string[] = []
  const recorder = recordingJumpBack({ onStep: name => order.push(name) })
  const delivery = await deliver({
    jumpback: recorder.jumpback,
    platform: 'win32',
    sessionId: 'session-external',
    plugins: [notifierRow()],
    onInventory: () => order.push('inventory'),
  })
  assert.deepEqual(
    order,
    ['writeMarker', 'inventory'],
    'the documented file is refreshed first and exactly once; the yielded completion is never probed and never registered',
  )
  assert.deepEqual(
    recorder.steps,
    [{ name: 'writeMarker', args: ['session-external', marker] }],
    'the seam names the session that completed, and this process promises nothing else',
  )
  assert.equal(delivery.toastInputs[0].externalNotifierActive, true)
  assert.equal(delivery.toastInputs[0].launch, undefined, 'that toast belongs to the other plugin, so this process may not promise a click (D4)')
})

await check('the marker file is named for the session, or for this process when the id is unusable', async () => {
  const marker = enableJumpBack()
  const named = recordingJumpBack()
  await deliver({ jumpback: named.jumpback, platform: 'win32', sessionId: 'session-abc' })
  assert.deepEqual(named.steps[0], { name: 'writeMarker', args: ['session-abc', marker] }, 'the documented file names the session that completed (D8)')

  for (const sessionId of ['../escape', undefined]) {
    const fallback = recordingJumpBack()
    await deliver({ jumpback: fallback.jumpback, platform: 'win32', sessionId })
    assert.deepEqual(
      fallback.steps[0],
      { name: 'writeMarker', args: [`process-${process.pid}`, marker] },
      'an unsafe or missing id must not decide the path, and the file still has to exist (AC-9)',
    )
  }
})

// --- isolation self-proof (L-049) ---------------------------------------------

assert.equal(DATA_DIR, join(sandboxHome, '.dsh-tui'), 'the throwaway home must own DATA_DIR, or the redirect ran after the import')
assert.equal(existsSync(join(DATA_DIR, 'notify')), false, 'no case reached the production data directory: every orchestration was given its own')

rmSync(sandbox, { recursive: true, force: true })
process.stdout.write(`jump-back regression passed (${passed} checks)\n`)
