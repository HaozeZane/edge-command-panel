# Edge Command Panel 协议 v1

本文是 Worker、Linux Agent 与前端之间的唯一线上契约。时间均为 **epoch 毫秒**；所有错误响应为 JSON `{ "error": string }`；成功响应为对象。协议 v1，JSON 帧最大 **64 KiB**。

## 1. 认证与路由（Cloudflare Access ONLY）

系统**没有**自建登录、密码、Cookie 会话或设备 Bearer。全部身份由 Cloudflare Access 注入的 `cf-access-jwt-assertion` 决定。Worker 校验签名、`iss`、`aud`、`exp` 与 `nbf`，缺失或校验失败即 503/401，不存在本地关闭认证的开关。

| 路径 | Access 应用 AUD | 身份 | 用途 |
| --- | --- | --- | --- |
| `/`、静态资源、`/ui-api/*`、`/events/ws` | `ACCESS_UI_AUD` | 人类 | 管理面板 + 浏览器 WS |
| `/api/v1/*` | `ACCESS_API_AUD` | 自动化 Service Token（`common_name` 为 Client ID） | 管理 API |
| `/agent/*` | `ACCESS_AGENT_AUD` | 一机一 Service Token | Agent WSS、安装、下载 |
| `/enroll/*` | `ACCESS_ENROLL_AUD` | 批量注册 Service Token | 注册、安装、下载 |

- 所有请求必须命中 `PUBLIC_URL` 的 origin；否则拒绝。生产 Access team domain 必须为 https；测试 JWKS 仅允许 loopback issuer + loopback 请求。
- `/ui-api` 与 `/api/v1` 复用同一管理 handler。`GET /session` 仅 `/ui-api` 可用。
- 设备 JWT（`ACCESS_AGENT_AUD`）不能访问 `/ui-api/*`、`/api/v1/*`、`/events/ws`；批量注册 JWT 同理。
- Agent 与注册 Service Token 的 `common_name` 必须分别绑定数据库中的 `access_client_id`。不接受客户端自报的 Agent ID 作为认证依据。
- 浏览器写请求和浏览器 WS 必须带与 `PUBLIC_URL` 同源的 `Origin`。ServiceAuth 管理 API 不需要 Origin，但已验证的 JWT 身份必须为 API AUD。
- 浏览器 WS 连接最长 15 分钟（或 JWT 到期，取更早者），由单 Alarm 关闭，客户端重新走 Access 重连。Access 撤销不保证旧 WS 立即断开；本系统只能保证 disable 后本地拒绝重连。

## 2. 管理 API

两套前缀：

- `/ui-api`（人类，JWT UI AUD）
- `/api/v1`（Service Token，JWT API AUD）

其后路径相同：

```
GET    /session                    // 仅 /ui-api；=> { authenticated: true, identity }
GET    /agents                     // => { agents: Agent[] }
POST   /agents                     // { requestId: UUID, name?, groupIds? } => { agent }
PATCH  /agents/:id                 // { name?, groupIds? } => { agent }
POST   /agents/:id/disable         // => { ok: true }
POST   /agents/:id/rotate          // => { agent }
GET    /agents/:id/install         // => InstallInfo，Cache-Control: no-store
GET    /groups                     // => { groups: Group[] }
POST   /groups                     // { name } => { group }
PATCH  /groups/:id                 // { name } => { group }
DELETE /groups/:id                 // => { ok: true }
GET    /enrollments                // => { enrollments: Enrollment[] }
POST   /enrollments                // { requestId, name, groupIds, maxAgents, ttlMinutes } => { enrollment, install }
GET    /enrollments/:id/install    // => InstallInfo，Cache-Control: no-store
POST   /enrollments/:id/revoke     // => { ok: true }
POST   /batches                    // 见下 => { batch, runs }
GET    /batches?cursor=            // => { batches, nextCursor: string|null }
GET    /batches/:id                // => { batch, runs }
GET    /runs/:id/events?afterSeq=N // => { events: RunEvent[], nextSeq, hasMore }
GET    /usage                      // => Usage
POST   /agents/probe               // { agentIds: string[] } => { ok: true }
```

