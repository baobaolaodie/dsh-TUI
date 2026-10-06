#!/usr/bin/env node
/**
 * verify-maid-portrait-precedence.ts —— 「女仆娘立绘 vs 宠物皮肤」抢占口径的跨文件文案契约。
 *
 * 为什么是门禁：这条优先级（宠物皮肤为 `deepy`/`whaleGirl` 时开屏艺术槽被吉祥物占据、
 * 「女仆娘立绘」开关**不生效**；设成 `whale` 才走原路径、立绘**生效**）要在
 * `docs/configuration{,.en}.md`、`docs/user-guide{,.en}.md`、`README{,_ZH}.md` 上表达
 * 同一句口径，还要在随包手册副本里逐字节跟上。任何一处漏改都表现为"文档自相矛盾"
 * 这种静默故障——读者照旧文案操作，得到的却是新行为。所以这里把四件事钉死：
 *   1. configuration 两版：`whaleGirl` 行与 `companion.skin` 行**互相点名**，且两行
 *      下方那张**三行优先级小表**在场（`deepy`/`whaleGirl`/`whale` 三行的立绘开关判定）；
 *   2. user-guide 两版：含**权威表述 A**的关键子串，且旧的无条件表述**不再出现**；
 *   3. README 两版：`## ` 配置节里权威表述 A 的关键子串带指向 `docs/configuration` 的指针；
 *   4. `guide/**` 里 configuration / user-guide 四份副本与 `docs/` 真源逐字节一致。
 *
 * 断言只钉**关键子串与语义关键字**，不钉整句长度或字符数（计数不是不变量）；
 * 比对前抽掉全部空白，因此 markdown 折行不影响判定。失败信息点名文件与缺失/多余串。
 *
 * 运行：node --import tsx/esm scripts/verify-maid-portrait-precedence.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { guideDrift, repoRoot } from './guide-sources.mjs'

let failures = 0
let checks = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  checks++
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

/** 冻结表述 A（docs / README / user-guide 共用）：改这句 = 改契约，两处必须同步。 */
const AUTHORITATIVE = {
  en: 'While Companion skin is deepy or whaleGirl, the splash art is that mascot and the Maid-portrait toggle has no effect; set Companion skin to whale to use the maid portrait.',
  zh: '宠物皮肤为 deepy 或 whaleGirl 时，开屏（标题）艺术槽由该吉祥物占据，「女仆娘立绘」开关不生效；把宠物皮肤设为 whale 才会用女仆娘立绘。',
} as const

/** 权威表述 A 的关键子串（均为上面整句的连续切片；三处文档必须逐字复用同一句）。 */
const KEY_FRAGMENTS = {
  en: ['Companion skin is deepy or whaleGirl', 'Maid-portrait toggle has no effect', 'set Companion skin to whale'],
  zh: ['宠物皮肤为 deepy 或 whaleGirl', '开关不生效', '宠物皮肤设为 whale'],
} as const

/** 旧口径串（无条件句）：出现即说明文档又回到了"立绘无条件接管"的旧说法。 */
const STALE = {
  zh: [
    // 旧 :485 —— 把立绘说成「最优先」，与「宠物皮肤接管」直接冲突。
    '最优先',
    // 旧 :553 —— 设置速查表里「标题像素鲸鱼换成作者绘制的女仆娘」的无条件说法。
    '标题像素鲸鱼换成作者绘制的女仆娘',
  ],
  en: [
    // 旧 :523 / :600 —— "swaps the header's pixel whale"（无条件替换）。
    "swaps the header's pixel whale",
    // 旧 :523 —— "FIRST as a **real raster**"（立绘最优先）。
    'FIRST as a **real raster**',
  ],
} as const

/** 冻结表述 C 的行序：小表三行必须按这个顺序给出皮肤取值。 */
const PRECEDENCE_ROWS = ['deepy', 'whaleGirl', 'whale'] as const

