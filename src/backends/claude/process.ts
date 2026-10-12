/**
 * The `claude` child process as this backend starts it:
 * which executable, with which environment, and where its stderr goes.
 *
 * - Executable: `CLAUDE_CODE_EXECUTABLE` → launchable PATH hit →
 *   `~/.local/bin` → SDK bundle. Unspawnable npm shims are followed to their
 *   binary or script entry; the winning probe's version is reused.
 * - Environment: the SDK's `env` option replaces the child environment, so it
 *   is built from `process.env`, tagged with the client app and the session
 *   state events this backend reads, and scrubbed of the variables a parent
 *   Claude Code terminal exports (dsh-tui may itself run inside one; the
 *   child must not believe it is a nested entrypoint or join that session).
 * - stderr: never inherited (it would tear the alternate screen); every line
 *   goes to the debug log and to the host's deduplicated notice reporter.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path'

/** Where the executable came from (`/doctor`). */
export type ClaudeExecutableSource = 'env' | 'path' | 'bundled'

export interface ClaudeExecutable {
  /** Absolute path, or undefined to let the SDK use its bundled binary. */
  readonly path: string | undefined
  readonly source: ClaudeExecutableSource
  /** Winning probe's version; absent for an unprobed env path or SDK bundle. */
  readonly version?: string
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

/** Script suffixes recognized by the pinned SDK's process transport. */
const SCRIPT_SUFFIXES = ['.js', '.mjs', '.tsx', '.ts', '.jsx'] as const

/** Whether the SDK would run this path as a script rather than spawn it. */
const isScriptEntry = (path: string): boolean => SCRIPT_SUFFIXES.some(suffix => path.endsWith(suffix))

/** A wrapper's runtime is not its CLI entry, even when it exists on disk. */
const RUNTIME_PROGRAMS = ['node', 'node.exe', 'bun', 'bun.exe']

/**
 * Follow an unspawnable npm shim (`sh`, `.cmd`, `.ps1`) to its real entry.
 * Windows cannot spawn the wrappers directly; the returned binary or script
 * must still pass the version probe before the SDK receives it.
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
  // Prefer the script over the runtime named before it. isScriptEntry keeps
  // suffix handling shared with the probe.
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

/** Prefer USERPROFILE on Windows: a shell's HOME may be a POSIX path. */
function homeDir(env: NodeJS.ProcessEnv): string {
  const [first, second] = process.platform === 'win32' ? [env.USERPROFILE, env.HOME] : [env.HOME, env.USERPROFILE]
  for (const value of [first, second]) if (value !== undefined && value !== '') return value
  return homedir()
}

/** The native installer's directory is not added to PATH on Windows. */
function nativeInstall(env: NodeJS.ProcessEnv): string[] {
  const home = homeDir(env)
  if (home === '') return []
  const candidate = join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  return existsSync(candidate) ? [candidate] : []
}

/** Match symlinks, Windows short paths and case variants of the same file. */
function candidateKey(path: string): string {
  let real = path
  try {
    real = realpathSync.native(path)
  } catch {
    // The candidate may have disappeared since lookup; keep its original path.
  }
  const normalized = normalize(real)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** The candidates in order, each file named once (see {@link candidateKey}). */
function dedupeCandidates(candidates: readonly string[]): string[] {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const candidate of candidates) {
    const key = candidateKey(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(candidate)
  }
  return kept
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
  // Preserve PATH priority; overlapping native installs must not pay the
  // probe timeout twice.
  for (const candidate of dedupeCandidates([...await whichAll('claude'), ...nativeInstall(env)])) {
    const version = await readClaudeVersion(candidate)
    if (version !== undefined) return { path: candidate, source: 'path', version }
    const target = shimTarget(candidate)
    if (target === undefined) continue
    const targetVersion = await readClaudeVersion(target)
    if (targetVersion !== undefined) return { path: target, source: 'path', version: targetVersion }
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

/** Read `--version`, starting script entries through `node` as the SDK does. */
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
