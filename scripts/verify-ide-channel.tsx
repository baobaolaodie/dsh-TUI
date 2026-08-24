/**
 * verify-ide-channel — AC-4 回归（IDE 选区通道，src/dsh-adapter/ide-channel.ts）。
 * 三层覆盖：
 *   1. 纯函数：envDirect（env 直连解析）、ideLockDir、pickLockCandidates
 *      （lock 目录扫描与 workspaceFolders 归一化排序）、parseSelectionChanged
 *      （selection_changed 通知坐标校验）；
 *   2. 无 IDE 降级：空 env + 不存在的 lock 目录 → 不抛错、connected=false、
 *      在连接预算内静默完成；
 *   3. loopback 对连：本脚本内起一个最小 RFC6455 服务端（http upgrade 应答
 *      + 单帧文本编解码），验证原生 WebSocket 客户端的 ide/hello 握手与
 *      selection_changed 到达 listener——分别走 env 直连与 lock 发现两条路径。
 *   4. 选区消费注入（T05 · AC-5 前半）：buildSelectionBlock 纯函数的正常切片 /
 *      坐标越界钳制 / 过期选区跳过断言，外加 loopback 收到的真实快照端到端
 *      构造 <attached-file … selection> 块、isEmpty 清空后守卫不产块。
 *
 * lock fixture 一律 mkdtempSync 临时目录，绝不写真实 ~/.dsh-tui（隔离策略，
 * DESIGN §7）。运行：node --import tsx/esm scripts/verify-ide-channel.tsx
 */
process.env.DSH_TUI_LANG = 'zh'

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Socket } from 'node:net'

const sleep = async (ms: number) => { await delay(ms) }

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

async function waitFor(ready: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (ready()) return true
    await sleep(20)
  }
  return ready()
}

// ── 最小 RFC6455 服务端 fixture（仅够本验证：upgrade 应答 + 掩码文本帧解码 +
//    非掩码文本帧编码；close 帧直接断开，其余非文本帧忽略）────────────────────
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

type WsFixture = {
  port: number
  helloPromise: Promise<{ token: string }>
  close: () => void
}

/** 解析一帧客户端帧（RFC6455：客户端帧必带掩码）；数据不足返回 null。 */
function decodeClientFrame(buf: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | null {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    len = Number(buf.readBigUInt64BE(2))
    offset = 10
  }
  // 1 MiB 上限：fixture 只服务本验证的握手帧，超长帧视为畸形直接拒绝。
  if (len > 1024 * 1024) return null
  let maskKey: Buffer | null = null
  if (masked) {
    if (buf.length < offset + 4) return null
    maskKey = buf.subarray(offset, offset + 4)
    offset += 4
  }
  if (buf.length < offset + len) return null
  let payload = buf.subarray(offset, offset + len)
  if (maskKey !== null) {
    const unmasked = Buffer.allocUnsafe(len)
    for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4]
    payload = unmasked
  }
  return { opcode, payload, rest: buf.subarray(offset + len) }
}

/** 编码一帧服务端文本帧（服务端帧不掩码）。 */
function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  if (len < 126) return Buffer.concat([Buffer.from([0x81, len]), payload])
  if (len < 65536) {
    const header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x81
  header[1] = 127
  header.writeBigUInt64BE(BigInt(len), 2)
  return Buffer.concat([header, payload])
}

function startWsFixture(token: string): Promise<WsFixture> {
  return new Promise(resolveFixture => {
    let socketRef: Socket | null = null
    let buffer = Buffer.alloc(0)
    let helloResolve!: (value: { token: string }) => void
    const helloPromise = new Promise<{ token: string }>(resolve => { helloResolve = resolve })

    const sendSelection = (isEmpty: boolean) => {
      const socket = socketRef
      if (socket === null || socket.destroyed) return
      socket.write(encodeTextFrame(JSON.stringify({
        method: 'selection_changed',
        params: { path: 'src/a.ts', startLine: 2, endLine: 4, isEmpty },
      })))
    }

    const server = createServer()
    server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
      const key = String(req.headers['sec-websocket-key'] ?? '')
      const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + 'Sec-WebSocket-Accept: ' + accept + '\r\n'
        + '\r\n',
      )
      socketRef = socket
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          const frame = decodeClientFrame(buffer)
          if (frame === null) break
          buffer = frame.rest
          if (frame.opcode === 0x8) { socket.destroy(); return } // close 帧 → 直接断开
          if (frame.opcode !== 0x1) continue // 只关心文本帧
          let msg: unknown
          try {
            msg = JSON.parse(frame.payload.toString('utf8'))
          } catch {
            continue
          }
          const record = msg !== null && typeof msg === 'object' ? msg as Record<string, unknown> : null
          if (record?.method !== 'ide/hello') continue
          const params = record.params !== null && typeof record.params === 'object'
            ? record.params as Record<string, unknown>
            : null
          helloResolve({
            token: typeof params?.token === 'string' ? params.token : '',
          })
          // 握手完成后推一条非空选区，稍后再推一条空选区（验证清空路径）
          sendSelection(false)
          void sleep(50).then(() => sendSelection(true))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address !== null && typeof address === 'object' ? address.port : 0
      resolveFixture({
        port,
        helloPromise,
        close: () => {
          socketRef?.destroy()
          server.close()
        },
      })
    })
  })
}

