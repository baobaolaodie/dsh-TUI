/**
 * Offline executable resolution: env path → PATH → ~/.local/bin → SDK bundle.
 * Env paths are adopted verbatim; other candidates must report a version.
 * Covers dead, versionless and hung candidates, npm binary/script forwarding,
 * runtime decoys, PATH priority and one probe for overlapping native installs.
 *
 * Run: node --import tsx/esm scripts/verify-claude-executable.ts
 */
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { readClaudeVersion, resolveClaudeExecutable } from '../src/backends/claude/process.js'
import { COUNT_LOG_ENV, PACKAGE_ENTRY, countingEntry, probeCalls } from './lib/claude-counting-cli.mjs'

let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

const win = process.platform === 'win32'
// Windows lookup tools may expand os.tmpdir()'s 8.3 short path.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-tui-claude-exe-')))
const originalPath = process.env.PATH
// The lookup tool itself has to stay reachable; everything else is fenced
// off so this machine's own `claude` cannot decide the outcome.
const systemRoot = process.env.SystemRoot ?? 'C:/Windows'
const systemPath = win ? join(systemRoot, 'System32') : '/usr/bin:/bin'
const nodeDir = dirname(process.execPath)
const dir = (name: string): string => {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return path
}
const withPath = (...entries: string[]): void => { process.env.PATH = [...entries, systemPath].join(delimiter) }

/** Fence the native fallback as well as PATH from this machine's own CLI. */
const envFor = (home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ HOME: home, USERPROFILE: home, ...extra })

/** `<home>/.local/bin`, where the official native installer drops the CLI. */
const nativeDir = (home: string): string => {
  const path = join(home, '.local', 'bin')
  mkdirSync(path, { recursive: true })
  return path
}

/** The CLI file name the native installer uses on this platform. */
const nativeName = win ? 'claude.exe' : 'claude'

/** A `claude` this process can really spawn: node prints `v<major>.<minor>.<patch>` for `--version`. */
const spawnableClaude = (target: string): string => {
  copyFileSync(process.execPath, target)
  if (!win) chmodSync(target, 0o755)
  return target
}

/**
 * A `claude` that exists and still cannot be spawned: on Windows the
 * extensionless npm wrapper is exactly this shape (a POSIX script `where`
 * reports first), on POSIX a `+x` script whose interpreter is missing.
 */
const deadClaude = (target: string, text = '#!/nonexistent/dsh-tui-interpreter\n'): string => {
  writeFileSync(target, text)
  if (!win) chmodSync(target, 0o755)
  return target
}

/** The npm wrapper shape: a shell script that execs the packaged binary. */
const forwardingClaude = (target: string, realName: string): string =>
  deadClaude(target, `#!/bin/sh\nbasedir=$(dirname "$0")\nexec "$basedir/${realName}" "$@"\n`)

/** A `claude` that spawns but reports no version the probe accepts. */
const versionlessClaude = (target: string): string => {
  if (win) copyFileSync(join(systemRoot, 'System32', 'where.exe'), target)
  else deadClaude(target, '#!/bin/sh\necho definitely not a claude version\n')
  return target
}

/** The npm `sh` wrapper: a runnable script that execs the package bin through `node`. */
const shWrapper = (entry: string): string =>
  `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/${entry}" "$@"\n`

/** npm's .cmd shape, using platform separators so POSIX can test its parser. */
const cmdWrapper = (entry: string): string => [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%${win ? '\\' : '/'}${entry}" %*`,
  '',
].join('\r\n')

/**
 * npm-shaped sh/.cmd wrappers with an optional script and node.exe decoy.
 * A dead shebang before cmd text forces the parser path on POSIX too.
 */
const npmInstall = (name: string, options: { script?: boolean; runtime?: boolean; wrapper?: 'sh' | 'cmd' } = {}): {
  readonly prefix: string
  readonly entry: string | undefined
  readonly runtimePath: string | undefined
  readonly wrapper: string
} => {
  const prefix = dir(name)
  const entry = options.script === false ? undefined : join(prefix, ...PACKAGE_ENTRY)
  if (entry !== undefined) {
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, "console.log('2.1.287 (Claude Code)')\n")
  }
  const runtimePath = options.runtime === true ? spawnableClaude(join(prefix, 'node.exe')) : undefined
  const cmd = cmdWrapper(join(...PACKAGE_ENTRY))
  const wrapper = options.wrapper === 'cmd'
    ? deadClaude(join(prefix, 'claude'), `#!/nonexistent/dsh-tui-interpreter\n${cmd}`)
    : deadClaude(join(prefix, 'claude'), shWrapper(PACKAGE_ENTRY.join('/')))
  deadClaude(join(prefix, 'claude.cmd'), cmd)
  return { prefix, entry, runtimePath, wrapper }
}

