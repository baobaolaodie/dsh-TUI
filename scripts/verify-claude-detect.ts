/**
 * The Claude backend's kernel detection (what the picker's row says):
 *
 *  - an installed row always offers in-session login (`loginInSession`): a
 *    missing credential keeps the row selectable — switching kernels is
 *    never blocked on auth, `/login` (and `/channel`) work once the session
 *    is open;
 *  - the credential probe itself is unchanged and still passes through: an
 *    ambient env token reads ok, nothing reads missing (or unknown on
 *    darwin, whose login lives in the keychain).
 *
 *  - the SDK-missing branch (installed: false) reports what it can about a
 *    `claude` this machine already has: the CLI's version, or its path when
 *    the version cannot be read, appended under the unchanged install
 *    guidance — and nothing at all when there is no CLI, where the hint is
 *    word for word the sentence it was before.
 *
 * Both scenarios run in one isolated child (temp HOME/USERPROFILE/
 * CLAUDE_CONFIG_DIR/DSH_HOME, every ambient ANTHROPIC_ and CLAUDE_CODE_
 * variable scrubbed before the first import); the SDK peer resolves from
 * the checkout and the "CLI" is node itself, so no network and no spend.
 *
 * The SDK-missing branch needs a second child, because the peer resolves from
 * the importing module's own directory upwards: it is imported out of a copy
 * of `src/` in the temp root, so the branch is really reached (see the block
 * below for what the copy does and does not carry).
 *
 * Run: node --import tsx/esm scripts/verify-claude-detect.ts
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setLang } from '../src/i18n.js'
import { VALIDATED_SDK_VERSION } from '../src/backends/claude/contract.js'
import { claudeText, installClaudeLocale } from '../src/backends/claude/text.js'

setLang('en')
// The Claude dictionary reads the host's locale, not `setLang`: the parent
// renders the expectation for the child, which reports from an English host.
installClaudeLocale(() => 'en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

// ── the isolated child: two detections over a scrubbed environment ───────────
{
  const home = mkdtempSync(join(tmpdir(), 'dshtui-claude-detect-'))
  const configDir = join(home, '.claude')
  const dshHome = join(home, '.dsh')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  const backendUrl = new URL('../src/backends/claude/index.ts', import.meta.url).href
  const root = fileURLToPath(new URL('..', import.meta.url))
  const child = [
    "const [backendUrl, home, configDir, dshHome] = process.argv.slice(2)",
    "process.env.DSH_TUI_LANG = 'en'",
    "const fs = await import('node:fs')",
    "const path = await import('node:path')",
    "process.env.HOME = home",
    "process.env.USERPROFILE = home",
    "process.env.CLAUDE_CONFIG_DIR = configDir",
    "process.env.DSH_HOME = dshHome",
    "for (const key of Object.keys(process.env)) {",
    "  const upper = key.toUpperCase()",
    "  if (upper.startsWith('ANTHROPIC_') || upper === 'CLAUDECODE' || (upper.startsWith('CLAUDE_CODE_') && upper !== 'CLAUDE_CODE_EXECUTABLE')) delete process.env[key]",
    "}",
    "process.env.CLAUDE_CODE_EXECUTABLE = process.execPath",
    "const dataDir = path.join(home, '.dsh-tui', 'backends', 'claude')",
    "fs.mkdirSync(dataDir, { recursive: true })",
    "const detect = async backend => {",
    "  try {",
    "    const status = await backend.detect({ cwd: home, debug: () => undefined, warn: () => undefined })",
    "    return { installed: status.installed, auth: status.auth, loginInSession: status.loginInSession === true }",
    "  } catch (error) { return { crashed: error instanceof Error ? error.message : String(error) } }",
    "}",
    "const report = outcome => console.log('@@RESULT@@' + JSON.stringify(outcome))",
    "try {",
    "  const { claudeBackend } = await import(backendUrl)",
    // bare: no channel, nothing ambient — the row must still offer in-session login.
    "  const bare = await detect(claudeBackend)",
    // no channel, a token in the environment: ok through the unchanged ambient path.
    "  process.env.ANTHROPIC_AUTH_TOKEN = 'synthetic-env-token-not-real'",
    "  const ambient = await detect(claudeBackend)",
    "  report({ bare, ambient })",
    "} catch (error) {",
    "  report({ crashed: error instanceof Error ? error.message : String(error) })",
    "}",
  ].join('\n')
  const probe = join(home, 'detect-probe.mjs')
  writeFileSync(probe, child)
  type Row = { readonly installed?: boolean; readonly auth?: string; readonly loginInSession?: boolean; readonly crashed?: string }
  type Outcome = { readonly bare?: Row; readonly ambient?: Row; readonly crashed?: string }
  try {
    const ran = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      execFile(process.execPath, ['--import', 'tsx/esm', probe, backendUrl, home, configDir, dshHome], {
        cwd: root,
        timeout: 60_000,
        env: { ...process.env, TMP: home, TEMP: home, TMPDIR: home },
      }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : (error.code ?? 1), stdout: String(stdout), stderr: String(stderr) })
      })
    })
    const line = ran.stdout.split(/\r?\n/u).find(l => l.startsWith('@@RESULT@@'))
    const parsed = line === undefined ? undefined : JSON.parse(line.slice('@@RESULT@@'.length)) as Outcome
    const outcomeText = JSON.stringify(parsed ?? {})
    const row = (name: keyof Outcome): Row | undefined => parsed?.[name]
    check('detect-backend: the isolated child ran and reported both scenarios',
      parsed !== undefined && parsed.crashed === undefined && ran.code === 0
        && row('bare')?.crashed === undefined && row('bare')?.installed === true
        && row('ambient')?.crashed === undefined && row('ambient')?.installed === true,
      { code: ran.code, stderr: ran.stderr.slice(0, 300), stdout: ran.stdout.slice(0, 300) })
    // On darwin the CLI keeps its login in the keychain: the bare case is
    // `unknown` there, not `missing` (detectClaudeAuth's platform rule).
    const bareAuth = process.platform === 'darwin' ? 'unknown' : 'missing'
    check('detect-backend: no credential anywhere still offers in-session login (the switch is never blocked)',
      row('bare')?.auth === bareAuth && row('bare')?.loginInSession === true, row('bare'))
    check('detect-backend: an ambient env token still reads ok',
      row('ambient')?.auth === 'ok' && row('ambient')?.loginInSession === true, row('ambient'))
    check('detect-backend: no synthetic credential material travels in the status',
      !outcomeText.includes('synthetic-env-token-not-real'), outcomeText.slice(0, 300))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// ── the SDK-missing branch: a copy of src/ has no SDK to resolve ────────────
{
  // `loadClaudeSdk()` resolves the optional peer from the importing module's
  // own directory upwards, so a child importing this checkout always finds it
  // (the block above). The copy is how the failure branch is really reached:
  // ESM resolution never consults the working directory, so this child still
  // runs from the checkout while importing the copy, and of the one package
  // the copied graph needs beside node's builtins (`yaml`, through
  // channel-tokens.ts) only that package is linked back — linking the whole
  // node_modules would make the SDK resolvable again and test nothing.
  const checkout = fileURLToPath(new URL('..', import.meta.url))
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dshtui-claude-nosdk-')))
  const win = process.platform === 'win32'
  const systemRoot = process.env.SystemRoot ?? 'C:/Windows'
  const systemPath = win ? join(systemRoot, 'System32') : '/usr/bin:/bin'
  const home = join(root, 'home-native-cli')
  const bareHome = join(root, 'home-no-cli')
  const configDir = join(root, '.claude')
  const dshHome = join(root, '.dsh')
  // The CLI the official installer drops outside PATH (`~/.local/bin`), a copy
  // of node: `--version` then answers with the version this run knows.
  const cliPath = join(home, '.local', 'bin', win ? 'claude.exe' : 'claude')
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  mkdirSync(bareHome, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  copyFileSync(process.execPath, cliPath)
  if (!win) chmodSync(cliPath, 0o755)
  // A CLI-shaped file that exists and cannot report a version, the fixture
  // shape verify-claude-executable.ts uses too: `where` answers nothing for
  // `--version`, the POSIX script echoes a sentence. Pointed at explicitly, it
  // is the "path without a version" half of AC-5.
  const versionlessPath = join(root, win ? 'claude-versionless.exe' : 'claude-versionless')
  if (win) copyFileSync(join(systemRoot, 'System32', 'where.exe'), versionlessPath)
  else {
    writeFileSync(versionlessPath, '#!/bin/sh\necho definitely not a claude version\n')
    chmodSync(versionlessPath, 0o755)
  }
  cpSync(join(checkout, 'src'), join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  symlinkSync(realpathSync(join(checkout, 'node_modules', 'yaml')), join(root, 'node_modules', 'yaml'), 'junction')
  const backendUrl = pathToFileURL(join(root, 'src', 'backends', 'claude', 'index.ts')).href
  const child = [
    "const [backendUrl, home, bareHome, versionlessCli, systemPath, configDir, dshHome] = process.argv.slice(2)",
    "process.env.DSH_TUI_LANG = 'en'",
    "const fs = await import('node:fs')",
    "const path = await import('node:path')",
    "process.env.HOME = home",
    "process.env.USERPROFILE = home",
    "process.env.CLAUDE_CONFIG_DIR = configDir",
    "process.env.DSH_HOME = dshHome",
    // PATH reaches the lookup tool and nothing else, and the explicit-variable
    // escape hatch goes with the rest of CLAUDE_CODE_* below: only the fixture
    // home's own ~/.local/bin copy is left for the probe to find.
    "process.env.PATH = [home, systemPath].join(path.delimiter)",
    "for (const key of Object.keys(process.env)) {",
    "  const upper = key.toUpperCase()",
    "  if (upper.startsWith('ANTHROPIC_') || upper === 'CLAUDECODE' || upper.startsWith('CLAUDE_CODE_')) delete process.env[key]",
    "}",
    "const dataDir = path.join(home, '.dsh-tui', 'backends', 'claude')",
    "fs.mkdirSync(dataDir, { recursive: true })",
    "const debug = []",
    "const host = { cwd: home, locale: () => 'en', debug: message => debug.push(message), warn: () => undefined }",
    "const detect = async backend => {",
    "  try {",
    "    const status = await backend.detect(host)",
    "    return { installed: status.installed, hint: status.hint }",
    "  } catch (error) { return { crashed: error instanceof Error ? error.message : String(error) } }",
    "}",
    "const report = outcome => console.log('@@RESULT@@' + JSON.stringify(outcome))",
    "try {",
    "  const { claudeBackend } = await import(backendUrl)",
    // The CLI is there, the SDK is not: the branch AC-5 is about.
    "  const withCli = await detect(claudeBackend)",
    // The same machine with no CLI anywhere: a bare home, the PATH above and
    // no CLAUDE_CODE_EXECUTABLE.
    "  process.env.HOME = bareHome",
    "  process.env.USERPROFILE = bareHome",
    "  const withoutCli = await detect(claudeBackend)",
    // An explicit path the user set themselves, which exists and answers no
    // version: the payload falls back to the path (DESIGN D5's degradation).
    "  process.env.CLAUDE_CODE_EXECUTABLE = versionlessCli",
    "  const pathOnly = await detect(claudeBackend)",
    "  report({ withCli, withoutCli, pathOnly, debug })",
    "} catch (error) {",
    "  report({ crashed: error instanceof Error ? error.message : String(error) })",
    "}",
  ].join('\n')
  const probe = join(root, 'sdk-missing-probe.mjs')
  writeFileSync(probe, child)
  type Row = { readonly installed?: boolean; readonly hint?: string; readonly crashed?: string }
  type Outcome = { readonly withCli?: Row; readonly withoutCli?: Row; readonly pathOnly?: Row; readonly debug?: readonly string[]; readonly crashed?: string }
  // The word-for-word expectation for the no-CLI case is read off the live
  // dictionary rather than copied: a copy change must not need this file too.
  const expected = claudeText('claude-sdk-missing', { version: VALIDATED_SDK_VERSION })
  try {
    const ran = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      execFile(process.execPath, ['--import', 'tsx/esm', probe, backendUrl, home, bareHome, versionlessPath, systemPath, configDir, dshHome], {
        cwd: checkout,
        timeout: 60_000,
        env: { ...process.env, TMP: root, TEMP: root, TMPDIR: root },
      }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : (error.code ?? 1), stdout: String(stdout), stderr: String(stderr) })
      })
    })
    const line = ran.stdout.split(/\r?\n/u).find(l => l.startsWith('@@RESULT@@'))
    const parsed = line === undefined ? undefined : JSON.parse(line.slice('@@RESULT@@'.length)) as Outcome
    const withCli = parsed?.withCli
    const withoutCli = parsed?.withoutCli
    const pathOnly = parsed?.pathOnly
    const hint = withCli?.hint ?? ''
    const lines = hint.split('\n')
    // Every scenario must be the SDK-missing branch that produced a hint, not
    // a crash the child turned into a row.
    const detected = (row: Row | undefined): boolean => row?.crashed === undefined && row?.installed === false
    check('detect-backend: the copied child resolves no SDK and still detects every CLI shape',
      parsed !== undefined && parsed.crashed === undefined && ran.code === 0
        && detected(withCli) && detected(withoutCli) && detected(pathOnly),
      { code: ran.code, stderr: ran.stderr.slice(0, 300), stdout: ran.stdout.slice(0, 300) })
    // `installed: false` is only the SDK-missing branch's shape; the debug line
    // names the import that failed, so the branch is proven, not assumed.
    check('detect-backend: loadClaudeSdk() is the import that failed in that child',
      (parsed?.debug ?? []).some(message => message.includes('SDK import failed') && message.includes('claude-agent-sdk')),
      parsed?.debug)
    // AC-5 (the detection payload): the CLI is there, the SDK is not. Node's
    // own version is what the fixture copy answers with, so the "or path" half
    // covers the probe reporting no version (DESIGN D5's degradation).
    check('AC-5 a CLI found without the SDK travels in the detection payload (version or path)',
      hint.includes(process.versions.node) || hint.includes(cliPath), hint)
    check('AC-5 the install guidance stays word for word, the found CLI on a line of its own',
      lines.length === 2 && lines[0] === expected && (lines[1] ?? '').trim() !== '', lines)
    check('AC-5 a CLI that answers no version is still reported, by its path',
      (pathOnly?.hint ?? '').startsWith(`${expected}\n`) && (pathOnly?.hint ?? '').includes(versionlessPath), pathOnly?.hint)
    // AC-6 (this script's half): nothing found reads exactly as it did before.
    check('AC-6 without any CLI the hint is the plain SDK-missing sentence, word for word',
      withoutCli?.hint === expected, { got: withoutCli?.hint, expected })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

console.log(`\nverify-claude-detect OK (${passed} checks)`)
