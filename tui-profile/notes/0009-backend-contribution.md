# 0009 — Backend Contribution

> TUI Profile 说明（随 dsh-TUI 代码修订；编号仅作稳定锚点）。

**Coordinates:** `tui.dsh/v1alpha1` `Backend`

**Base protocol:** [`protocols/tui-contributions.js`](../protocols/tui-contributions.js)（definition、validator 与 handler assertion），宿主侧的分层与实现说明见 [`docs/agent-backend-design.md`](../../docs/agent-backend-design.md)。

## Scope

`Backend` 是继 `SettingsSection` 与 `Scene` 之后的第三个贡献族，与它们同处一个 manifest extension catalog：它声明**一个后端在宿主里长什么样**——身份、标签、它运行期答话的会话能力、它索要的宿主权限、它的安装面与卸载出口。声明是数据，不是权威：后端在本进程内运行，见「Grants and the trust model」。

贡献族今天的准入状态是**尚未接线（W-1）**：definition、validator、handler assertion、contract profile、conformance requirement 与宿主侧门禁都已就位，但第三方 bundle 还不能真的过准入，断在哪条链路上见末节。

## Declaration fields

- `id`：`^[a-z0-9][a-z0-9-]{0,31}$`（小写字母、数字与 `-`，最长 32 字符）。`dsh`、`claude`、`codex` 是宿主自己的 id（`BACKEND_RESERVED_IDS`，与注册表的 `BUILTIN_BACKEND_IDS` 双向比对）：贡献声明其中之一会在准入处被拒（`BACKEND_ID_RESERVED`）——`dsh` 的 session ref 序列化时不带前缀，插件戴这个 id 会和首方引用撞车；`claude` / `codex` 的行是宿主自己的词表。这是**词表**不是形状规则——宿主自己的 seed 合法地戴着它们，所以 `validateBackendSpec()` 放行，拒绝发生在准入处。
- `label`：`{ text }`，**只收字面量**。`label` 只允许 `text` 一个键，`{ kind: 'key' }` 作为未知字段被拒：宿主 i18n 键会让贡献借宿主的词说话。in-tree manifest 自己的 `{ kind: 'key' }` 标签由宿主在投影时展开成字面量，见下。
- `shortLabel`：非空字符串，picker 行使用。
- `product?`：可选的非空字符串，标识这个后端驱动的产品。
- `capabilities`：字符串数组，见「Capabilities and the runtime set」。
- `grants`：字符串数组，见「Grants and the trust model」。
- `install?`：`{ executor, specifier, version }`，三者都必须非空，见「Install surface」。
- `unloadExport?`：非空字符串，见「Lifecycle and failure」。
- `confirmation?`：`{ policy }`，形状预留、默认全确认，见「Permissions and security」。

以下 in-tree 私有项**不进公开声明**：`inTree`、`alwaysAvailable`、`nativeKey`、`vendorPackages`、`backendExport`，以及 `label.kind === 'key'`。宿主自己的 manifest 是这份公开声明的**超集**，`src/dsh-adapter/backend-contribution.ts` 的 `backendContributionOf()` 是唯一投影方向：剥掉上述私有项、把 key 标签展开成字面量、把缺省声明投影成 `capabilities: []` / `grants: []`。投影结果必须过 `validateBackendSpec()`——manifest 长出一个 spec 表达不了的字段时，门禁在投影处变红，而不是悄悄漂移。
`backendExport` 有意留在 in-tree：它是构建期索引从模块命名空间里取导出名的机制，不是贡献字段；贡献在注册时直接交出 handler 对象，由 `assertBackendHandler()` 断言（`id`、`detect`、`open` 必在，`descriptor`/`catalog`/`launch` 出现时必须是对象）。

## Capabilities and the runtime set

`capabilities` 声明该后端的 handler 运行期真会应答的会话能力，**必须覆盖** `AgentSession.capabilities` 实际返回的键集：声明的集合不小于服务面，`open()` 不得答话集合外的能力键（`scripts/verify-backend-contribution.ts` 用 probe 后端的两条路径把这条钉住）。

词表的真源是 `src/agent/capabilities.ts` 的 `SessionCapabilities`，spec 侧只有一份副本 `src/adapter/spec/backend-capabilities.ts` 的 `BACKEND_CAPABILITY_NAMES`（分层是单向的：`src/adapter/**` 今天没有任何一处 import `src/agent/**`，所以只能另写一份），由 `scripts/verify-backend-contribution.ts` 用 TypeScript AST **双向**比对：接口加了成员而常量没跟是红，常量编出一个接口没有的名字也是红。