async function main(): Promise<void> {
  const mod = await import('../src/dsh-adapter/ide-channel.js')
  type Snapshot = NonNullable<ReturnType<typeof mod.parseSelectionChanged>>

  // 选区块构造断言共用的五行内容（与 mentions 验证脚本同款形态）。
  const FIVE_LINE_CONTENT = 'line1\nline2\nline3\nline4\nline5\n'

  const tmpRoot = mkdtempSync(join(tmpdir(), 'verify-ide-channel-'))

  // ── 1. envDirect：env 直连解析 ────────────────────────────────────────────
  const directFull = mod.envDirect({ DSH_TUI_IDE_PORT: '41234', DSH_TUI_IDE_TOKEN: 'tok' })
  check('envDirect: 完整 env → {port:41234, token:"tok"}',
    directFull !== undefined && directFull.port === 41234 && directFull.token === 'tok')
  check('envDirect: 空 env → undefined', mod.envDirect({}) === undefined)
  check('envDirect: 缺 token → undefined', mod.envDirect({ DSH_TUI_IDE_PORT: '41234' }) === undefined)
  check('envDirect: 非数字端口 → undefined',
    mod.envDirect({ DSH_TUI_IDE_PORT: 'abc', DSH_TUI_IDE_TOKEN: 'tok' }) === undefined)
  check('envDirect: 端口越界(0) → undefined',
    mod.envDirect({ DSH_TUI_IDE_PORT: '0', DSH_TUI_IDE_TOKEN: 'tok' }) === undefined)
  check('envDirect: 端口越界(70000) → undefined',
    mod.envDirect({ DSH_TUI_IDE_PORT: '70000', DSH_TUI_IDE_TOKEN: 'tok' }) === undefined)
  check('envDirect: 小数端口 → undefined',
    mod.envDirect({ DSH_TUI_IDE_PORT: '123.5', DSH_TUI_IDE_TOKEN: 'tok' }) === undefined)

  // ── 2. ideLockDir ─────────────────────────────────────────────────────────
  check('ideLockDir: 默认落在 DATA_DIR/ide', mod.ideLockDir().endsWith(join('.dsh-tui', 'ide')))
  check('ideLockDir: 可注入自定义 dataDir',
    mod.ideLockDir(join(tmpRoot, 'data')) === join(tmpRoot, 'data', 'ide'))

  // ── 3. pickLockCandidates：workspaceFolders 归一化匹配排序 ─────────────────
  const lockDir = join(tmpRoot, 'locks')
  rmSync(lockDir, { force: true, recursive: true })
  mkdirSync(lockDir, { recursive: true })
  writeFileSync(join(lockDir, '41111.lock'),
    JSON.stringify({ port: 41111, token: 't-a', workspaceFolders: ['/repo/a'], pid: 111 }))
  writeFileSync(join(lockDir, '42222.lock'),
    JSON.stringify({ port: 42222, token: 't-other', workspaceFolders: ['/other'], pid: 222 }))
  writeFileSync(join(lockDir, '43333.lock'), '{ broken json !!!')
  const picked = mod.pickLockCandidates(lockDir, '/repo/a', process.pid)
  check('pickLockCandidates: 坏 JSON lock 被跳过（不出现在候选中）',
    picked.length === 2 && picked.every(c => c.token !== ''))
  check('pickLockCandidates: workspace 匹配者排第一', picked[0]?.token === 't-a')
  check('pickLockCandidates: 不匹配者仍在候选中', picked.some(c => c.token === 't-other'))
  check('pickLockCandidates: 不存在的 lock 目录 → 空数组（不抛错）',
    JSON.stringify(mod.pickLockCandidates(join(tmpRoot, 'no-such-dir'), '/', process.pid)) === '[]')

  // Windows 归一化：扩展写 fsPath 风格（反斜杠 + 大盘符），会话 cwd 是小写正斜杠
  writeFileSync(join(lockDir, '44444.lock'),
    JSON.stringify({ port: 44444, token: 't-win', workspaceFolders: ['C:\\Repo\\A'], pid: 444 }))
  const pickedWin = mod.pickLockCandidates(lockDir, 'c:/repo/a/sub/dir', process.pid)
  check('pickLockCandidates: Windows 反斜杠+盘符大小写归一化后匹配且排第一',
    pickedWin[0]?.token === 't-win')
  const posixStillFirst = mod.pickLockCandidates(lockDir, '/repo/a', process.pid)
  check('pickLockCandidates: 原 POSIX 匹配顺序不受 Windows lock 干扰',
    posixStillFirst[0]?.token === 't-a')

  // ── 4. parseSelectionChanged：通知解析与坐标校验 ───────────────────────────
  const good = mod.parseSelectionChanged({
    method: 'selection_changed',
    params: { path: 'a.ts', startLine: 2, endLine: 4, isEmpty: false },
  })
  check('parseSelectionChanged: 合法通知 → 坐标快照',
    good !== undefined && good.path === 'a.ts' && good.startLine === 2
    && good.endLine === 4 && good.isEmpty === false)
  check('parseSelectionChanged: 非 selection_changed 方法 → undefined',
    mod.parseSelectionChanged({ method: 'other', params: {} }) === undefined)
  check('parseSelectionChanged: 缺字段（无 endLine）→ undefined',
    mod.parseSelectionChanged({ method: 'selection_changed', params: { path: 'a.ts', startLine: 1, isEmpty: false } }) === undefined)
  check('parseSelectionChanged: 缺 params → undefined',
    mod.parseSelectionChanged({ method: 'selection_changed' }) === undefined)
  check('parseSelectionChanged: 非 object 输入 → undefined',
    mod.parseSelectionChanged('nope') === undefined)
  check('parseSelectionChanged: endLine < startLine → undefined',
    mod.parseSelectionChanged({ method: 'selection_changed', params: { path: 'a.ts', startLine: 4, endLine: 2, isEmpty: false } }) === undefined)
  check('parseSelectionChanged: 负 startLine → undefined',
    mod.parseSelectionChanged({ method: 'selection_changed', params: { path: 'a.ts', startLine: -1, endLine: 0, isEmpty: false } }) === undefined)
  check('parseSelectionChanged: 空 path → undefined',
    mod.parseSelectionChanged({ method: 'selection_changed', params: { path: '', startLine: 0, endLine: 0, isEmpty: false } }) === undefined)

  // ── 5. 无 IDE 场景：静默降级 ───────────────────────────────────────────────
  const degraded = new mod.IdeChannel()
  let degradedThrew: unknown
  const degradedStartAt = Date.now()
  try {
    await degraded.start({}, join(tmpRoot, 'no-such-locks'), '/nonexistent-cwd')
  } catch (error) {
    degradedThrew = error
  }
  const degradedElapsed = Date.now() - degradedStartAt
  check('无 IDE：start 不抛错', degradedThrew === undefined)
  check('无 IDE：connected=false', degraded.connected === false)
  check('无 IDE：selection 为 undefined', degraded.selection === undefined)
  check('无 IDE：在连接预算内静默完成（<2s）', degradedElapsed < 2000)

  // ── 6. loopback 对连 · env 直连路径 ────────────────────────────────────────
  const envFixture = await startWsFixture('tok-env')
  let seenLive: Snapshot[] = []
  let liveCleared = false
  {
    const channel = new mod.IdeChannel()
    const seen: Snapshot[] = []
    channel.onSelection(snapshot => seen.push(snapshot))
    await channel.start(
      { DSH_TUI_IDE_PORT: String(envFixture.port), DSH_TUI_IDE_TOKEN: 'tok-env' },
      join(tmpRoot, 'unused-locks'),
      '/somewhere',
    )
    check('loopback·env 直连：ide/hello 携带正确 token 到达服务端',
      (await envFixture.helloPromise).token === 'tok-env')
    check('loopback·env 直连：握手后 connected=true', channel.connected)
    const gotSelection = await waitFor(() => seen.length >= 1, 2000)
    check('loopback·env 直连：selection_changed 到达 listener',
      gotSelection && seen[0]?.path === 'src/a.ts' && seen[0]?.startLine === 2 && seen[0]?.endLine === 4)
    check('loopback·env 直连：非空选区反映在 selection getter', channel.selection !== undefined)
    const cleared = await waitFor(() => channel.selection === undefined, 2000)
    check('loopback·env 直连：isEmpty=true 清空 selection getter', cleared)
    check('loopback·env 直连：两次通知都到达 listener（含空选区）',
      seen.length === 2 && seen[1]?.isEmpty === true)
    // 留给第 8 节（选区消费注入）：非空快照 + isEmpty 清空事实。
    seenLive = seen.filter(item => !item.isEmpty)
    liveCleared = channel.selection === undefined
    channel.stop()
    check('loopback·env 直连：stop 后 connected=false', channel.connected === false)
  }
  envFixture.close()

  // ── 7. loopback 对连 · lock 发现路径（端到端集成 pickLockCandidates）────────
  const lockFixture = await startWsFixture('tok-lock')
  {
    const discoverDir = join(tmpRoot, 'discover')
    mkdirSync(discoverDir, { recursive: true })
    writeFileSync(join(discoverDir, String(lockFixture.port) + '.lock'), JSON.stringify({
      port: lockFixture.port,
      token: 'tok-lock',
      workspaceFolders: [tmpRoot],
      pid: 12345,
    }))
    const channel = new mod.IdeChannel()
    const seen: Snapshot[] = []
    channel.onSelection(snapshot => seen.push(snapshot))
    await channel.start({}, discoverDir, tmpRoot)
    check('loopback·lock 发现：握手 token 正确（lock 文件端到端）',
      (await lockFixture.helloPromise).token === 'tok-lock')
    check('loopback·lock 发现：connected=true', channel.connected)
    const got = await waitFor(() => seen.length >= 1, 2000)
    check('loopback·lock 发现：selection_changed 到达 listener',
      got && seen[0]?.path === 'src/a.ts' && seen[0]?.startLine === 2 && seen[0]?.endLine === 4)
    channel.stop()
  }
  lockFixture.close()

  // ── 8. 选区消费注入（T05 · AC-5 前半）：块构造与钳制 ──────────────────────
  {
    const channelMod = await import('../src/dsh-adapter/channel.js')
    const build = (channelMod as {
      buildSelectionBlock: (
        selection: { path: string; startLine: number; endLine: number; isEmpty: boolean },
        content: string,
      ) => { text: string; lines: number } | undefined
    }).buildSelectionBlock

    // 正常切片：0-based [2,4] → 1-based 第 3~5 行。
    const normal = build({ path: 'src/my file.ts', startLine: 2, endLine: 4, isEmpty: false }, FIVE_LINE_CONTENT)
    check('selectionBlock: 0-based [2,4] 切出第 3~5 行且带 selection 属性',
      normal !== undefined
      && normal.text === '<attached-file path="src/my file.ts" selection>\nline3\nline4\nline5\n</attached-file>'
      && normal.lines === 3)

    // 含空格路径不经文本解析——直接构造必须原样保留。
    const spaced = build({ path: 'my dir/a b.ts', startLine: 0, endLine: 0, isEmpty: false }, FIVE_LINE_CONTENT)
    check('selectionBlock: 含空格路径原样保留（D7 不走文本解析）',
      spaced !== undefined
      && spaced.text.startsWith('<attached-file path="my dir/a b.ts" selection>')
      && spaced.text.includes('\nline1\n</attached-file>'))

    // endLine 超界钳制到实际行数（0-based 99 → 1-based 100 > 5 → 全部剩余行）。
    const clampedEnd = build({ path: 'src/a.ts', startLine: 3, endLine: 99, isEmpty: false }, FIVE_LINE_CONTENT)
    check('selectionBlock: endLine 越界钳制到末行',
      clampedEnd !== undefined
      && clampedEnd.text === '<attached-file path="src/a.ts" selection>\nline4\nline5\n</attached-file>'
      && clampedEnd.lines === 2)

    // startLine 越过 EOF → sliceLines 返回 undefined → 无块（静默跳过）。
    const pastEof = build({ path: 'src/a.ts', startLine: 50, endLine: 60, isEmpty: false }, FIVE_LINE_CONTENT)
    check('selectionBlock: 起行越过 EOF → undefined（静默跳过）', pastEof === undefined)

    // isEmpty 快照守卫：调用侧不会传入，但纯函数自身也拒绝。
    check('selectionBlock: isEmpty=true → undefined',
      build({ path: 'src/a.ts', startLine: 0, endLine: 0, isEmpty: true }, FIVE_LINE_CONTENT) === undefined)

    // loopback 端到端：第 6 节 env 直连收到的真实快照（非空那条）构造出合法块；
    // isEmpty 清空后 selection getter 已为 undefined，消费守卫不产块。
    const liveSnapshot = seenLive[0]
    const fromLive = liveSnapshot === undefined
      ? undefined
      : build(liveSnapshot, FIVE_LINE_CONTENT)
    check('selectionBlock: loopback 真实快照构造 <attached-file … selection> 块',
      liveSnapshot !== undefined
      && fromLive !== undefined
      && fromLive.text.startsWith('<attached-file path="src/a.ts" selection>')
      && fromLive.lines === 3)
    check('selectionBlock: isEmpty 清空后 selection getter 为 undefined（消费守卫不产块）',
      liveCleared)
  }

  rmSync(tmpRoot, { recursive: true, force: true })

  console.log(results.join('\n'))
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall ide-channel checks passed')
}

await main()