/** Unspawnable wrapper: each parser pass runs the counting entry only once. */
const deadForwarder = (target: string): string => deadClaude(target, cmdWrapper(join(...PACKAGE_ENTRY)))

try {
  // ── a dead wrapper earlier on PATH must not shadow a working binary ────
  {
    const dead = dir('dead-first')
    const live = dir('live-second')
    const deadPath = deadClaude(join(dead, 'claude'))
    const livePath = spawnableClaude(join(live, nativeName))
    withPath(dead, live)
    const resolved = await resolveClaudeExecutable(envFor(dir('home-unused-1')))
    check('a PATH hit that cannot be spawned is skipped', resolved.path !== deadPath, resolved)
    check('the next PATH binary that really launches wins', resolved.source === 'path' && resolved.path === livePath, resolved)
  }

  // ── a candidate that runs but reports no version loses too ─────────────
  {
    const versionless = dir('versionless')
    const live = dir('live-after-versionless')
    versionlessClaude(join(versionless, nativeName))
    const livePath = spawnableClaude(join(live, nativeName))
    withPath(versionless, live)
    const resolved = await resolveClaudeExecutable(envFor(dir('home-unused-2')))
    check('a candidate that spawns but reports no version is skipped', resolved.source === 'path' && resolved.path === livePath, resolved)
  }

  // ── nothing spawnable → no path at all (the SDK's bundled binary) ──────
  {
    const dead = dir('dead-only')
    deadClaude(join(dead, 'claude'))
    withPath(dead)
    const resolved = await resolveClaudeExecutable(envFor(dir('home-empty')))
    check('no spawnable candidate leaves the path to the SDK bundle', resolved.source === 'bundled' && resolved.path === undefined, resolved)
  }

  // ── a forwarding wrapper is followed to the binary it names ────────────
  {
    const shim = dir('npm-shape')
    const wrapperPath = forwardingClaude(join(shim, 'claude'), 'claude-real.exe')
    const realPath = spawnableClaude(join(shim, 'claude-real.exe'))
    withPath(shim)
    const resolved = await resolveClaudeExecutable(envFor(dir('home-unused-3')))
    // Windows cannot spawn the wrapper, so it must resolve through it; POSIX
    // spawns the wrapper itself, which then execs the same binary.
    const expected = win ? realPath : wrapperPath
    check('a forwarding wrapper still yields the user CLI', resolved.source === 'path' && resolved.path === expected, resolved)
  }

  // ── a hung candidate is skipped after the probe's bounded timeout ──────
  if (win) {
    console.log('SKIP a hung candidate is skipped after the bounded probe (no spawnable hang fixture on Windows without a compiler)')
  } else {
    const hang = dir('hang-only')
    deadClaude(join(hang, 'claude'), '#!/bin/sh\nsleep 30\n')
    withPath(hang)
    const started = Date.now()
    const resolved = await resolveClaudeExecutable(envFor(dir('home-unused-4')))
    check('a hung candidate is skipped after the bounded probe, then the SDK bundle', resolved.source === 'bundled' && resolved.path === undefined && Date.now() - started >= 9000, resolved)
  }

  // ── CLAUDE_CODE_EXECUTABLE: explicit wins, and is never second-guessed ──
  {
    const dead = dir('env-dead')
    const warned = deadClaude(join(dead, 'claude'))
    const live = spawnableClaude(join(dir('env-live'), nativeName))
    withPath(dead)
    const configured = await resolveClaudeExecutable(envFor(dir('home-unused-5'), { CLAUDE_CODE_EXECUTABLE: live }))
    check('CLAUDE_CODE_EXECUTABLE wins over PATH', configured.source === 'env' && configured.path === live, configured)
    const typo = await resolveClaudeExecutable(envFor(dir('home-unused-6'), { CLAUDE_CODE_EXECUTABLE: warned }))
    check('a dead explicit path is returned as-is (fails loudly, not silently)', typo.source === 'env' && typo.path === warned, typo)
  }

  // ── AC-1: the native install directory counts even when it is not PATH ──
  {
    const home = dir('home-native')
    const nativePath = spawnableClaude(join(nativeDir(home), nativeName))
    withPath(dir('nothing-on-path'))
    const resolved = await resolveClaudeExecutable(envFor(home))
    check('AC-1 a native install outside PATH is adopted, and not the SDK bundle', resolved.path === nativePath && resolved.source === 'path', resolved)
  }

  // ── AC-2: PATH still wins over the native install directory ────────────
  {
    const home = dir('home-shadowed')
    const nativePath = spawnableClaude(join(nativeDir(home), nativeName))
    const pathDir = dir('path-wins')
    const pathPath = spawnableClaude(join(pathDir, nativeName))
    withPath(pathDir)
    const resolved = await resolveClaudeExecutable(envFor(home))
    check('AC-2 a PATH hit wins: the shadowed native install is not adopted', resolved.path === pathPath && resolved.path !== nativePath, resolved)
  }

  // ── AC-3: a native install that cannot answer is not adopted ───────────
  {
    const deadHome = dir('home-native-dead')
    deadClaude(join(nativeDir(deadHome), nativeName))
    withPath(dir('nothing-else'))
    const dead = await resolveClaudeExecutable(envFor(deadHome))

    const muteHome = dir('home-native-mute')
    versionlessClaude(join(nativeDir(muteHome), nativeName))
    const mute = await resolveClaudeExecutable(envFor(muteHome))
    check('AC-3 a native install that cannot answer is not adopted',
      dead.source === 'bundled' && dead.path === undefined && mute.source === 'bundled' && mute.path === undefined,
      { dead, mute })
  }

  // ── a file both PATH and the native directory name is probed once ──────
  {
    const home = dir('home-dedupe')
    const bin = nativeDir(home)
    const log = join(dir('dedupe-log'), 'calls.log')
    // A versionless CLI makes the loop reach any duplicate candidate.
    countingEntry(bin, undefined)
    deadForwarder(join(bin, nativeName))
    process.env[COUNT_LOG_ENV] = log
    // Control: prove the counting entry is reached through the fallback alone.
    withPath(dir('nothing-dedupe'), nodeDir)
    const alone = await resolveClaudeExecutable(envFor(home))
    const aloneCalls = probeCalls(log).length
    writeFileSync(log, '')
    // PATH and the native fallback now name the same file.
    withPath(bin, nodeDir)
    const overlapped = await resolveClaudeExecutable(envFor(home))
    check('a file both PATH and the native directory name is probed once',
      aloneCalls === 1 && probeCalls(log).length === 1,
      { aloneCalls, overlappedCalls: probeCalls(log).length, alone, overlapped })
    delete process.env[COUNT_LOG_ENV]
  }

  // ── AC-4: a real npm install resolves to the entry it runs ─────────────
  {
    const install = npmInstall('npm-real', { script: true })
    withPath(install.prefix, nodeDir)
    const resolved = await resolveClaudeExecutable(envFor(dir('home-no-native-1')))
    // POSIX runs the sh wrapper; Windows must follow it to cli.js.
    const expected = win ? install.entry : install.wrapper
    check('AC-4 the npm install resolves to the entry it runs, not the SDK bundle', resolved.source === 'path' && resolved.path === expected, resolved)
    const version = resolved.path === undefined ? undefined : await readClaudeVersion(resolved.path)
    check('AC-4 the resolved npm entry reports a version through the probe', version === '2.1.287', version)
  }

  // ── AC-4 (parser shape): the `.cmd` text is followed on any platform ───
  {
    const install = npmInstall('npm-cmd-text', { script: true, wrapper: 'cmd' })
    withPath(install.prefix, nodeDir)
    const resolved = await resolveClaudeExecutable(envFor(dir('home-no-native-2')))
    check('AC-4 the wrapper text is followed to the package entry', resolved.path === install.entry, resolved)
  }

  // ── R2: the runtime a wrapper names is never the CLI ───────────────────
  {
    const decoy = npmInstall('npm-decoy-only', { script: false, runtime: true, wrapper: 'cmd' })
    withPath(decoy.prefix, nodeDir)
    const resolved = await resolveClaudeExecutable(envFor(dir('home-no-native-3')))

    const both = npmInstall('npm-decoy-script', { script: true, runtime: true, wrapper: 'cmd' })
    withPath(both.prefix, nodeDir)
    const picked = await resolveClaudeExecutable(envFor(dir('home-no-native-4')))
    check('the runtime a wrapper names is never the CLI: the bundle without a script, the script with one',
      decoy.runtimePath !== undefined && resolved.path !== decoy.runtimePath && resolved.source === 'bundled'
        && picked.path === both.entry,
      { resolved, picked })
  }
} finally {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  rmSync(root, { recursive: true, force: true })
}

console.log(`\nverify-claude-executable OK (${passed} checks)`)
