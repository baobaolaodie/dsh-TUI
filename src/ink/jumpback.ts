/**
 * Jump-back orchestration (DESIGN D4/D7/D8): the single place that asks whether
 * this pane can be promised a jump, registers the `dsh-tui:` protocol a toast
 * click comes back through, and keeps the documented marker files truthful.
 *
 * The UIA work itself belongs to the helper under `notify-helper/`. This module
 * only decides whether to promise a jump (D4), writes the HKCU value that makes
 * the promise reachable (D7), and owns the marker-file lifecycle (D8).
 *
 * Every system side effect sits behind the win32 guard and behind the injected
 * ports, so a POSIX process neither writes the registry nor leaves marker files.
 * Nothing here throws: a failure answers "not capable", the caller degrades to a
 * plain toast, and the stage and reason stay in the debug log (AC-3/AC-9).
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pidAlive } from '../sessionMounts.js'
import { logForDebugging } from '../utils/debug.js'
import { execFileNoThrow } from '../utils/execFileNoThrow.js'
import type { ExecFileNoThrowResult } from '../utils/execFileNoThrow.js'
import { DATA_DIR } from '../utils/paths.js'
import { ensureHelper } from './notify-helper/compile.js'

/**
 * The URI scheme root (D7). Windows only hands `dsh-tui:` to a handler when this
 * key carries the named value `URL Protocol`; the command a click runs lives in
 * the subkey below it.
 */
export const JUMP_BACK_PROTOCOL_KEY = 'HKCU\\Software\\Classes\\dsh-tui'

/**
 * The command a toast click runs (D7). The value quotes both the helper and the
 * data directory: Windows starts the handler from the shell, which inherits no
 * environment of ours, so the helper must be told where the profile lives
 * explicitly (L-077).
 */
export const JUMP_BACK_PROTOCOL_COMMAND_KEY = `${JUMP_BACK_PROTOCOL_KEY}\\shell\\open\\command`

/** The named value that marks the scheme root as a URI handler; its data is empty (D7). */
const URL_PROTOCOL_VALUE = 'URL Protocol'

/** 16 lowercase hex characters; the title, the URI and the marker file all carry this (D2). */
const MARKER_PATTERN = /^[0-9a-f]{16}$/u

/**
 * A session id becomes a file name, so only characters that cannot introduce a
 * path separator are admitted. DSH session ids are `session-<uuid>`; `.` and
 * `..` are harmless here because `.json` is appended, so neither can name the
 * marker directory itself.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u

/** The helper probes in ~0.5 s (D4); 1.5 s means stuck, not slow. */
const PROBE_TIMEOUT_MS = 1_500

/** `reg.exe` answers in milliseconds; a write that takes longer is stuck, not slow (D7). */
const REGISTRY_TIMEOUT_MS = 15_000

/** A marker file is stale after a week even when its pid still answers (D8). */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1_000

/** Why a probe did not promise a jump; each one is a degradation, never a throw. */
export type JumpBackProbeStage = 'not-win32' | 'marker' | 'helper' | 'probe' | 'unexpected'

/** The pre-toast answer (D4): capable only when the helper exited 0. */
export type JumpBackProbe =
  | { readonly capable: true, readonly helperPath: string }
  | { readonly capable: false, readonly stage: JumpBackProbeStage, readonly reason: string }

/**
 * The ports a regression injects. Every one of them has the production default
 * named in its comment, so T09 can drive the whole orchestration without the
 * registry, without csc and without the real profile directory.
 */
export interface JumpBackPorts {
  /** Platform override for the regression; production is `process.platform`. */
  platform?: NodeJS.Platform
  /** Environment for the `%WINDIR%` lookup; defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Process runner for `reg.exe` and the helper; defaults to `execFileNoThrow`. */
  run?: typeof execFileNoThrow
  /** Clock for `startedAt` and the stale sweep; defaults to `Date.now`. */
  now?: () => number
  /** Data directory (`~/.dsh-tui` normally); defaults to {@link DATA_DIR}. */
  dataDir?: string
  /** Resolves the compiled helper; defaults to {@link ensureHelper}, the only compiler. */
  helperPath?: () => Promise<string | undefined>
}