### 2.1 对象

```ts
Agent = {
  id, name, hostname?, groupIds: string[], disabled, online, version?,
  currentRunId?, latencyMs?, latencyMeasuredAt?, createdAt
}
Group = { id, name }
Batch = { id, requestId, command, timeoutSec, createdAt }
Run = {
  id, batchId, agentId, agentName, status, lastSeq,
  exitCode?, reason?, outputTruncated?, createdAt, finishedAt?
}
Enrollment = {
  id, name, groupIds, maxAgents, registeredCount,
  expiresAt, revoked, createdAt
}
InstallInfo = { command, link, script }
```

`RunStatus = dispatching | accepted | running | succeeded | failed | timed_out | interrupted | unknown | skipped_offline | skipped_busy`。

### 2.2 创建 Agent / 注册批次（自动 provision）

- Service Token 由 Worker 使用 `CLOUDFLARE_API_TOKEN` 后台创建，并**实际加入**对应 Access app 的设备 policy；仅创建 token 不加入 policy 视为失败。
- 每机 token 的 secret 使用 AES-GCM（`CREDENTIAL_ENCRYPTION_KEY`，32 byte base64）加密后存 SQLite；`GET .../install` 可重复解密获取。
- Cloudflare One 只在创建响应返回 secret，list/get 不返回。恢复流程：已绑定 agent/enrollment 时从 AES 密文取 secret；未绑定的孤儿 token 仅当精确 `token_name` 与本项目持久 provision intent 匹配时，才从指定 app policy 移除并 DELETE 后重建；绝不按名字相似删除外部 token。Agent create/enrollment create 使用请求 UUID name，注册与 rotate 使用稳定 hash token name + 持久 intent。rotate 在 SQL 中记录 `previous_token_id`，中断后下次 rotate/每日清理会回收旧 token，避免持续占额。
- 创建/轮换/注册操作串行执行。修改 policy 前先 GET，保留未由本系统管理的 token 和字段；失败回滚新建 token，保留可恢复状态，不返回假成功。
- 设备 token 默认请求 8760h；批量注册 token 的 One duration 为 `ttlMinutes + 60m`，但本地 enrollment `expiresAt` 始终是注册开关的权威限制。
- `disable` 在本地立即关闭连接并阻断重连，同时回收该 Agent 自己的 token；Cloudflare 回收失败时返回错误但本地禁用保持，重复 disable 可重试。`revoke enrollment` 同理。每日 Alarm 仅按本地 `access_token_id` 回收本项目记录的过期/撤销 token，不触碰账户其它 token。
- 账户 Service Token 上限 50（包含批量注册 token）。真实调用 list 计数，并为并发操作保留余量；超限拒绝创建。
- `requestId` 幂等：同 ID 同 payload 返回原结果；同 ID 不同 payload 返回 409。双击不得创建双 token。
- `POST /agents` 无 `name` 时使用占位名；首次 `hello` 的 `hostname` 自动命名，但手工 PATCH 的名称永久优先。
- 仅修改 `AGENT_ACCESS_POLICY_ID` / `ENROLL_ACCESS_POLICY_ID`，绝不碰根 UI app、API app 或人类 policy。

### 2.3 批量注册

安装端持久化 `installationId` 与 Ed25519 密钥对，避免重复注册和他人按 ID 抢注。

```
POST /enroll/challenge   { installationId, publicKey(base64 raw 32B) }
  => { challenge, expiresAt }       // 60 秒，一次性，绑定 enrollment/installationId/publicKey
POST /enroll/register    { installationId, hostname, publicKey, challenge, signature(base64) }
  => { agentId, url, clientId, clientSecret }
```

