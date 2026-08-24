/**
 * AC 回归脚本（issue #359 / PR-A）：
 * - AC-1：extractMentions 的 `#L 行区间后缀解析（纯函数断言）。
 * - AC-2：expandMentions 对行区间 mention 的内存切片附加（stub fs 断言）。
 * - AC-3：起行超总行数时整文件回退 + warnings 提示（不进 missing、消息
 *   不被静默丢弃——D3/ADR-002）。
 *
 * Run via tsx:
 *   node --import tsx/esm scripts/verify-mentions-line-range.tsx
 */

import assert from 'node:assert/strict'

const { extractMentions, stripLineRange } = await import('../src/utils/mentions.js')
const { expandMentions } = await import('../src/dsh-adapter/channel.js')

let failures = 0
let total = 0
const check = (name, fn) => {
  total++
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}`)
    console.error(`       ${error.message}`)
  }
}
// AC-2 用例走异步 expandMentions；顶层 await 保证顺序与退出码语义。
const checkAsync = async (name, fn) => {
  total++
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}`)
    console.error(`       ${error.message}`)
  }
}

/** MentionFs 最小 stub：固定内容单文件（AC-2 专用）。 */
const stubFs = content => ({
  async resolve(path) {
    return { displayPath: path }
  },
  async stat() {
    return { type: 'file' }
  },
  async readText() {
    return content
  },
  async listDir() {
    return []
  },
})

const FIVE_LINES = 'line1\nline2\nline3\nline4\nline5\n'

/** 取 expansion 里第一个 attached-file 文本块。 */
const attachedFileText = expansion => {
  const block = expansion.blocks.find(
    b => b.type === 'text' && typeof b.text === 'string' && b.text.startsWith('<attached-file'),
  )
  return block ? block.text : ''
}

// --- stripLineRange 单元 ----------------------------------------------------
check('strip: #L12 -> path + startLine', () => {
  assert.deepEqual(stripLineRange('src/a.ts#L12'), { path: 'src/a.ts', startLine: 12 })
})
check('strip: #L12-14 -> path + range', () => {
  assert.deepEqual(stripLineRange('src/a.ts#L12-14'), { path: 'src/a.ts', startLine: 12, endLine: 14 })
})
check('strip: #12-14 无 L 兼容', () => {
  assert.deepEqual(stripLineRange('src/a.ts#12-14'), { path: 'src/a.ts', startLine: 12, endLine: 14 })
})
check('strip: #5 单行（无 L）', () => {
  assert.deepEqual(stripLineRange('src/a.ts#5'), { path: 'src/a.ts', startLine: 5 })
})
check('strip: 反向区间不当后缀', () => {
  assert.deepEqual(stripLineRange('src/a.ts#L14-12'), undefined)
})
check('strip: #L 悬空不当后缀', () => {
  assert.deepEqual(stripLineRange('src/a.ts#L'), undefined)
})

// --- extractMentions 端到端（AC-1 用例表）-----------------------------------
const parse = text =>
  extractMentions(text).map(({ start, end, ...rest }) => rest)

check('AC1: @src/a.ts#L12', () => {
  assert.deepEqual(parse('@src/a.ts#L12'), [{ path: 'src/a.ts', startLine: 12 }])
})
check('AC1: @src/a.ts#L12-14', () => {
  assert.deepEqual(parse('@src/a.ts#L12-14'), [{ path: 'src/a.ts', startLine: 12, endLine: 14 }])
})
check('AC1: @src/a.ts#12-14 无 L 兼容', () => {
  assert.deepEqual(parse('@src/a.ts#12-14'), [{ path: 'src/a.ts', startLine: 12, endLine: 14 }])
})
check('AC1: @src/a.ts#5', () => {
  assert.deepEqual(parse('@src/a.ts#5'), [{ path: 'src/a.ts', startLine: 5 }])
})
check('AC1: @"my dir/a.ts"#L3-5 引号形式', () => {
  assert.deepEqual(parse('@"my dir/a.ts"#L3-5'), [{ path: 'my dir/a.ts', startLine: 3, endLine: 5 }])
})
check('AC1: @src/a.ts 行为不变', () => {
  assert.deepEqual(parse('@src/a.ts'), [{ path: 'src/a.ts' }])
})
check('AC1: @src/a.ts#L12 tail 后缀后空白即止', () => {
  assert.deepEqual(parse('@src/a.ts#L12 tail'), [{ path: 'src/a.ts', startLine: 12 }])
})
check('AC1: @src/a.ts#L 不误判', () => {
  assert.deepEqual(parse('@src/a.ts#L'), [{ path: 'src/a.ts#L' }])
})
check('AC1: @src/a.ts#L14-12 反向区间不当行引用', () => {
  assert.deepEqual(parse('@src/a.ts#L14-12'), [{ path: 'src/a.ts#L14-12' }])
})
check('AC1: @dir/#L12/x.ts 路径中段 # 不剥', () => {
  assert.deepEqual(parse('@dir/#L12/x.ts'), [{ path: 'dir/#L12/x.ts' }])
})
check('AC1: 混合多 mention', () => {
  assert.deepEqual(parse('看看 @src/a.ts#L12-14 和 @b.ts 然后改'), [
    { path: 'src/a.ts', startLine: 12, endLine: 14 },
    { path: 'b.ts' },
  ])
})