/** The jump-back orchestration one process owns. */
export interface JumpBack {
  /** Decide before a toast whether a click can be promised to land on this pane (D4). */
  probe(marker: string): Promise<JumpBackProbe>
  /** Lazily register the protocol key once per process (D7). */
  ensureProtocol(helperPath: string): Promise<boolean>
  /** Remove the protocol key; a missing key is not an error (D7). */
  unregisterProtocol(): Promise<void>
  /** Write the documented read-only marker file for one session (D8). */
  writeMarker(sessionId: string, marker: string): string | undefined
  /** Remove what this process left behind: the key if it registered it, and its marker files. */
  cleanup(): Promise<void>
  /** Remove marker files whose owner is gone or older than a week (D8 startup cleanup). */
  sweepStale(): void
}

/**
 * Create the orchestration for one process.
 * @param ports Ports and paths; every one of them has a production default.
 * @returns The jump-back orchestration.
 */
export function createJumpBack(ports: JumpBackPorts = {}): JumpBack {
  const platform = ports.platform ?? process.platform
  const env = ports.env ?? process.env
  const run = ports.run ?? execFileNoThrow
  const resolveHelper = ports.helperPath ?? ensureHelper
  const now = ports.now ?? Date.now
  const dataDir = ports.dataDir ?? DATA_DIR
  const markerDir = join(dataDir, 'notify', 'jumpback')

  /** Marker files this process wrote; the only ones cleanup may remove. */
  const written = new Set<string>()
  /** Whether this process registered the key, so cleanup only removes its own. */
  let registered = false
  /** The one registration in flight, so concurrent notifications share it. */
  let pendingRegistration: Promise<boolean> | undefined

  const unavailable = (stage: JumpBackProbeStage, reason: string): JumpBackProbe => {
    logForDebugging('jumpback: probe unavailable', { stage, reason })
    return { capable: false, stage, reason }
  }

  async function probe(marker: string): Promise<JumpBackProbe> {
    try {
      // The platform gate comes first: a non-Windows process has no UIA to ask.
      if (platform !== 'win32') return unavailable('not-win32', `the platform is ${platform}`)
      if (!MARKER_PATTERN.test(marker)) {
        return unavailable('marker', 'expected 16 lowercase hex characters')
      }
      const helper = await resolveHelper()
      if (helper === undefined) return unavailable('helper', 'the helper could not be compiled')
      const result = await run(helper, ['--probe', marker, '-DataDir', dataDir], {
        timeout: PROBE_TIMEOUT_MS,
      })
      if (result.code !== 0) return unavailable('probe', probeFailure(result))
      logForDebugging('jumpback: the helper reports a reachable target', { marker })
      return { capable: true, helperPath: helper }
    } catch (error) {
      // A rejecting port must not reach the notification path (AC-3).
      return unavailable('unexpected', describe(error))
    }
  }

  async function register(helper: string): Promise<boolean> {
    if (platform !== 'win32') {
      logForDebugging('jumpback: protocol registration skipped', { reason: 'not-win32' })
      return false
    }
    const reg = regExe(env)
    if (reg === undefined) {
      logForDebugging('jumpback: protocol registration skipped', { reason: 'system-root-missing' })
      return false
    }
    if (helper === '' || helper.includes('"')) {
      // Recording an unquotable path would produce a handler that silently
      // never starts; refuse now so the click degrades to a plain toast.
      logForDebugging('jumpback: protocol registration refused', {
        reason: 'the helper path cannot be quoted',
        helper,
      })
      return false
    }
    const command = `"${helper}" --activate "%1" -DataDir "${dataDir}"`
    // Windows needs both halves of the registration: the empty `URL Protocol`
    // marker on the root, and the command below it. Either refusal means no
    // click can be promised, and a half-written key is never remembered as
    // registered, so the next notification retries both (D7/F-1).
    const writes = [
      { key: JUMP_BACK_PROTOCOL_KEY, name: URL_PROTOCOL_VALUE, data: '' },
      { key: JUMP_BACK_PROTOCOL_COMMAND_KEY, name: null, data: command },
    ] as const
    for (const write of writes) {
      const detail = await addRegistryValue(run, reg, write)
      if (detail !== undefined) {
        logForDebugging('jumpback: protocol registration failed', {
          key: write.key,
          value: write.name ?? '(default)',
          detail,
        })
        return false
      }
    }
    registered = true
    logForDebugging('jumpback: protocol registered', { key: JUMP_BACK_PROTOCOL_KEY })
    return true
  }

  function ensureProtocol(helper: string): Promise<boolean> {
    if (registered) return Promise.resolve(true)
    if (pendingRegistration !== undefined) return pendingRegistration
    // A failed attempt is not cached: the next notification retries, which is
    // the recovery path DESIGN D7 asks for after a transient policy refusal.
    pendingRegistration = register(helper)
      .catch((error: unknown) => {
        logForDebugging('jumpback: protocol registration threw', { detail: describe(error) })
        return false
      })
      .finally(() => {
        pendingRegistration = undefined
      })
    return pendingRegistration
  }

  async function unregisterProtocol(): Promise<void> {
    registered = false
    try {
      if (platform !== 'win32') return
      const reg = regExe(env)
      if (reg === undefined) {
        logForDebugging('jumpback: protocol unregistration skipped', { reason: 'system-root-missing' })
        return
      }
      // The whole scheme root goes, not just the command below it: leaving the
      // empty `dsh-tui` key behind would contradict "a normal exit leaves no
      // protocol key" and make the next default-off snapshot look wrong (D7/F-2).
      const result = await run(reg, ['delete', JUMP_BACK_PROTOCOL_KEY, '/f'], {
        timeout: REGISTRY_TIMEOUT_MS,
      })
      // A key another instance removed first is the normal multi-instance case;
      // the refusal costs nothing and is recorded for the post-mortem (D7/R4).
      if (result.code !== 0) {
        logForDebugging('jumpback: protocol unregistration failed', {
          code: result.code,
          detail: firstOutputLine(result),
        })
      }
    } catch (error) {
      logForDebugging('jumpback: protocol unregistration threw', { detail: describe(error) })
    }
  }

  function writeMarker(sessionId: string, marker: string): string | undefined {
    if (platform !== 'win32') {
      logForDebugging('jumpback: marker file skipped', { reason: 'not-win32' })
      return undefined
    }
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      logForDebugging('jumpback: marker file refused', { reason: 'unusable session id', sessionId })
      return undefined
    }
    if (!MARKER_PATTERN.test(marker)) {
      logForDebugging('jumpback: marker file refused', { reason: 'unusable marker', marker })
      return undefined
    }
    const path = join(markerDir, `${sessionId}.json`)
    try {
      const record = {
        schemaVersion: 1,
        marker,
        pid: process.pid,
        startedAt: new Date(now()).toISOString(),
      }
      mkdirSync(markerDir, { recursive: true })
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    } catch (error) {
      logForDebugging('jumpback: marker file unwritable', { path, detail: describe(error) })
      return undefined
    }
    written.add(path)
    logForDebugging('jumpback: marker file written', { path })
    return path
  }

  async function cleanup(): Promise<void> {
    // A registration still in flight may land after this check; waiting for it
    // makes "we do not leave a key behind" true even on a fast exit.
    if (pendingRegistration !== undefined) await pendingRegistration
    if (registered) await unregisterProtocol()
    for (const path of written) {
      try {
        rmSync(path, { force: true })
      } catch (error) {
        logForDebugging('jumpback: marker file removal failed', { path, detail: describe(error) })
      }
    }
    written.clear()
  }

  function sweepStale(): void {
    if (platform !== 'win32') return
    try {
      removeStaleMarkers()
    } catch (error) {
      // The sweep is housekeeping: a surprise in it must not take startup down.
      logForDebugging('jumpback: stale marker sweep failed', { detail: describe(error) })
    }
  }

  function removeStaleMarkers(): void {
    let entries
    try {
      entries = readdirSync(markerDir, { withFileTypes: true })
    } catch (error) {
      // No directory yet is the normal first run; anything else is worth a line.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logForDebugging('jumpback: marker directory unreadable', { dir: markerDir, detail: describe(error) })
      }
      return
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const path = join(markerDir, entry.name)
      const record = readMarkerRecord(path)
      if (record === undefined) continue
      const pid = record.pid
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
        logForDebugging('jumpback: marker file left in place', { path, reason: 'no usable pid' })
        continue
      }
      if (!pidAlive(pid)) {
        removeStale(path, 'the owning process is gone')
        continue
      }
      const started = typeof record.startedAt === 'string' ? Date.parse(record.startedAt) : Number.NaN
      if (Number.isFinite(started) && now() - started > STALE_AFTER_MS) {
        removeStale(path, 'older than 7 days')
      } else if (!Number.isFinite(started)) {
        logForDebugging('jumpback: marker file left in place', { path, reason: 'no usable startedAt' })
      }
    }
  }

  return {
    probe,
    ensureProtocol,
    unregisterProtocol,
    writeMarker,
    cleanup,
    sweepStale,
  }
}