签名原文为 UTF-8，逐行拼接：

```
ECP-ENROLL-V1
<challenge>
<installationId>
<hostname>
<publicKey>
```

服务端验证 Ed25519。challenge 一次性，错误/过期/跨 enrollment 重放均拒绝。相同 `installationId` 再次注册必须 publicKey 匹配且提供新 challenge；复用已有专属 token，不按 hostname 认领，hostname 可重名。首次 agent 名为 hostname，group 使用 enrollment 默认组。`registeredCount < maxAgents` 且全局 token 额度充足才可成功；失败不占名额。过期/撤销 enrollment 拒绝注册。

### 2.4 创建批次

```json
{
  "requestId": "UUID",
  "agentIds": ["..."],
  "groupIds": ["..."],
  "command": "非空 <= 16384 bytes",
  "timeoutSec": 300
}
```

- `agentIds ∪ groupIds 成员`，目标冻结、去重，1..100。
- `timeoutSec` 1..3600，默认 300。
- 先在一个 SQL 事务中写入 batch 与全部 runs，再发送 `execute`。不会先发后落库。
- 同一 `requestId` + 规范化 payload：返回旧 batch；payload 不同：409。
- 离线/禁用目标直接 `skipped_offline`；已有并行 run 的目标 `skipped_busy`。每台 Agent 同时最多一个 run。
- 不自动重试、不自动重派。发送后没有 accepted 回执，到 `acceptBefore + grace` 由 Alarm 标记 `unknown`。
- 单 run 输出累计 1 MiB；全库事件 256 MiB、保留 7 天；达到项目预算拒绝新批次。

### 2.5 Usage / 限额

```ts
Usage = {
  day: "YYYY-MM-DD", requests, rowsRead, rowsWritten, logFrames, storageBytes,
  limits: { requests, rowsRead, rowsWritten, logFrames, storageBytes },
  limited: boolean
}
```

默认项目上限：DO 请求 100000/日、SQL 读 1000000/日、SQL 写 50000/日、日志帧 10000/日、事件存储 256 MiB。`limited=true` 时拒绝新批次；不自动升级。计数是项目侧保守估算，不是 Cloudflare 账户账单。协议 targets 上限 100 不是可接入机器承诺；Access Service Token 总账户上限 50，已扣除 API/Enrollment 等其它 token。

### 2.6 Probe

浏览器每 15 秒可调用 `POST /agents/probe`，服务端对同一 Agent 的探测请求合并去重 15 秒。DO 发送 `probe`，记录 attachment 中的发送时间；收到 `probe_reply` 后计算 RTT，也仅写入 attachment，不写 SQL。`online` 只表示已认证 socket 在线；`latencyMs` 单独有过期时间，二者不可混同。

### 2.7 安装信息

`GET /agents/:id/install` 与 `GET /enrollments/:id/install` 返回 `InstallInfo{command,link,script}`：

- `command` 先用 `mktemp`/`trap` 安全下载到临时文件，再执行；下载失败不会执行空脚本。
- `script` 是自包含脚本：bash shebang + 安全 shell-quote 的 `ECP_URL`、`ECP_MODE`、`ECP_CLIENT_ID`、`ECP_CLIENT_SECRET`（direct 模式另有 `ECP_AGENT_ID`）+ 通用安装逻辑。
- `GET /agent/install.sh`、`GET /enroll/install.sh` 仍返回**不含凭据**的通用脚本。
- 所有含密响应 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`；token 不进 query。

## 3. Agent WebSocket `GET /agent/ws`

只通过 Access Agent Service Token JWT 认证；`common_name` 查数据库绑定 Agent。新连接认证成功后替换旧连接，旧连接的消息和 close 事件不得修改新连接状态。所有业务帧 JSON，`v:1`，单帧 ≤ 64 KiB。

保活：Agent 每 30 秒发送 **WebSocket 协议 control PING 帧**，由运行时自动 PONG；90 秒未收到 PONG 则重连。浏览器使用固定文本 `ping`，由 `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping","pong"))` 自动回复。两者都不应唤醒 DO 写库；不要用业务 `lastSeen` 把安静 socket 误判离线。Agent 与浏览器连接均受 15 分钟 authDeadline 约束，由 Alarm 关闭并重新鉴权。

