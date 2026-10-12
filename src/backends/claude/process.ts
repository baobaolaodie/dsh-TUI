/**
 * The `claude` child process as this backend starts it:
 * which executable, with which environment, and where its stderr goes.
 *
 * - Executable: `CLAUDE_CODE_EXECUTABLE` → the first `claude` on PATH that
 *   actually launches → the native installer's `~/.local/bin` → the SDK's own
 *   bundled binary (left to the SDK by passing no path). A PATH binary wins
 *   over the bundled one so the session shares the user's interactive CLI
 *   version and session store, and it wins over the native directory too: the
 *   fallback must not invert a copy the user put on PATH themselves. Merely
 *   existing is not enough to win: an npm install also ships shims this
 *   process cannot spawn (on Windows the extensionless POSIX `sh` script
 *   `where` reports first, and a `.cmd` Node refuses to run without a
 *   shell), and handing one to the SDK fails the whole start with its own
 *   misleading "native binary … failed to launch" error. A shim is followed
 *   to the entry it really runs: a binary, or the package's `cli.js`, which
 *   the SDK starts as `node <entry>`.
 * - Environment: the SDK's `env` option replaces the child environment, so it
 *   is built from `process.env`, tagged with the client app and the session
 *   state events this backend reads, and scrubbed of the variables a parent
 *   Claude Code terminal exports (dsh-tui may itself run inside one; the
 *   child must not believe it is a nested entrypoint or join that session).
 * - stderr: never inherited (it would tear the alternate screen); every line
 *   goes to the debug log and to the host's deduplicated notice reporter.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path'

/** Where the executable came from (`/doctor`). */
export type ClaudeExecutableSource = 'env' | 'path' | 'bundled'

export interface ClaudeExecutable {
  /** Absolute path, or undefined to let the SDK use its bundled binary. */
  readonly path: string | undefined
  readonly source: ClaudeExecutableSource
}

/**
 * Variables a parent Claude Code session exports that must not leak. The CLI
 * reads several of them at start: `CLAUDE_CODE_CHILD_SESSION` and
 * `CLAUDE_CODE_SESSION_ATTENDED` would make our child run as the parent's
 * child session; the pid, exec path, effort, invoked skills, agent marker
 * and trace parent would attribute it to the parent's process and trace.
 */
const SCRUBBED_EXACT = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID', 'AI_AGENT',
  'TRACEPARENT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_EFFORT', 'CLAUDE_CODE_INVOKED_SKILLS',
] as const
const SCRUBBED_PREFIX = 'CLAUDE_CODE_MESSAGING_'

/** Every existing `name` on PATH, in the platform tool's own order. */
function whichAll(name: string): Promise<string[]> {
  const win = process.platform === 'win32'
  const tool = win ? 'where' : 'which'
  const args = win ? [name] : ['-a', name]
  return new Promise(resolve => {
    try {
      execFile(tool, args, { timeout: 5000, windowsHide: true }, (error, stdout) => {
        // `where` exits non-zero when nothing matches; `which -a` may too.
        if (error !== null && String(stdout).trim() === '') { resolve([]); return }
        resolve(String(stdout).split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '' && existsSync(line)))
      })
    } catch {
      resolve([])
    }
  })
}

/**
 * The suffixes the SDK starts through `node`/`bun` instead of spawning the
 * path directly (its own `Ki` predicate, pinned to the same list in the same
 * order). Keep the two in step: a path this backend accepts has to be a path
 * the SDK can start, and the probe below has to start it the same way.
 */
const SCRIPT_SUFFIXES = ['.js', '.mjs', '.tsx', '.ts', '.jsx'] as const

/** Whether the SDK would run this path as a script rather than spawn it. */
const isScriptEntry = (path: string): boolean => SCRIPT_SUFFIXES.some(suffix => path.endsWith(suffix))

/**
 * The JavaScript runtime a wrapper names to *run* its script (`"%_prog%"
 * "%dp0%\…\cli.js"`): how to start the CLI, never the CLI. Adopting it would
 * hand the SDK `node <claude args>`, so it is not a candidate even when the
 * file is really there.
 */
const RUNTIME_PROGRAMS = ['node', 'node.exe', 'bun', 'bun.exe']

/**
 * The real entry an unspawnable PATH shim forwards to, if it names one.
 *
 * npm publishes a package's bin as wrappers around the truth: an
 * extensionless POSIX `sh` script, a `.cmd` and a `.ps1`. On Windows the
 * first two are what `where` reports and neither can be handed to
 * CreateProcess — but each ends in the absolute path of the entry an
 * interactive `claude` runs, so following it keeps the user's own CLI
 * instead of silently switching to the SDK's bundled copy. That entry is the
 * package's `cli.js` for an npm install (the SDK starts it with `node`) and a
 * binary otherwise; the runtime named beside it only says how to run it. The
 * shim is read bounded, `%~dp0`, `%dp0%` and `$basedir` are expanded, and
 * every candidate still has to launch to win.
 */