/**
 * Write one `REG_SZ` value with `reg.exe add`. The named value and the key's
 * default value share one argv shape; `name === null` means the default value
 * (`/ve`), the form the T03 precedent read back from a real registry (D7).
 * @param run - The injected process runner.
 * @param reg - The absolute `reg.exe` path.
 * @param write - The key, the value name (null for the default value) and its data.
 * @returns undefined on success, or the line a failure left for the log.
 */
async function addRegistryValue(
  run: typeof execFileNoThrow,
  reg: string,
  write: { readonly key: string, readonly name: string | null, readonly data: string },
): Promise<string | undefined> {
  const nameArgs = write.name === null ? ['/ve'] : ['/v', write.name]
  const result = await run(reg, ['add', write.key, ...nameArgs, '/t', 'REG_SZ', '/d', write.data, '/f'], {
    timeout: REGISTRY_TIMEOUT_MS,
  })
  if (result.code === 0) return undefined
  const detail = firstOutputLine(result)
  return detail === '' ? `exited with code ${result.code}` : detail
}

/**
 * The in-box registry tool under `%WINDIR%`, or undefined when the environment
 * names no Windows directory. Resolved by absolute path, never through `PATH`
 * (the same rule the toast transport follows for its own registry writes).
 * @param env - The environment to read.
 * @returns The absolute `reg.exe` path, or undefined.
 */
