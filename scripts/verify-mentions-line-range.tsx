/**
 * AC-1 回归脚本：extractMentions 的 `#L 行区间后缀解析（issue #359 / PR-A）。
 *
 * 纯函数断言，无 fs / 渲染依赖。Run via tsx:
 *   node --import tsx/esm scripts/verify-mentions-line-range.tsx
 */

import assert from 'node:assert/strict'

const { extractMentions, stripLineRange } = await import('../src/utils/mentions.js')

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

// --- summary -----------------------------------------------------------------
console.log()
if (failures === 0) {
  console.log(`verify-mentions-line-range: PASS (${total} checks)`)
  process.exit(0)
} else {
  console.error(`verify-mentions-line-range: FAIL (${failures}/${total} checks failed)`)
  process.exit(1)
}
