/**
 * `claude` executable resolution: which hit this backend may hand to the SDK.
 * Offline: no CLI, no network.
 *
 *  - the order is fixed: `CLAUDE_CODE_EXECUTABLE` (verbatim, never validated —
 *    a typo the user made should fail loudly, not silently change binaries),
 *    the first PATH hit that really launches, the native install directory
 *    (`~/.local/bin`, which the official installer does not put on PATH on
 *    Windows: claude-code#86999), then no path at all — which is how the SDK
 *    is told to use its own bundled binary (the documented last resort);
 *  - a PATH hit always beats the native install directory: a copy the user put
 *    on PATH is the one they chose, and this fallback must not invert it;
 *  - a candidate only wins when this process can spawn it (`--version`
 *    through the same execFile path the SDK uses). An npm install publishes
 *    the package bin as wrappers (an extensionless POSIX `sh` script first,
 *    a `.cmd` second), neither of which Windows can run without a shell —
 *    so "the file exists" is not enough, and handing one to the SDK fails
 *    the whole start with its own misleading "native binary … failed to
 *    launch";
 *  - a wrapper that merely forwards to the real entry is followed instead
 *    of skipped, so a Windows npm install still runs the user's own CLI
 *    (its version and session store) rather than silently switching to the
 *    SDK's bundled copy. The entry may be the package's `cli.js`: the SDK
 *    starts a `.js`/`.mjs`/`.tsx`/`.ts`/`.jsx` path as `node <entry>`, so the
 *    probe runs it the same way instead of discarding the one path the SDK
 *    would have started for reporting no version;
 *  - the runtime a wrapper names to run that script (`%dp0%\node.exe`) is
 *    never the CLI, even when it exists beside the wrapper;
 *  - a candidate that spawns but reports no version loses too, and one that
 *    hangs is skipped after the probe's bounded timeout (POSIX fixture;
 *    Windows has no spawnable hang without a compiler) — never waited for.
 *
 * Run: node --import tsx/esm scripts/verify-claude-executable.ts
 */
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { readClaudeVersion, resolveClaudeExecutable } from '../src/backends/claude/process.js'

let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

const win = process.platform === 'win32'
// `os.tmpdir()` can answer with the 8.3 short form (`C:\Users\LONGYI~1\…`)
// while the lookup tools report the long one; both spell the same directory,
// so the fixture root is canonicalized once and every compared path has a
// single spelling.
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

/**
 * The environment one resolution call gets. PATH is fenced above, but the
 * home directory — where the native install fallback looks — is read off this
 * argument, so it has to be pinned too: otherwise this machine's own
 * `~/.local/bin/claude` would decide the outcome of every check.
 */
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

/** Where an npm-installed `@anthropic-ai/claude-code` keeps its bin. */
const PACKAGE_ENTRY = ['node_modules', '@anthropic-ai', 'claude-code', 'cli.js']

/** The npm `sh` wrapper: a runnable script that execs the package bin through `node`. */
const shWrapper = (entry: string): string =>
  `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/${entry}" "$@"\n`

/**
 * The npm `.cmd` wrapper Windows runs, down to its real trailing line: the
 * runtime comes first (a `node.exe` beside the wrapper beats the `node` on
 * PATH) and the package's script is what it actually runs. The separators are
 * this platform's, so the text names a file that really exists here too.
 */
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
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${entry}" %*`,
  '',
].join('\r\n')

/**
 * A real npm global install as the lookup tools see it: the extensionless
 * wrapper, the `.cmd` Windows runs, and the package `cli.js` they forward to.
 *
 *  - `script: false` leaves the package bin out, so only the runtime named by
 *    the wrapper (`node.exe`) is left to grab — the decoy that must never be
 *    mistaken for the CLI (DESIGN risk R2);
 *  - `runtime: true` drops a spawnable `node.exe` beside the wrappers;
 *  - `wrapper: 'sh'` is the runnable `sh` wrapper npm publishes (POSIX runs
 *    it, Windows cannot spawn it); `wrapper: 'cmd'` is the `.cmd` text under a
 *    dead shebang, which no platform can spawn — that check is about the
 *    parse, and it is the only way to reach the `.cmd` shape on POSIX, where
 *    `which` reports just this one file.
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
    check('AC-1 a native install outside PATH is adopted', resolved.path === nativePath, resolved)
    check('AC-1 the native install is not reported as the SDK bundle', resolved.source === 'path', resolved)
  }

  // ── AC-2: PATH still wins over the native install directory ────────────
  {
    const home = dir('home-shadowed')
    const nativePath = spawnableClaude(join(nativeDir(home), nativeName))
    const pathDir = dir('path-wins')
    const pathPath = spawnableClaude(join(pathDir, nativeName))
    withPath(pathDir)
    const resolved = await resolveClaudeExecutable(envFor(home))
    check('AC-2 a PATH hit wins over the native install directory', resolved.path === pathPath, resolved)
    check('AC-2 the shadowed native install is not the one adopted', resolved.path !== nativePath, resolved)
  }

  // ── AC-3: a native install that cannot answer is not adopted ───────────
  {
    const deadHome = dir('home-native-dead')
    deadClaude(join(nativeDir(deadHome), nativeName))
    withPath(dir('nothing-else'))
    const dead = await resolveClaudeExecutable(envFor(deadHome))
    check('AC-3 a native install that cannot be spawned is not adopted', dead.source === 'bundled' && dead.path === undefined, dead)

    const muteHome = dir('home-native-mute')
    versionlessClaude(join(nativeDir(muteHome), nativeName))
    const mute = await resolveClaudeExecutable(envFor(muteHome))
    check('AC-3 a native install that reports no version is not adopted', mute.source === 'bundled' && mute.path === undefined, mute)
  }

  // ── AC-4: a real npm install resolves to the entry it runs ─────────────
  {
    const install = npmInstall('npm-real', { script: true })
    withPath(install.prefix, nodeDir)
    const resolved = await resolveClaudeExecutable(envFor(dir('home-no-native-1')))
    check('AC-4 an npm-installed claude is not the SDK bundle', resolved.source === 'path' && resolved.path !== undefined, resolved)
    // Windows cannot spawn either wrapper, so resolution follows one to the
    // package entry the SDK starts as `node <entry>`; POSIX spawns the `sh`
    // wrapper itself, which then execs that same entry.
    const expected = win ? install.entry : install.wrapper
    check('AC-4 the npm install resolves to the entry it runs', resolved.path === expected, resolved)
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
    check('a wrapper naming only its runtime never yields that runtime', decoy.runtimePath !== undefined && resolved.path !== decoy.runtimePath, resolved)
    check('a wrapper with nothing but its runtime falls back to the bundle', resolved.source === 'bundled', resolved)

    const both = npmInstall('npm-decoy-script', { script: true, runtime: true, wrapper: 'cmd' })
    withPath(both.prefix, nodeDir)
    const picked = await resolveClaudeExecutable(envFor(dir('home-no-native-4')))
    check('the package entry wins over the runtime named beside it', picked.path === both.entry, picked)
  }
} finally {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  rmSync(root, { recursive: true, force: true })
}

console.log(`\nverify-claude-executable OK (${passed} checks)`)