未知名字**降级不拒绝**：贡献可以声明这个宿主的会话模型不认识的能力，准入把它记为待决项（`missingOptional` 里的 `capability:<name>`），判定为 `compatible_degraded`，而不是拒绝这个后端。

## Grants and the trust model

`grants` 只取宿主自己的权限词表 `registry/permissions-0.1.json`（闭集，8 条）。已知名字而没人授权 → 判定 `waiting_authorization`、`reasonCode` 为 `PERMISSION_NOT_GRANTED`：条目**注册但不进 picker**（`listOfferedBackends()`）——id 存在，启动的两段解析与 session refs 都必须找得到它，但选中它等于打开一个宿主描述不了的后端。未知名字沿用同一条「降级不拒绝 + 记为待决项」（`permission:<name>`）：静默当作可用等于宣称一条没人能撤销的授权，拒绝则等于自己发明一套权限词表。

准入判定本身是纯函数 `backendAdmission(spec, host)`，返回 `BackendAdmission`，沿用插件准入的五态词汇：`compatible`、`compatible_degraded`（带 `missingOptional`）、`waiting_authorization`（带 `deniedPermissions`），以及不会成为注册表条目的 `rejected`（`BACKEND_ID_RESERVED`）与 `unknown`——后两者由调用方抛错，内建 manifest 走到那里必须是响亮的构建期错误。

contract 的 `errors` 只发布**有产出者**的码，今天正好是上面两个：`BACKEND_ID_RESERVED`（准入拒绝）与 `PERMISSION_NOT_GRANTED`（等待授权，复用插件准入的词表）。形状违规（`label` 用宿主 i18n 键、声明 `nativeKey`）由 `validateBackendSpec()` 以未知字段的 `TypeError` 拒绝，不占错误码；能力/恢复不匹配一类的码在 C 段给出真正产出点之前不发布——发布没有产出者的码，等于让第三方为一条永远走不到的失败路径写错误处理。这一对由 `scripts/verify-backend-contribution.ts` 钉住。

**这不是隔离。** 后端在宿主进程内运行，就是全信任代码；准入、grants 与 effect ledger 给的是**能力声明与可审计性**，不是沙箱。后端真正需要的宿主服务——`BackendHost` 上的 `tokenStore`、`oauthCredential`、`stderr`，以及将来的 `dataDir`——是**可选宿主能力**，走 feature-detect，不是 grants。in-tree 三个后端今天都声明 `grants: []`：现有八条权限没有一条描述后端真正需要的东西（起子进程、读自己的 prefs、联网）。

## Install surface

`install` 是 `{ executor, specifier, version }`，三个字段都必须是非空字符串，缺一个即 validation 失败。执行器是**宿主实现的表**（首版只有 `pnpm-profile-add`）：宿主不认识的执行器读作「无安装面」（`installable: false`，那一行退回检测自己的 hint），不是拒绝注册。`install` 缺省也是一等公民——用户自己装的二进制就是依赖（codex 形态），声明「装什么、哪个版本、交给宿主哪个执行器」这件事只有真的能装的后端才做。

## Resume semantics

以下四条是定案口径（roadmap §6 第 11 条），按 `MUST` / `MUST NOT` 写：

- 启动恢复**只针对所选后端**（MUST）；宿主 MUST NOT 把恢复请求交给这次启动没有选中的后端。
- 恢复目标 MUST 绑定后端身份：一个派生出来的目标只在其来源后端上可用。**后端不可用、没有上次会话、指定会话不存在**三种情况一律 MUST 明确报错并以非零退出——MUST NOT 降级成冷启动，MUST NOT 静默新建一个没人要的会话。
- 裸 `--resume` MUST 只查**该后端自己的** `lastSession`。
- MUST NOT 回落到其他后端，MUST NOT 尝试恢复替代后端的上次会话，也 MUST NOT 自动新建会话；用户去掉 `--resume` 之后才按普通启动流程处理。

`lastSession` 的接口与恢复目标的传递方式**不在本协议内**（技术定稿）：`AgentBackend.launch.sessionPrefs()` 返回的 `lastSession()`，以及宿主侧承载这个目标的 env 名，都是实现的私事；`DSH_TUI_RESUME_BACKEND` 不是允许跨后端恢复的依据。