function regExe(env: Record<string, string | undefined>): string | undefined {
  const root = env.WINDIR ?? env.SystemRoot
  if (root === undefined || root === '') return undefined
  return join(root, 'System32', 'reg.exe')
}

/**
 * Parse one marker file. Unreadable and unshaped files are left in place: not
 * being able to read a file is not proof that its owner is gone, and a newer
 * process may still know the format (D8).
 * @param path - The marker file to read.
 * @returns The record, or undefined when it cannot be interpreted.
 */
function readMarkerRecord(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) {
      logForDebugging('jumpback: marker file left in place', { path, reason: 'not a JSON object' })
      return undefined
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    logForDebugging('jumpback: marker file left in place', { path, detail: describe(error) })
    return undefined
  }
}

/** Remove one stale marker file; a removal that fails only leaves the file. */
function removeStale(path: string, reason: string): void {
  try {
    rmSync(path, { force: true })
    logForDebugging('jumpback: removed a stale marker file', { path, reason })
  } catch (error) {
    logForDebugging('jumpback: stale marker file removal failed', { path, detail: describe(error) })
  }
}

/** Why the probe did not answer 0: a timeout or the helper's own exit code. */
function probeFailure(result: ExecFileNoThrowResult): string {
  if (result.code === null) {
    return `the helper timed out after ${PROBE_TIMEOUT_MS} ms or was killed`
  }
  const detail = firstOutputLine(result)
  return detail === ''
    ? `the helper exited with code ${result.code}`
    : `the helper exited with code ${result.code}: ${detail}`
}

/** The first line a failed command printed, the only clue a debug log can carry. */
function firstOutputLine(result: ExecFileNoThrowResult): string {
  for (const stream of [result.stderr, result.stdout]) {
    const line = stream.trim().split(/\r?\n/u)[0]
    if (line !== '') return line.slice(0, 300)
  }
  return ''
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
