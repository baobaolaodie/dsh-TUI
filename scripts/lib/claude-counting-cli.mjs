/**
 * Shared CLI fixture: log each probe, then report a version or versionless text.
 * A JS entry works on Windows without compiling a native counting binary.
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