实现说明（不进协议）：安全模式的「重试正常启动」是唯一例外——它的目标派生自 `last-run.json`（崩溃时在跑的内核可能已经不在注册表里），在那里失败会关掉用户最后的退路，因此撤销在重试路径下降级为**告警 + 冷启动**，由一次性 env `DSH_TUI_RESUME_RETRY` 标记，启动读到即从环境里删除。

## Lifecycle and failure

`unloadExport` 只用于**模块级/进程级**资源池（codex 的 app-server hub 那种跨会话复用的池）；会话级资源归 `session.dispose()`，MUST NOT 塞进 `unloadExport`。

宿主只对**真的加载过**的条目记账并调用它的 `unloadExport`：「未加载即不关池」是宿主的不变量——没加载过的后端不会被 import，也不会被关池；第二次 unload 是 no-op。注册、加载、调用或 cleanup 失败必须响亮且**归属于具体的条目**（component、facet 与 contribution identity），MUST NOT 静默吞掉，也 MUST NOT 让别的贡献或基础 TUI 跟着倒。

## Permissions and security

声明里的文本按不可信输入净化：宿主剥离控制字符、按 terminal cell（不是 `string.length`）截断宽度，再让它们进 picker、launchpad 与 handoff 文案。`confirmation` 的未知取值一律拒（`BACKEND_CONFIRMATION_POLICIES` 当前只有 `confirm`）——贡献不许给自己免确认；字段形状先留着，将来要豁免嫡系只是**加一个取值**，不改字段、不算 breaking。

本协议不是安全边界，理由见「Grants and the trust model」。

## Machine definitions and conformance

Definition、validator 与 handler assertion 位于 [`protocols/tui-contributions.js`](../protocols/tui-contributions.js)：`BACKEND`、`BACKEND_RESERVED_IDS`、`BACKEND_CONFIRMATION_POLICIES`、`backendExtensionDefinition`、`validateBackendSpec()`、`assertBackendHandler()`，并随 `contributionExtensionDefinitions` 一起注册。

Contract profile：[`registry/contracts/backend-v1alpha1.json`](../registry/contracts/backend-v1alpha1.json)，与 Scene / SettingsSection 同一份 12 个必需键的形状，`securityBoundary: false`，`operations` 列出 `declare`、`detect`、`open`、`catalog`、`resume`。

Conformance requirement 是 `TUI-BACKEND-001`（记在 `conformance/requirements-v0.15.json`，测试文案 "Backend contribution shape, capability/grants declaration and resume binding semantics"），由五个 fixtures 承载：`valid-backend-contribution.json` 与四个 `invalid-backend-*`（未知字段、非法 id、宿主 i18n 键标签、capability 形状）。

宿主侧门禁是 `scripts/verify-backend-contribution.ts`：内建 manifest 的投影 dogfood、两份词表的单一真源、准入判定、`scripts/fixtures/probe-backend/` 这个假后端的资源不变量与安装面两态、坏声明必须红，以及末节的范围守卫。

## Not yet wired (W-1) — the C stage's entry condition

**第三方 bundle 现在还过不了准入。这不是 bug，是范围。** definition、validator、handler assertion、contract profile 与 conformance 都已可用，断掉的是**接线**：

- `registry/registry-0.15.json` 的 `extensions` 段（`tui.settings-section`、`tui.scene` …）没有任何生产代码读；`registryEntries()` 只读 `imports` + `definitions`，`Backend` 的 contract profile 也没有对应的 registry 条目。
- 宿主 descriptor 只发布有 **live probe 证据**的契约，`Backend` 不在 `HOST_SUPPORTED_CONTRACTS` 里，因此不会出现在 descriptor 的契约面上。
- 两处硬编码白名单把这件事钉住：`src/adapter/spec/protocol-constants.ts` 里 `HOST_SUPPORTED_CONTRACTS` 的 `supported` 集合（`commands` / `storage.local` / `messages.observe` / `tui.decision-events`），以及 `scripts/verify-protocol-single-source.ts` 的 `expectedHostContracts`。

`scripts/verify-backend-contribution.ts` 的最后三条断言（scope guard）**故意钉住「尚未接线」这个状态**：宿主还不支持 `Backend` 坐标、`registryEntries()` 仍不读 `extensions`、没有生产模块调用 `registerTuiContributionExtensions()`。C 段做 W-2 时应当**有意识地改掉这三条**——它们是那段工作的入口条件，不是要长期维护的不变量。