function shimTarget(shim: string): string | undefined {
  let text: string
  try {
    text = readFileSync(shim, 'latin1').slice(0, 64 * 1024)
  } catch {
    return undefined
  }
  const dir = dirname(shim)
  const expanded = text
    .replace(/%~dp0%?/giu, dir + sep)
    .replace(/%dp0%/giu, dir + sep)
    .replace(/\$\{?basedir\}?/gu, dir)
  const firstOnDisk = (pattern: RegExp, reject?: (candidate: string) => boolean): string | undefined => {
    for (const match of expanded.match(pattern) ?? []) {
      const candidate = match.replace(/^["']|["']$/gu, '').trim()
      if (!isAbsolute(candidate) || !existsSync(candidate)) continue
      if (reject !== undefined && reject(candidate)) continue
      return normalize(candidate)
    }
    return undefined
  }
  // npm's wrapper names the runtime first and the script second
  // (`"%_prog%" "%dp0%\node_modules\…\cli.js" %*`), so the script is the CLI
  // whenever there is one; only a wrapper with no script left to follow may
  // fall back to a binary — and never to the runtime that would run one.
  // Every extension is matched here and `isScriptEntry` decides, so the list
  // of suffixes the probe accepts stays the only place that defines it.
  const script = firstOnDisk(
    /"[^"\r\n]*?\.[\w]+(?![\w.])"|'[^'\r\n]*?\.[\w]+(?![\w.])'|[^\s"']*?\.[\w]+(?![\w.])/giu,
    candidate => !isScriptEntry(candidate),
  )
  if (script !== undefined) return script
  return firstOnDisk(
    /"[^"\r\n]*?\.exe"|'[^'\r\n]*?\.exe'|[^\s"']*?\.exe/giu,
    candidate => RUNTIME_PROGRAMS.includes(basename(candidate).toLowerCase()),
  )
}

/**
 * The user's home directory as the given environment reports it. A POSIX
 * `HOME` is a POSIX path, so on Windows `USERPROFILE` is the one that can be
 * joined to a real path; the other is only consulted when the first is absent
 * (and `os.homedir()` when neither is there at all).
 */
function homeDir(env: NodeJS.ProcessEnv): string {
  const [first, second] = process.platform === 'win32' ? [env.USERPROFILE, env.HOME] : [env.HOME, env.USERPROFILE]
  for (const value of [first, second]) if (value !== undefined && value !== '') return value
  return homedir()
}

/**
 * Where the official native installer drops the CLI: `~/.local/bin`
 * (`claude.exe` on Windows, `claude` elsewhere) — a directory it does **not**
 * put on PATH on Windows, so a PATH-only probe never sees it. Only that one
 * file per platform is a candidate; other install shapes are out of scope.
 */
function nativeInstall(env: NodeJS.ProcessEnv): string[] {
  const home = homeDir(env)
  if (home === '') return []
  const candidate = join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  return existsSync(candidate) ? [candidate] : []
}

/** Resolve the executable (never throws; the SDK binary is the fallback). */
export async function resolveClaudeExecutable(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeExecutable> {
  const configured = env.CLAUDE_CODE_EXECUTABLE
  if (configured !== undefined && configured !== '' && existsSync(configured)) return { path: configured, source: 'env' }
  // A candidate that cannot report its version cannot be spawned either (a
  // hung one is cut off by the probe's timeout), so a dead shim never
  // shadows a working copy further down PATH — or the bundled binary. An
  // explicit `CLAUDE_CODE_EXECUTABLE` above stays unvalidated on purpose:
  // a typo the user made should fail loudly, not silently.
  // PATH comes first, the native install directory only after it: a copy the
  // user put on PATH is the one they chose, and this fallback must not invert
  // it. Both go through the same per-candidate probe, shim following included.
  for (const candidate of [...await whichAll('claude'), ...nativeInstall(env)]) {
    if (await readClaudeVersion(candidate) !== undefined) return { path: candidate, source: 'path' }
    const target = shimTarget(candidate)
    if (target !== undefined && await readClaudeVersion(target) !== undefined) return { path: target, source: 'path' }
  }
  return { path: undefined, source: 'bundled' }
}

/**
 * The child environment.
 *
 * `appVersion` is the running TUI's version as the host reports it
 * (`BackendHost.appVersion`) — the backend does not read the host's own
 * `package.json` (B-3). Absent (a host that cannot tell, an uninstalled
 * checkout) keeps the long-standing `dev` tag.
 */
export function buildClaudeEnv(options: { readonly appVersion?: string; readonly base?: NodeJS.ProcessEnv } = {}): Record<string, string> {
  const base = options.base ?? process.env
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if ((SCRUBBED_EXACT as readonly string[]).includes(key) || key.startsWith(SCRUBBED_PREFIX)) continue
    env[key] = value
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `dsh-tui/${options.appVersion ?? 'dev'}`
  // `system/session_state_changed` is the authoritative idle signal; the CLI
  // only emits it when asked.
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1'
  return env
}

/**
 * Run `<executable> --version` and pull out the version (best-effort).
 *
 * A script entry is run the way the SDK runs it — `node <entry> --version`:
 * the SDK appends a `.js`/`.mjs`/`.tsx`/`.ts`/`.jsx` path to `node`, so
 * spawning it directly would report "no version" for the very entry the SDK
 * would have started. `node` (not one particular binary) keeps the probe and
 * the SDK on the same lookup: a host that cannot find it falls back to the
 * bundled binary instead of accepting an entry the SDK then cannot start.
 */
export function readClaudeVersion(executable: string, appVersion?: string): Promise<string | undefined> {
  const script = isScriptEntry(executable)
  const command = script ? 'node' : executable
  const args = script ? [executable, '--version'] : ['--version']
  return new Promise(resolve => {
    try {
      execFile(command, args, { timeout: 10000, windowsHide: true, env: buildClaudeEnv({ appVersion }) }, (error, stdout) => {
        if (error !== null) { resolve(undefined); return }
        resolve(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/u.exec(String(stdout))?.[0])
      })
    } catch {
      resolve(undefined)
    }
  })
}

/**
 * The SDK `stderr` callback: chunks are split into lines; each non-empty line
 * goes to `line` (the host's debug log + deduplicating notice reporter).
 */
export function createStderrSink(line: (text: string) => void): (data: string) => void {
  let partial = ''
  return data => {
    const lines = (partial + data).split(/\r?\n/u)
    partial = lines.pop() ?? ''
    for (const text of lines) if (text.trim() !== '') line(text)
  }
}