/** 小表末列（女仆娘立绘开关）的「不生效 / 生效」语义关键字；英文侧接受常见译法。 */
const INACTIVE = {
  zh: /不生效/u,
  en: /\bno effect\b|\bnot (?:in )?effective?\b|\btakes no effect\b|\b(?:is |gets )?(?:ignored|overridden|disabled)\b|\bdoes not apply\b|\bnot applied\b|\boverr?ides\b/iu,
} as const
const ACTIVE = {
  zh: /(?<!不)生效/u,
  en: /\bin effect\b|\btakes effect\b|\beffective\b|\bapplied\b|\bapplies\b|\bis active\b|\bhonou?red\b/iu,
} as const

type Lang = keyof typeof AUTHORITATIVE

const FILES: Record<Lang, { configuration: string; userGuide: string; readme: string; readmeHeading: string; pointer: string }> = {
  zh: {
    configuration: 'docs/configuration.md',
    userGuide: 'docs/user-guide.md',
    readme: 'README_ZH.md',
    readmeHeading: '## 配置与扩展',
    pointer: 'docs/configuration.md',
  },
  en: {
    configuration: 'docs/configuration.en.md',
    userGuide: 'docs/user-guide.en.md',
    readme: 'README.md',
    readmeHeading: '## Configuration & Extensions',
    pointer: 'docs/configuration.en.md',
  },
}

const LANGUAGES: readonly Lang[] = ['zh', 'en']
const read = (file: string): string => readFileSync(join(repoRoot, file), 'utf8')
/** markdown 会把长句折行：比对前抽掉全部空白，让「同一句」不受折行与空格差异影响。 */
const squash = (text: string): string => text.replace(/\s+/gu, '')
const missing = (text: string, fragments: readonly string[]): string[] =>
  fragments.filter(fragment => !squash(text).includes(squash(fragment)))
const stillPresent = (text: string, fragments: readonly string[]): string[] =>
  fragments.filter(fragment => squash(text).includes(squash(fragment)))

interface TableRow {
  readonly cells: readonly string[]
  readonly line: string
}
const tableRows = (text: string): TableRow[] => text.split(/\r?\n/u).flatMap(line => {
  if (!/^\s*\|/u.test(line)) return []
  const cells = line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim())
  return [{ cells, line }]
})
/** 行首单元格里的设置键：`` `deepy`（默认） `` → `deepy`。 */
const firstCellKey = (row: TableRow): string | undefined => /^`?([A-Za-z][\w.]*)`?/u.exec(row.cells[0] ?? '')?.[1]
const isSeparator = (row: TableRow): boolean => /^\|[\s:|-]+\|$/u.test(row.line.trim())

/**
 * 找到冻结表述 C 的三行小表：表头 + 分隔行 + `deepy`/`whaleGirl`/`whale` 三行（顺序固定）。
 * 结构判据（连续三行 + 每行 ≥3 列 + 上方是真正的表头/分隔行）把它与配置大表区分开。
 */
const precedenceTable = (text: string): TableRow[] | undefined => {
  const rows = tableRows(text)
  for (let i = 2; i + 2 < rows.length; i++) {
    const block = [rows[i]!, rows[i + 1]!, rows[i + 2]!]
    if (!block.every(row => row.cells.length >= 3)) continue
    if (!block.every((row, offset) => firstCellKey(row) === PRECEDENCE_ROWS[offset])) continue
    if (!isSeparator(rows[i - 1]!) || rows[i - 2]!.cells.length < 3) continue
    return block
  }
  return undefined
}