// --- AC-2: expandMentions 行切片附加（stub fs）--------------------------------
await checkAsync('AC2: @src/a.ts#L2-4 只附 line2-line4 且 missing 空', async () => {
  const expansion = await expandMentions(stubFs(FIVE_LINES), '/cwd', '看看 @src/a.ts#L2-4')
  const text = attachedFileText(expansion)
  assert.ok(text.includes('line2'), '应包含 line2')
  assert.ok(text.includes('line3'), '应包含 line3')
  assert.ok(text.includes('line4'), '应包含 line4')
  assert.ok(!text.includes('line1'), '不应包含 line1（切片前边界）')
  assert.ok(!text.includes('line5'), '不应包含 line5（切片后边界）')
  assert.deepEqual(expansion.missing, [], 'missing 应为空')
  assert.deepEqual(expansion.attached, ['src/a.ts'], 'attached 应含该文件')
})
await checkAsync('AC2: @src/a.ts 无后缀仍整文件附加', async () => {
  const expansion = await expandMentions(stubFs(FIVE_LINES), '/cwd', '@src/a.ts')
  const text = attachedFileText(expansion)
  for (const line of ['line1', 'line2', 'line3', 'line4', 'line5']) {
    assert.ok(text.includes(line), `整文件应包含 ${line}`)
  }
  assert.deepEqual(expansion.missing, [])
})
await checkAsync('AC2: @src/a.ts#L0 非法零起始回退整文件', async () => {
  const expansion = await expandMentions(stubFs(FIVE_LINES), '/cwd', '@src/a.ts#L0')
  const text = attachedFileText(expansion)
  assert.ok(text.includes('line1'), '零起始非合法 1-based 引用，应整文件回退')
  assert.ok(text.includes('line5'))
  assert.deepEqual(expansion.missing, [])
})
await checkAsync('AC2: @src/a.ts#L6 起行超总行数回退整文件', async () => {
  const expansion = await expandMentions(stubFs(FIVE_LINES), '/cwd', '@src/a.ts#L6')
  const text = attachedFileText(expansion)
  assert.ok(text.includes('line1'), '超界引用应整文件回退而非空块')
  assert.ok(text.includes('line5'), '回退须含全部内容（含幻影尾行后的真实行）')
  assert.deepEqual(expansion.missing, [])
})

// --- AC-3: 越界回退 + warnings 提示（D3/ADR-002：显式意图不静默丢）------------
const TWO_LINES = 'alpha\nbeta\n'
await checkAsync('AC3: @2 行文件#L99 整文件回退且 warnings 非空', async () => {
  const expansion = await expandMentions(stubFs(TWO_LINES), '/cwd', '@a.md#L99')
  const text = attachedFileText(expansion)
  assert.ok(text.includes('alpha'), '越界应回退附加整文件（含首行）')
  assert.ok(text.includes('beta'), '越界应回退附加整文件（含末行）')
  assert.ok(Array.isArray(expansion.warnings), 'warnings 字段应为数组（D3 新字段）')
  assert.ok(expansion.warnings.length > 0, '越界回退必须产生 warnings 提示，不得静默')
  assert.ok(
    expansion.warnings.every(w => typeof w === 'string' && w.length > 0),
    'warnings 条目须为非空字符串',
  )
  assert.deepEqual(expansion.missing, [], '行区间解析成功不进 missing——missing 仅表文件无法解析')
})
await checkAsync('AC3: 无后缀与正常切片不产生 warnings', async () => {
  const plain = await expandMentions(stubFs(FIVE_LINES), '/cwd', '@src/a.ts')
  assert.deepEqual(plain.warnings, [], '无后缀整文件附加不应有 warnings')
  const sliced = await expandMentions(stubFs(FIVE_LINES), '/cwd', '@src/a.ts#L2-4')
  assert.deepEqual(sliced.warnings, [], '合法区间切片不应有 warnings')
})

// --- summary -----------------------------------------------------------------
console.log()
if (failures === 0) {
  console.log(`verify-mentions-line-range: PASS (${total} checks)`)
  process.exit(0)
} else {
  console.error(`verify-mentions-line-range: FAIL (${failures}/${total} checks failed)`)
  process.exit(1)
}