### 3.1 服务端 -> Agent

```ts
{ v:1, type:"welcome", connectionId }
{ v:1, type:"execute", runId, command, timeoutSec, acceptBefore } // 30 秒接收窗口
{ v:1, type:"ack", runId, throughSeq } // 仅连续、已持久化
{ v:1, type:"probe", probeId }
{ v:1, type:"pause", retryAfter }      // 毫秒；只暂停 output，finish 保留
```

### 3.2 Agent -> 服务端

```ts
{ v:1, type:"hello", bootId, version, hostname, runs?: [{ runId, state, lastSeq }] }
{ v:1, type:"event", runId, seq, kind, stream?, dataBase64?, status?, exitCode?, reason?, outputTruncated? }
{ v:1, type:"probe_reply", probeId }
```

`kind`：

- `accepted`：收到 execute。
- `started`：进程已启动。
- `output`：`stream` 必须为 `stdout|stderr`；`dataBase64` 为标准 base64，服务端严格校验，不假定 UTF-8。
- `finished`：`status` 必须为 `succeeded|failed|timed_out|interrupted`；可带真实 `exitCode`、`reason`、`outputTruncated`。

规则：

- `seq` 从 1 连续递增。服务端只持久化连续 seq；重复 seq 幂等；gap 只 ACK 当前连续值。
- 事件必须归属已认证 Agent 的 run；跨 Agent 拒绝。
- 终态不可被重复帧改写；`unknown` 可被之后可信的 `finished` 校正。
- 服务端累计 1 MiB/run、每日 10000 日志帧、全库 256 MiB。单 run 超限可截断并 ACK（标记 `outputTruncated`）。若达到每日日志帧、SQL 写预算或全库容量，服务端发 `pause` 且**不持久化、不 ACK** 新 output；Agent 继续保留 pending 数据，待下一 UTC 日重放或由 deadline 进入 `unknown`。不得 ACK 未持久化的事件。
- `hello` 只接受补报/ACK 恢复，不重新派发 `dispatching` run，不刷新旧 `acceptBefore`。Agent 本地 journal 保证同一 runId 永不二次 spawn。
- 连接替换后旧 socket 上的 event/close 全部丢弃。`hello.runs` 可补报本地非终态 run 与 lastSeq；服务端不信任其持久化，只据此恢复 ACK/允许后续重放。

## 4. 浏览器通知 WS `GET /events/ws`

Access UI JWT + 同源 `Origin`。只接收通知，永不执行命令。连接 attachment 保存 `authDeadline`（≤ 15 分钟），单 Alarm 到期关闭。HTTP 历史始终是权威数据。

```ts
{ v:1, type:"changed", batchId?, runId?, lastSeq? }
{ v:1, type:"agents_changed" }
```

普通 Agent socket 在线 **不等于** 端到端健康；健康度只由 probe RTT 表达，并可能过期。

## 5. Alarm 与 Hibernation

唯一 Alarm 只安排下一件确定的事：未完成 run 的 deadline/acceptBefore + grace、Agent/浏览器 WS authDeadline、7 天历史清理与过期 Token 回收。没有 DO 常驻 timer loop，不使用 `setInterval` / 长 `setTimeout`。

Hibernation 后只依赖 SQLite 与 WebSocket attachments 恢复：任务状态、事件、token 密文、连接 ID、probe RTT 均在持久存储或 attachment 中。内存清空不得导致丢任务或重复执行；发送结果不明一律 `unknown`，绝不自动重派。云端长期休眠行为尚未在真实账户验证，标记 UNKNOWN。