/** 取 `## ` 节正文（到下一个 H2 为止）；节标题不在场时返回空串。 */
const section = (text: string, heading: string): string => {
  const start = text.indexOf(heading)
  if (start < 0) return ''
  const rest = text.slice(start + heading.length)
  const end = rest.search(/\n## /u)
  return end < 0 ? rest : rest.slice(0, end)
}

// --- 0. 契约自证：关键子串必须仍是指定整句的连续切片 ------------------------------
const drifted = LANGUAGES.flatMap(lang => missing(AUTHORITATIVE[lang], KEY_FRAGMENTS[lang]).map(fragment => `${lang}:${fragment}`))
check('[contract] key fragments are literal slices of the frozen sentence A', drifted.length === 0, drifted.join(' | '))

// --- 1. configuration ×2：互相点名 + 三行优先级小表 -------------------------------
for (const lang of LANGUAGES) {
  const file = FILES[lang].configuration
  const text = read(file)
  const rows = tableRows(text)
  const maidRow = rows.find(row => firstCellKey(row) === 'whaleGirl')
  const skinRow = rows.find(row => firstCellKey(row) === 'companion.skin')
  const crossRefs: string[] = []
  if (maidRow === undefined) crossRefs.push('未找到 `whaleGirl` 行')
  else if (!maidRow.line.includes('companion.skin')) crossRefs.push('`whaleGirl` 行未点名 `companion.skin`')
  if (skinRow === undefined) crossRefs.push('未找到 `companion.skin` 行')
  else if (!skinRow.line.includes('whaleGirl')) crossRefs.push('`companion.skin` 行未点名 `whaleGirl`')
  check(`[configuration] ${file}: whaleGirl row and companion.skin row name each other`, crossRefs.length === 0, crossRefs.join(' | '))

  const table = precedenceTable(text)
  const tableProblems: string[] = []
  if (table === undefined) {
    tableProblems.push('未找到三行优先级小表（表头 + 分隔行 + `deepy`/`whaleGirl`/`whale` 三行，顺序固定）')
  } else {
    for (const [offset, row] of table.entries()) {
      const verdict = row.cells.at(-1) ?? ''
      if (offset < 2 && !INACTIVE[lang].test(verdict)) {
        tableProblems.push(`\`${PRECEDENCE_ROWS[offset]}\` 行末列缺「不生效」判定（实为 ${JSON.stringify(verdict)}）`)
      }
      if (offset === 2 && (!ACTIVE[lang].test(verdict) || INACTIVE[lang].test(verdict))) {
        tableProblems.push(`\`whale\` 行末列缺「生效」判定（实为 ${JSON.stringify(verdict)}）`)
      }
    }
  }
  check(`[configuration] ${file}: 3-row precedence table (deepy/whaleGirl/whale → portrait toggle verdict)`, tableProblems.length === 0, tableProblems.join(' | '))
}

// --- 2. user-guide ×2：权威表述 A 的关键子串在场 + 旧口径串不在场 -------------------
for (const lang of LANGUAGES) {
  const file = FILES[lang].userGuide
  const text = read(file)
  const absent = missing(text, KEY_FRAGMENTS[lang])
  check(`[user-guide] ${file}: contains authoritative sentence A key fragments`, absent.length === 0, `missing [${absent.join(' | ')}]`)

  const stale = stillPresent(text, STALE[lang])
  check(`[user-guide] ${file}: no stale unconditional wording`, stale.length === 0, `unexpected [${stale.join(' | ')}]`)
}

// --- 3. README ×2：配置节里关键子串 + 指向 docs/configuration 的指针 ----------------
for (const lang of LANGUAGES) {
  const file = FILES[lang].readme
  const text = read(file)
  const body = section(text, FILES[lang].readmeHeading)
  const problems: string[] = []
  if (body === '') {
    problems.push(`未找到节标题 ${FILES[lang].readmeHeading}`)
  } else {
    const absent = missing(body, KEY_FRAGMENTS[lang])
    if (absent.length > 0) problems.push(`missing [${absent.join(' | ')}]`)
    if (!squash(body).includes(squash(FILES[lang].pointer))) problems.push(`缺少指向 ${FILES[lang].pointer} 的指针`)
  }
  check(`[README] ${file}: ${FILES[lang].readmeHeading} pins sentence A and points at docs/configuration`, problems.length === 0, problems.join(' | '))
}

// --- 4. guide 副本：configuration / user-guide 四份与真源逐字节一致 ----------------
const BUNDLED = ['configuration.md', 'configuration.en.md', 'user-guide.md', 'user-guide.en.md']
const drift = guideDrift(repoRoot)
const pick = (files: readonly string[]): string[] => files.filter(name => BUNDLED.includes(name))
const driftProblems = [
  `missing source [${pick(drift.missingSource).join(', ')}]`,
  `missing copy [${pick(drift.missingCopy).join(', ')}]`,
  `differing [${pick(drift.differing).join(', ')}]`,
].filter(entry => !entry.endsWith('[]'))
check('[guide] configuration/user-guide copies match docs/ byte-for-byte', driftProblems.length === 0, driftProblems.join(' '))

console.log(failures === 0 ? `\nALL PASS (${checks} checks)` : `\n${failures} FAILED of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
