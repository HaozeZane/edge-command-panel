# Edge Command Panel — Web 发布分支

Cloudflare Workers 上的轻量批量命令面板：静态 React 前端 + **单个 SQLite Durable Object** + 主动 WSS 接入的 Linux Agent。所有身份认证只使用 **Cloudflare Access**，没有自建密码、Cookie 会话或设备 Bearer。

> 状态说明：本仓库是 **Web 发布分支**，不包含 Agent 源码，也没有真实部署到任何 Cloudflare 账户。Web 与 Agent 使用不同分支；Agent 二进制只从固定 GitHub Release 获取。Cloudflare 真实部署、Access 撤销传播、Workers Free 账户额度与 Durable Object 长期 Hibernation 均保持 **UNKNOWN**，必须在获得授权后用真实账户验证。

## 0. 分支与发布布局

| 内容 | 位置 |
| --- | --- |
| Web 前端 + Worker + Durable Object | 默认分支 `web`（本仓库） |
| Agent 源码（Go） | 独立分支 `agent`，commit [`b6a1ec5`](https://github.com/HaozeZane/edge-command-panel/commit/b6a1ec56acaf08888991a6609df368dfa35651fc)，不在本分支 |
| Agent 二进制 / 安装脚本 | GitHub Release [`agent-v0.1.0`](https://github.com/HaozeZane/edge-command-panel/releases/tag/agent-v0.1.0) |

Web 分支没有 `agent/` 目录，也不需要 Go 工具链即可完整构建。构建阶段只从**固定 Release** 匿名下载以下三个附件，并按 `agent-release.json` 校验后写入 `frontend/dist/downloads/`：

- `edge-agent-linux-amd64`
- `edge-agent-linux-arm64`
- `install.sh`

下载文件名与既有下载 API 保持一致，`GET /agent/download/:arch`、`GET /agent/install.sh`、`GET /downloads/install.sh` 的行为不变。GitHub Release 只在构建阶段访问，Worker/前端运行时不存在 GitHub 依赖。

### 0.1 `agent-release.json` 锁文件

仓库根目录的 `agent-release.json` 固定发布来源与每个附件的 SHA-256：

```json
{
  "schemaVersion": 1,
  "repository": "HaozeZane/edge-command-panel",
  "tag": "agent-v0.1.0",
  "agentCommit": "<40 位小写 hex Agent 提交>",
  "checksumsSha256": "<SHA256SUMS 本身的 64 位小写 hex SHA-256>",
  "assets": {
    "edge-agent-linux-amd64": "<64 位小写 hex>",
    "edge-agent-linux-arm64": "<64 位小写 hex>",
    "install.sh": "<64 位小写 hex>"
  }
}
```

- 本发布锁定 Agent 源码 commit `b6a1ec56acaf08888991a6609df368dfa35651fc` 与 `agent-v0.1.0` Release；`agent-release.json` 记录该 Release 的 `SHA256SUMS` 和三个附件的真实 SHA-256。以后更新 Release/锁文件时同样必须填入对应的真实哈希，不得编造或复用旧值；占位符、非 64 位小写 hex 值或任何校验失败都会让 `npm run build` 立即失败，不会回退到 `latest`，也不会跳过校验。
- 校验顺序固定：先下载 `SHA256SUMS` 并核对 `checksumsSha256`，再严格解析三个附件条目并与 `assets` 比对，最后才下载二进制/安装脚本并逐个核对 SHA-256。
- 任一失败、缺附件、HTTP 错误、返回 HTML 页面、哈希不符或旧缓存不匹配都会使构建失败；旧缓存只会被重新校验或重新下载，绝不会冒充成功。
- 不需要 GitHub Token。构建脚本不会读取或写入 GitHub 凭据，也不会执行安装脚本或 `systemd`。

## 1. 架构

```
Browser ── Cloudflare Access(UI) ── Worker ── ASSETS (frontend/dist)
   │                                  │
   └── /events/ws (通知)              └── 单个 CommandHub DO (SQLite)
                                             │
Linux Agent ── Access(Agent Service Token) ── /agent/ws
```

- **一个 Worker、一个 DO、一个 SQLite 数据库**。不使用 D1 / KV / R2 / 外部后端。
- 前端是纯静态资源，Worker 也保护静态根路径，数据路径不能绕过 One Access。
- 管理员/自动化 API 共用一套 handler：`/ui-api/*`（人类）与 `/api/v1/*`（Service Token）。
- 机器按需自动创建 Cloudflare Access Service Token，并**实际加入仅设备 app 的 policy**。
- DO 使用 Hibernation WebSocket API：`ctx.acceptWebSocket`、`webSocketMessage/Close/Error`、attachment；命令任务全部落 SQLite。
- 保活：Agent 每 30 秒发送 WebSocket **control PING**，运行时自动 PONG；浏览器使用固定文本 `ping`/自动 `pong`。两者都不唤醒 DO，业务状态不依赖心跳写库。Agent/浏览器连接都有 15 分钟 authDeadline，由 Alarm 关闭后重新鉴权。
- Alarm 只用于未完成 run 的 deadline/acceptBefore、浏览器 WS 重鉴权、7 天清理与 Token 回收，没有常驻 timer loop。
- 浏览器关闭不会停止任务。DO 任务状态、事件、连接 ID、probe RTT 都在 SQLite 或 socket attachment 中恢复。

完整字段级契约见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)，共享类型见 [`shared/protocol.ts`](shared/protocol.ts)。

## 2. 免费额度预算

项目侧按以下保守预算运行，**不是** Cloudflare 账户账单的精确计量。该预算假设账户处于 **Workers Free** 套餐；如果账户已经是 Paid，不能把本项目描述为免费硬封顶，未获授权也不能为了本项目降级或修改套餐。真实账户额度仍为 **UNKNOWN**。

| 项目 | 默认上限 |
| --- | ---: |
| DO 请求 | 100,000 / UTC 日 |
| SQL rows read | 1,000,000 / UTC 日 |
| SQL rows written | 50,000 / UTC 日 |
| 日志帧 | 10,000 / UTC 日 |
| 单 run 输出 | 1 MiB |
| 全部事件/数据库 | 256 MiB |
| 已完结批次保留 | 7 天 |

达到预算后：

- 新批次返回错误（HTTP 507），不会自动升级或超卖。
- 输出日志达到每日/SQL 预算时服务端发送 `pause`，**不持久化、不 ACK** 新 output；Agent 保留序号连续性与 pending 数据，run 可能在 deadline 后进入 `unknown`，等待次日重放或人工处理。
- 单 run 超过 1 MiB、全库接近 256 MiB 时按契约截断并标记 `outputTruncated`。

`GET /usage` 返回的是本项目的保守估算，包含 usage upsert 自身和 Alarm 写入的近似成本；不要把它当作平台精确账单。

## 3. 目录

```
src/                 Worker 路由、Access JWT、DO、Cloudflare 自动 provision
shared/protocol.ts   前后端/Agent 共享类型
docs/PROTOCOL.md     冻结的 v1 协议
test/                Worker + DO + WebSocket + 配置 mock 测试（Cloudflare pool）
test-release/        Node 下载/校验测试（fixture Release，不访问真实网络）
scripts/             构建、固定 Release 下载校验、测试资产准备
frontend/            React/Vite 源码与本地构建产物
agent-release.json   固定 Agent Release 与附件哈希锁
wrangler.jsonc       Worker + SQLite DO migration + ASSETS（示例域名）
```

本分支没有 `agent/`、`node_modules/`、`dist/`、`coverage/`、`.wrangler/`、认证目录或运行日志。

## 4. 部署前置

以下只是步骤，**执行真实部署前必须获得项目所有者明确授权**。仓库使用通用示例值，不包含个人账户 ID 或真实域名：

- `wrangler.jsonc` 中的路由是 `panel.example.com`，`vars.PUBLIC_URL` 是 `https://panel.example.com`。
- `account_id` 已从仓库配置中移除；部署时由操作者自己的 Wrangler 登录/环境决定账户。
- 部署前把示例域名替换为你自己的域名，并同步修改 `vars.PUBLIC_URL`。

### 4.1 Cloudflare 资源

1. 一个 Cloudflare 账户、一个已接入的域名，以及 Workers 自定义域名。
2. 开启 Cloudflare Access，创建 **四个独立 Access application**。建议同一域名下按路径区分（Access 会选最具体路径）：

   | 用途 | 路径 | 环境变量 |
   | --- | --- | --- |
   | 人类面板 | `/*`（或 `/`、`/ui-api/*`、`/events/ws`、`/install`） | `ACCESS_UI_AUD` |
   | 自动化 API | `/api/v1/*` | `ACCESS_API_AUD` |
   | 设备 Agent | `/agent/*` | `ACCESS_AGENT_AUD` |
   | 批量注册 | `/enroll/*` | `ACCESS_ENROLL_AUD` |

3. UI app policy 允许管理员邮箱/群组；API app policy 允许一个手工创建的 API Service Token；Agent 与 Enroll app policy 使用 Service Auth（Service Token）。Worker 会向 **Agent/Enroll policy** 追加一机一 Token，并保留 policy 中未由本系统管理的其它 token/字段。
4. 记录四个 app 的 AUD、Team domain、Agent/Enroll 的 App ID 和 Policy ID。

### 4.2 后台 API Token

`CLOUDFLARE_API_TOKEN` 只需要该账户范围内的：

- Access Apps and Policies: **Edit**
- Access Service Tokens: **Edit**

Worker 只调用 service token 与指定 app/policy API，不修改根 UI app、API app 或其它账户 token。账户 Access Service Token 上限为 **50**（包含批量注册 Token，并扣除该账户已有的 API/Enrollment 等 token），Worker 会真实 list 计数并在接近上限时拒绝创建。

### 4.3 环境变量 / Secrets

复制 `.dev.vars.example` 到 `.dev.vars`（本地）或使用 `wrangler secret put`（生产）：

| 名称 | 说明 |
| --- | --- |
| `PUBLIC_URL` | 唯一允许的 origin，例如 `https://panel.example.com`；不匹配的 Host 返回 421 |
| `ACCESS_TEAM_DOMAIN` | 例如 `https://team.cloudflareaccess.com`；生产必须 https |
| `ACCESS_UI_AUD` / `ACCESS_API_AUD` / `ACCESS_AGENT_AUD` / `ACCESS_ENROLL_AUD` | 四个 app 的 AUD |
| `ACCESS_API_CLIENT_ID` | 可选，固定自动化 Service Token Client ID，防止其它同 AUD 服务身份调用 |
| `CLOUDFLARE_API_TOKEN` | 仅后台 provision 使用 |
| `CLOUDFLARE_ACCOUNT_ID` | 你自己的账户 ID（仅运行期 Secret，不写入仓库） |
| `AGENT_ACCESS_APP_ID` / `AGENT_ACCESS_POLICY_ID` | 设备 app 与 **专用** policy |
| `ENROLL_ACCESS_APP_ID` / `ENROLL_ACCESS_POLICY_ID` | 注册 app 与 **专用** policy |
| `CREDENTIAL_ENCRYPTION_KEY` | 32 字节随机值的 base64，例如 `openssl rand -base64 32`；用于 AES-GCM 保存设备 secret |
| `USAGE_*_LIMIT` | 可选，覆盖项目日预算（requests/rows read/rows written/log frames/storage bytes），仅用于运维，不建议放宽免费额度假设 |

缺失 Access 配置时 Worker **fail closed**（503）。没有 `AUTH_DISABLED` 后门；`ACCESS_JWKS` 仅允许 loopback issuer + loopback 请求的测试。

## 5. 构建与本地检查

```bash
npm ci
npm --prefix frontend ci
npm run typecheck
npm test
```

根依赖与前端独立依赖分开安装；只执行根 `npm ci` 不会安装 `frontend/` 自己的依赖。构建缓存写入 `.paseo-scratch/`，不复制 `node_modules`。

### 5.1 Web 分支构建

```bash
npm run build
```

该命令等于：

1. 构建前端（`npm --prefix frontend run build`）；
2. 从固定 GitHub Release 下载并校验 Agent 附件（锁文件不完整、占位符或哈希校验失败时立即失败）；
3. 运行 `wrangler deploy --dry-run`，**不会实际部署**。

不需要 Go，不需要 GitHub Token。构建阶段先核对 `SHA256SUMS` 自身哈希，再严格解析三个附件并比对锁文件，最后逐个核对附件 SHA-256 后原子写入 `frontend/dist/downloads/`。

```bash
npm run build:agent   # 只下载、校验并写入 Agent 附件
npm run deploy:dry    # 使用已下载附件，但每次重新按 manifest 校验后再 dry-run
```

`deploy:dry` 不会只检查文件是否存在：它会重新计算三个附件的 SHA-256 并与 `agent-release.json` 比较；缺失、错误哈希或 HTML 文件都会失败，必须重新运行构建。`npm run build` / `deploy:dry` 都不执行安装脚本，也不安装 systemd 服务。

本地开发：`npm run dev`。它仍要求 Access JWT；不存在绕过。测试中的 loopback JWKS 仅用于自动化测试。测试前的 `prepare:assets` 可能生成占位 `frontend/dist`，**仅用于本地测试**，不代表生产资源完整。

### 5.2 测试分层

```bash
npm run test:release   # Node：固定 Release 下载/校验，使用 fixture manifest，不访问网络
npm test               # release 测试 + Cloudflare Workers/Miniflare Vitest
npm --prefix frontend test
npm --prefix frontend run typecheck
```

- `test-release/` 注入 fake `fetch`，覆盖正确下载、manifest/SHA256SUMS 错误、附件哈希错误、HTTP 404、HTML 页面、不完整/占位 manifest、旧缓存重验/重下等场景。fixture manifest 不依赖真实 Release。
- `npm test` 使用 `@cloudflare/vitest-pool-workers` 在真实 Workerd/DO 中运行，不是把整个 DO mock 掉。两套测试配置独立（`vitest.config.ts` 与 `vitest.release.config.ts`）。
- `test/fixtures.ts` 包含**固定测试私钥和假的 `test-api-token`**，仅用于 loopback 自动化测试，不是生产密钥；不要据此整体豁免敏感扫描。

## 6. 安装 Agent

Agent 由独立 `agent` 分支维护，二进制由 `agent-v0.1.0` Release 提供。在面板中创建机器或注册批次后，`GET /agents/:id/install` 返回：

- `command`：可直接执行的单行命令，已安全 shell-quote；
- `link`：`PUBLIC_URL/install#<base64url(JSON)>`，前端 InstallView 可复制/下载；
- `script`：自包含脚本，含 shebang、`export ECP_URL/MODE/CLIENT_ID/CLIENT_SECRET[/AGENT_ID]` 和通用安装逻辑。

命令先下载临时文件，`trap` 清理，下载失败不会把空内容交给 bash 返回 0。客户端不得缓存或记录含密响应（服务端 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`）。

批量注册：

1. 管理员创建 enrollment，得到注册 Service Token 与安装命令。
2. 每台机器本地持久化 `installationId` + Ed25519 keypair。
3. `POST /enroll/challenge` 获取 60 秒一次性挑战。
4. `POST /enroll/register` 用 Ed25519 签名证明持有密钥；成功后得到本机专属 Access Service Token。
5. 相同 `installationId` 必须复用原 token，不按 hostname 认领；失败不占用 `maxAgents`。

Agent 使用 systemd 长期运行，`-config` 指向 0600 JSON；生产 WSS，只有 loopback 开发允许 ws。不要将 token 放入 argv 或日志。具体安装脚本系统服务参数由 Agent Release 产物提供。

## 7. 认证与安全要点

- JWT 校验签名、`iss`、`aud`、`exp/nbf`，JWKS 远程缓存。设备 Service Token 的 `common_name` 必须绑定数据库中该 Agent/Enrollment 的 Client ID。
- `/ui-api` 仅接受 UI AUD；`/api/v1` 仅接受 API AUD；设备/注册 JWT 无法调用管理 API。
- 人类写请求与浏览器 WS 强制同源 `Origin`；ServiceAuth 自动化 API 不需要 Origin，但必须已通过 API AUD JWT。静态资源也走 UI JWT 保护。
- 机器 secret 只以 AES-GCM 密文存 SQLite；安装信息需要显式 GET，响应 no-store。日志不记录请求体、token、完整 URL。
- Cloudflare One list/get 不返回 secret。Worker 在重试时优先从已绑定 agent/enrollment 的密文恢复；未绑定孤儿只有在精确 token 名与持久 provision intent/match 时才清理，绝不会只按名字相似删除外部 token。注册与 rotate 使用稳定 token 名和持久 intent；rotate 记录 `previous_token_id`，中断窗口由下一次 rotate 或每日 Alarm 回收，避免持续占额。
- 关闭/删除：
  - `POST /agents/:id/disable` 本地立即断开并永久阻断重连，同时串行删除其专属 Access Token；Cloudflare 清理失败会返回错误但本地禁用仍生效，重复调用可重试。
  - 撤销 enrollment 同样本地立即生效，并回收其注册 Token；失败保留 revoked 状态，重复 revoke 重试。每日 Alarm 只回收本项目记录的过期/撤销 token，不触碰其它账户 token。
- 浏览器 WS 最长 15 分钟（或 Access JWT 到期，取更早），Alarm 到期关闭；客户端重连时由 Access 重新鉴权。Access 撤销不保证旧连接立即断开。
- `online` 只代表已认证 socket 在线；probe RTT 单独在 attachment 中，可能过期，普通 socket 在线不等于端到端健康。

## 8. 数据与行为

- 每台 Agent 同时最多一个 run；离线/忙碌目标直接 `skipped_offline`/`skipped_busy`。
- 批次 requestId 幂等；目标 union 在第一次创建时冻结；发送后不自动重试/重派，结果不明为 `unknown`。
- 事件按连续 seq ACK；重复幂等，gap 只 ACK 当前连续值；终态不可被重复帧改写，`unknown` 可被之后可信 finish 校正。
- 单 run 输出上限 1 MiB；全库 256 MiB；完结批次 7 天清理。
- Probe 每 15 秒合并，不写 SQL；RTT 存 socket attachment，休眠后随 attachment 恢复。
- `GET /usage` 是本项目预算视图；`limited=true` 时拒绝新批次。

## 9. 验证证据说明

`docs/verification.json` 保留的是**拆分前组合项目**的历史快照，已标记 `priorSnapshot: true`，**不构成本 Web 发布分支的验收结论**。

- 历史组合证据：65 个 TypeScript 测试与 Go 测试来自包含 `agent/` 的旧组合项目；拆分后 Web 分支没有 Go 源码，不能把旧 Go 结果直接当作本分支结果。
- 本次拆分应分别记录：根 `typecheck`、Cloudflare Vitest、前端 `typecheck`/`test`/`build`、Node `test:release` 下载校验。
- 真实 Cloudflare 部署、Access 实际行为、Workers Free 账户额度、Durable Object 长期 Hibernation、真实 systemd 安装仍全部为 **UNKNOWN / NOT_RUN**。
- 本发布对应 Agent 源码 commit `b6a1ec56acaf08888991a6609df368dfa35651fc` 与 `agent-v0.1.0` Release；`agent-release.json` 必须记录该 Release 的真实 `SHA256SUMS` 与附件哈希。以后更新锁文件时同样只能使用真实哈希；占位符或错误哈希会使构建失败。

## 10. 真实部署（需明确授权）

真实部署命令由有权限的操作者执行；本仓库不会自动 deploy，也不会创建新 GitHub Actions 或远端自动运行：

```bash
npm run cf:whoami        # 确认当前 Wrangler 登录的账户
npm run deploy:production
```

`workers_dev` 与 `preview_urls` 均为 `false`，公网入口使用你在 `wrangler.jsonc` 中配置的自定义域名（示例为 `panel.example.com`）。部署顺序：

1. 用 `npm run cf:whoami` 确认登录的是你自己的目标账户，并确认套餐假设；未获授权不得为部署本项目而变更套餐。
2. 把 `wrangler.jsonc` 的示例路由与 `vars.PUBLIC_URL` 改成你的真实域名。
3. 在 Cloudflare One / Access 中按上表配置 **四个独立 application 与 policy**（UI、API、Agent、Enroll），并覆盖该域名。
4. 在与部署脚本相同的 `XDG_CONFIG_HOME=.paseo-scratch/cloudflare-auth` 与 `WRANGLER_SEND_METRICS=false` 环境下，用 `npx wrangler secret put <NAME>` 写入 §4.3 的全部生产 Secrets；`PUBLIC_URL` 已在 `vars` 中固定。
5. **获得用户明确批准后**才执行 `npm run deploy:production`。部署会创建自定义域名并绑定 DNS；未批准前只允许 `npm run deploy:dry`。

注意：Wrangler 的 OAuth 登录（`cf:whoami` 使用的凭据）只用于部署/管理操作，**不等于**后台自动注册设备 Service Token 所需的 Cloudflare API Token。`CLOUDFLARE_API_TOKEN` 必须另行在 Dashboard 创建并作为 Secret 配置，权限见 §4.2。

## 11. 已知限制 / UNKNOWN

- 真实 Cloudflare 账户上的 Durable Object 长期 Hibernation、WebSocket 唤醒、Access 撤销传播未验证。
- 本版本 Workerd/Miniflare 在“保留 hibernated socket 后 evict DO”时后续 HTTP/WS 会挂起，因此自动化测试改为校验 attachment 持久字段 + 断开后强制内存重建 + SQL 恢复；这不等于云端 Hibernation 已验证。
- 免费额度是本项目估算，不保证与账户账单完全一致，也不保证无界用量。
- Access 账户 Service Token 上限 50；大规模机器需另行设计，不在 V1 范围内。
- 100 只是协议单批 target 上限，**不是可接入机器承诺**。Access Service Token 账户总上限 50，且要扣除 API/Enrollment 等已有 token；单 DO + SQLite + 免费额度不承诺更高规模。
- 真实部署、DNS、Access policy 变更、Agent 服务安装均需另行授权；本仓库未执行。
- Web 构建只验证 Release 附件哈希与文件名，不验证 Agent 源码签名或供应链来源；发布者仍需保护 `agent` 分支和 Release 权限。
