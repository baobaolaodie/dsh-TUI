/**
 * The counting-CLI fixture the two Claude regressions share: an entry that
 * appends one line per `--version` run to the log named by `COUNT_LOG_ENV`,
 * then reports the version it was given — or the "spawns but cannot answer"
 * text when none is.
 *
 * The entry is the shape the SDK itself starts (`node <entry>`), which is also
 * the only counting shape available here: Windows cannot spawn an npm `.cmd`
 * through `execFile` (that is why a wrapper gets followed at all) and a script
 * cannot build a `.exe` that appends to a log.
 *
 * Shared on purpose (2026-10-12): `verify-claude-executable` and
 * `verify-claude-detect` used to each define this fixture, the package bin and
 * the log reader — the duplicate-verification shape upstream asked us to stop
 * shipping.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The env var a counting CLI's entry reads its log path from. */
export const COUNT_LOG_ENV = 'DSH_TUI_TEST_CLAUDE_LOG'

/** Where an npm-installed `@anthropic-ai/claude-code` keeps its bin. */
export const PACKAGE_ENTRY = ['node_modules', '@anthropic-ai', 'claude-code', 'cli.js']

/** Every line a counting CLI's entry appended, in the order it ran. */
export const probeCalls = (log) => {
  try {
    return readFileSync(log, 'utf8').split(/\r?\n/u).filter(line => line !== '')
  } catch {
    return []
  }
}

/** Write the counting entry under `prefix` and return its path. */
export const countingEntry = (prefix, version) => {
  const entry = join(prefix, ...PACKAGE_ENTRY)
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(entry, [
    "const { appendFileSync } = require('node:fs')",
    `appendFileSync(process.env.${COUNT_LOG_ENV}, 'probe\\n')`,
    version === undefined ? "console.log('definitely not a claude version')" : `console.log('${version} (Claude Code)')`,
    '',
  ].join('\n'))
  return entry
}
