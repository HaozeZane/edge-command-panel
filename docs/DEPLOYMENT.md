# GitHub Actions 部署到 Cloudflare Workers

本文说明 `.github/workflows/deploy-cloudflare.yml` 的配置与使用。Actions 运行记录见 [Deploy to Cloudflare Workers runs](https://github.com/HaozeZane/edge-command-panel/actions/workflows/deploy-cloudflare.yml)；本文不预判 workflow 当前是否已运行。真实 Cloudflare 部署、Access 行为、Workers 套餐额度与 Hibernation 仍为 **UNKNOWN**。

## 1. 工作流概览

触发方式：

- push 到 `web` 分支；
- 手动 `workflow_dispatch`（在 Actions 页面选择 `web` 分支）。

两个 job 都有 guard：

```yaml
github.repository == 'HaozeZane/edge-command-panel'
github.ref == 'refs/heads/web'
```

`deploy` 还要求 `needs.verify-build.result == 'success'`，并绑定 GitHub Environment `production`。没有 `workflow_dispatch` 的 ref 输入，部署不会接受任意分支或任意 SHA 参数，只使用本次 run 的 `github.sha`。

### 1.1 `verify-build`：只验证，不接触 production secrets

1. checkout `github.sha`（`persist-credentials: false`）；
2. 安装 Node 24；
3. 根 `npm ci` 与 `frontend` 独立 `npm ci`；
4. 根与前端 typecheck；
5. 根 `npm test`（含 release 下载/校验测试、Cloudflare Vitest）与前端测试；
6. `npm run build`：前端构建 + 固定 Agent Release 下载校验 + Wrangler dry-run；
7. 只上传 `frontend/dist` 作为 artifact。

该 job 没有 Environment，也没有任何 Cloudflare secret。Actions 使用官方 action 的完整 commit SHA 固定版本，workflow 权限只有 `contents: read`；`setup-node` 显式设置 `package-manager-cache: false`，不启用任何自动 npm cache。

### 1.2 `deploy`：Environment + gate + 最终部署

1. 从同一次 run 下载 `frontend-dist` 到 `frontend/dist`；
2. 安装锁定根依赖（无 secret）；
3. 读取 `production` Environment 的 `DEPLOY_ENABLED`；
4. 仅当值严格等于字符串 `true` 时继续；
5. 用 `verifyStagedRelease` 重新核对下载 artifact 中三个 Agent 附件的 SHA-256；
6. 生成临时生产配置与两个 Worker runtime secrets；
7. 用本地 `node_modules/.bin/wrangler deploy` 部署；
8. `trap` 与 `always()` 双重清理临时文件。

`DEPLOY_ENABLED` 不是 `true` 时，deploy job 会在 Step Summary 写明：

```text
Cloudflare deployment skipped
DEPLOY_ENABLED is not 'true' in the production environment.
This run verified the build only; no Cloudflare deployment was attempted.
```

因此可以先接入 workflow、验证构建，最后才打开部署开关。

production concurrency 固定为：

```yaml
group: cloudflare-production
cancel-in-progress: false
```

## 2. GitHub Environment 配置

### 2.1 创建 Environment

在仓库 **Settings → Environments** 创建 `production`。

建议在 **Deployment branches and tags** 中选择 **Selected branches**，只允许 `web`。workflow 本身已校验 ref；Environment 规则是第二层保护。

Environment 的 Variables 与 Secrets 只对该 environment 的 deploy job 可见。`verify-build` 不使用它们。

### 2.2 Variables

在 **Settings → Environments → production → Environment variables** 添加：

| Variable | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `DEPLOY_ENABLED` | 部署时必填 | 未设置/`false` | 只有严格字符串 `true` 才部署；配置完成前保持未设置或 `false` |
| `CLOUDFLARE_ACCOUNT_ID` | 是 | 无 | 32 位十六进制账户 ID；脚本会校验并规范为小写 |
| `PUBLIC_URL` | 否 | `https://ssh.zhouhaoze.com` | 必须是 https origin，不能带路径、查询、片段或端口；hostname 会生成 Custom Domain 路由 |
| `ACCESS_TEAM_DOMAIN` | 是 | 无 | Access Team domain，例如 `https://team.cloudflareaccess.com`；裸 hostname 会被规范为 https origin |
| `ACCESS_UI_AUD` | 是 | 无 | 人类面板 Access application 的 AUD |
| `ACCESS_API_AUD` | 是 | 无 | 自动化 API Access application 的 AUD |
| `ACCESS_AGENT_AUD` | 是 | 无 | 设备 Agent Access application 的 AUD |
| `ACCESS_ENROLL_AUD` | 是 | 无 | 批量注册 Access application 的 AUD |
| `ACCESS_API_CLIENT_ID` | 否 | 无 | 固定自动化 Service Token Client ID；不填则不写入 Worker vars |
| `AGENT_ACCESS_APP_ID` | 是 | 无 | 设备 Agent Access app ID |
| `AGENT_ACCESS_POLICY_ID` | 是 | 无 | 设备 Agent 专用 policy ID |
| `ENROLL_ACCESS_APP_ID` | 是 | 无 | 批量注册 Access app ID |
| `ENROLL_ACCESS_POLICY_ID` | 是 | 无 | 批量注册专用 policy ID |

规则：

- 四个 `ACCESS_*_AUD` 必须互不相同；重复会被脚本拒绝。
- `PUBLIC_URL` 默认 `https://ssh.zhouhaoze.com`；如果要换域名，先在 Cloudflare 准备好对应 zone，再修改 Variable。
- Variables 不是 secret，会出现在 workflow 配置与日志上下文中；不要把 token 放进 Variables。
- 现有 `USAGE_*_LIMIT` 等软预算变量若在模板中存在，会被保留；workflow 不会添加付费产品或升级套餐。

### 2.3 Secrets

在 **Settings → Environments → production → Environment secrets** 添加三个 Secret：

| Secret | 写入位置 | 用途 |
| --- | --- | --- |
| `CF_DEPLOY_API_TOKEN` | 只在最终部署步骤作为进程环境变量 `CLOUDFLARE_API_TOKEN` | 让 Actions 调用 Cloudflare API 部署 Worker、上传版本/secret、绑定 Custom Domain |
| `CF_ACCESS_MANAGEMENT_API_TOKEN` | Worker secret 键 `CLOUDFLARE_API_TOKEN` | Worker 运行期自动创建/回收 Access Service Token、更新 Agent/Enroll policy |
| `CREDENTIAL_ENCRYPTION_KEY` | Worker 同名 secret | AES-GCM 加密/解密设备 secret |

#### `CF_DEPLOY_API_TOKEN`

这是 **部署 token**，不是 Worker 运行期 token。它不会进入 `wrangler.production.generated.json` 的 `vars`，也不会进入 `worker-secrets.json`。最终步骤只把 GitHub Secret 映射为 Wrangler 进程环境变量：

```yaml
env:
  CLOUDFLARE_API_TOKEN: ${{ secrets.CF_DEPLOY_API_TOKEN }}
```

Cloudflare 当前的 Workers 角色与官方说明（[Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/)）：

- **首次创建 Worker**：需要 Workers **product scope Admin**。per-Worker 角色不能授予尚不存在的 Worker，因此首次自动创建不能用仅 per-Worker 的 Admin/Editor。
- **更新已存在的 Worker**：需要 Workers **Editor**；可以是 product scope，也可以按 Worker 限定（Custom Domain 除外）。
- **添加/更新 Custom Domain 或 Route**：除 Worker Editor/Admin 外，还需要受影响 zone 的 **Zone → Workers Routes → Write**。Custom Domain 目前不支持 per-Worker roles。
- **旧权限 `Workers Scripts Edit`** 仍保留在官方 legacy role 兼容映射中（映射到 `Editor`）；这不等同于可以绕过当前角色要求。请在控制台按当前 Workers roles 选择：首次创建使用 product-scope `Admin`，更新已有 Worker 使用 `Editor`。旧权限的可用性以控制台当前选项与官方兼容说明为准。
- 不需要 KV、R2、D1、Queues 等资源权限；本项目不使用这些产品。不要为本 workflow 添加它们。
- Token 应限制在目标 Cloudflare account；涉及 Custom Domain 时限制到对应 zone。

如果 Worker 已由你手工创建、Custom Domain 也已配置，之后可以收窄为 Editor；workflow 仍会在每次部署时应用同一域名配置，建议保留对应 zone 的 Workers Routes Write，避免首次/域名变更失败。

官方参考：

- <https://developers.cloudflare.com/workers/authorization/workers/>
- <https://developers.cloudflare.com/fundamentals/api/reference/permissions/>
- <https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy>

#### `CF_ACCESS_MANAGEMENT_API_TOKEN`

这是 **Worker 运行期** token，只用于 `src/cloudflare.ts` 中的 Access 管理 API：

| 权限 | 范围 |
| --- | --- |
| Access: Apps and Policies → Edit | Account |
| Access: Service Tokens → Edit | Account |

它不需要 Workers 部署权限。workflow 把它写入 Worker secret：

```json
{
  "CLOUDFLARE_API_TOKEN": "<CF_ACCESS_MANAGEMENT_API_TOKEN>",
  "CREDENTIAL_ENCRYPTION_KEY": "<CREDENTIAL_ENCRYPTION_KEY>"
}
```

JSON 文件位于 `$RUNNER_TEMP/worker-secrets.json`，权限 `0600`，只包含上面两个 key。`wrangler --secrets-file` 使用 JSON，不做 dotenv 插值，因此最终部署步骤的 `CLOUDFLARE_API_TOKEN`（deploy token）不会被展开进 Worker secret。临时 secrets 文件内容不会被脚本打印；部署步骤用 `trap` 清理，job 结束再用 `always()` 兜底删除。

#### `CREDENTIAL_ENCRYPTION_KEY`

要求：

- 严格 base64；
- base64 解码后必须正好 32 bytes；
- 典型生成命令：

```bash
openssl rand -base64 32
```

**只生成一次，后续部署保持不变。** 该 key 用于加密已写入 SQLite 的设备 secret；随意轮换会让历史密文无法解密，需要迁移或重新注册设备。脚本会拒绝非 canonical base64、长度不符或带前后空白的值，并且错误信息不会回显 key 内容。

## 3. Cloudflare 侧前置条件

workflow **不会创建** Cloudflare Access application 或 policy。首次部署前必须手工准备：

1. 目标 zone 已接入 Cloudflare，并且当前 API token 对该 zone 有 Workers Routes Write。
2. 在 Cloudflare One / Access 中创建四个独立 application 与 policy：

   | 用途 | 路径 | AUD Variable |
   | --- | --- | --- |
   | 人类面板 | `/*` 或 `/`、`/ui-api/*`、`/events/ws`、`/install` | `ACCESS_UI_AUD` |
   | 自动化 API | `/api/v1/*` | `ACCESS_API_AUD` |
   | 设备 Agent | `/agent/*` | `ACCESS_AGENT_AUD` |
   | 批量注册 | `/enroll/*` | `ACCESS_ENROLL_AUD` |

3. 记录四个 AUD、Team domain、Agent/Enroll app ID 与专用 policy ID。
4. Agent/Enroll policy 需要允许 Service Auth；worker 会在运行期向专用 policy 追加一机一 token，并保留未由本项目管理的其它条目。
5. `PUBLIC_URL` 的 hostname 将作为 Custom Domain；确保 DNS/zone 与 `zones` 权限匹配。

Agent 与 Enroll 必须各自使用独立专用 policy：`decision` 必须是 `non_identity`，reusable policy 的 `app_count` 必须为 1。共享同一个 policy 或绑定多个应用会被拒绝，并提示配置独立策略。更新 reusable policy 使用账户级 `/access/policies/{policy_id}`；只有账户级 GET 明确 404 时才回退旧的应用级 endpoint，403/429/500/network 不会回退或重试。

Access 配置的更多说明见 README 的 §4.1 / §4.2 与 `docs/PROTOCOL.md`。

## 4. 首次启用步骤

1. 完成 Cloudflare Access 四套 app/policy 与 zone 准备。
2. 在 GitHub 创建 `production` Environment，限制部署分支为 `web`。
3. 添加全部 Variables 和三个 Secrets。
4. **先不要设置** `DEPLOY_ENABLED=true`，或显式设为 `false`。
5. 打开 **Actions → Deploy to Cloudflare Workers → Run workflow**，选择 `web` 分支运行。
6. 检查：
   - `verify-build` 全部通过；
   - deploy job 的 Summary 写明 `Cloudflare deployment skipped`；
   - 没有 Cloudflare API 调用。
7. 确认配置无误后，把 `DEPLOY_ENABLED` 设为 `true`。
8. 再次手动运行并选择 `web`，观察最终部署步骤。
9. 首次成功后，push `web` 会自动走同一流程；需要暂停时把 `DEPLOY_ENABLED` 改回 `false`。

`workflow_dispatch` 没有自定义 ref 输入；如果手动运行选择了非 `web` 分支，两个 job 都会因 guard 跳过。

## 5. 生产配置如何生成

`scripts/prepare-cloudflare-deploy.mjs` 读取模板 `wrangler.jsonc`，输出仓库根目录的临时 `wrangler.production.generated.json`，以保留相对 `main: src/index.ts` 与 `assets: ./frontend/dist` 路径。它只覆盖/注入以下内容：

- `account_id`：来自 `CLOUDFLARE_ACCOUNT_ID`；
- `routes`：`[{ pattern: <PUBLIC_URL hostname>, custom_domain: true }]`；
- `vars.PUBLIC_URL`：规范化的 https origin；
- `vars.CLOUDFLARE_ACCOUNT_ID`：运行期账户 ID；
- One 非秘密变量：`ACCESS_TEAM_DOMAIN`、四个 AUD、Agent/Enroll app/policy ID、可选 `ACCESS_API_CLIENT_ID`。

同时保留：

- `main`、`name`、`compatibility_date`；
- `assets`；
- `durable_objects` 与 `migrations`（SQLite Durable Object）；
- `workers_dev: false`、`preview_urls: false`；
- 模板中已有的软预算 `USAGE_*` vars。

不会写入：

- `CF_DEPLOY_API_TOKEN`；
- 任何 Workers binding secret；
- 测试专用的 `ACCESS_JWKS` / `CLOUDFLARE_API_BASE`；
- 个人 account_id 或真实域名到仓库文件。

脚本会拒绝：缺少必填项、非 https / 带路径 / 带端口的 origin、非 32 hex 账户 ID、重复 AUD、非法 Team domain、非 canonical base64 或非 32 bytes 的 AES key。错误只显示变量名，不回显 secret 值。

最终部署命令只使用本地 Wrangler：

```bash
./node_modules/.bin/wrangler deploy \
  --config wrangler.production.generated.json \
  --secrets-file "$RUNNER_TEMP/worker-secrets.json"
```

Wrangler 4.154 已支持 `--secrets-file` 与部署同次上传；参考 <https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy>。该 flag 的 JSON 文件避免 dotenv 的 `$VAR`/`${VAR}` 展开风险。

## 6. 清理与安全检查

部署步骤：

```bash
set -euo pipefail
cleanup() {
  rm -f wrangler.production.generated.json "$RUNNER_TEMP/worker-secrets.json"
}
trap cleanup EXIT
```

job 末尾还有 `if: always()` 清理步骤。清理覆盖成功、失败和大多数取消路径。

其他约束：

- `actions/checkout` 使用 `persist-credentials: false`；
- workflow 权限仅 `contents: read`；
- 不使用第三方面板或远程脚本；
- verify/build 步骤不接触 production secrets；
- `npm ci` 与测试步骤没有 secret 环境变量；
- secrets 只在生成配置/部署步骤注入；
- 不把 deploy token 写入 Worker vars 或 secrets 文件；
- 不上传 `wrangler.production.generated.json` 或 secrets 文件为 artifact；
- 不新增 KV/R2/D1 权限或付费产品。

## 7. 故障排查

| 现象 | 处理 |
| --- | --- |
| deploy job 显示 skipped | 检查 production Environment 的 `DEPLOY_ENABLED` 是否严格为 `true`；未启用时这是正常行为 |
| 最终步骤报 `CF_DEPLOY_API_TOKEN is not set` | production Environment 缺少 `CF_DEPLOY_API_TOKEN` Secret；workflow 会在调用 Wrangler 前失败，不会回退到其他认证 |
| prepare 步骤报缺字段 | 按报错变量名补齐 Environment Variables；错误不会打印值 |
| `CREDENTIAL_ENCRYPTION_KEY` 报错 | 使用 `openssl rand -base64 32` 生成；不要加引号/换行/空白；必须解码为 32 bytes |
| 首次部署 403 / 无法创建 Worker | 部署 token 需要 Workers product-scope Admin；仅 Editor 只能更新已存在 Worker |
| Custom Domain 403 | 需要对应 zone 的 Zone → Workers Routes → Write；Custom Domain 不支持 per-Worker roles |
| 更新已有 Worker 403 | 需要该 Worker 的 Editor（product 或 per-Worker） |
| Worker 运行期 provision 失败 | 检查 `CF_ACCESS_MANAGEMENT_API_TOKEN` 是否有 Access Apps and Policies Edit 与 Access Service Tokens Edit，以及 app/policy ID/AUD 是否匹配 |
| 域名/路由错误 | 检查 `PUBLIC_URL` 是否为 https origin、无路径/端口，且 hostname 属于目标 zone |
| artifact 缺失或哈希错误 | 确认 `verify-build` 成功、artifact 名称为 `frontend-dist`，并重新运行同一 commit 的 workflow |
| 怀疑 secret 泄漏 | 立即轮换对应 Cloudflare/GitHub secret；workflow 不打印 secrets，但不要额外把 secrets 写进日志或 PR |

## 8. 仍未验证（UNKNOWN）

- 真实 Cloudflare 部署、Access 实际行为、撤销传播；
- Workers Free 额度、是否处于 Paid 套餐、计费；
- Durable Object 长期 Hibernation / WebSocket 唤醒；
- 真实 systemd Agent 安装；
- 真实 Custom Domain / DNS 绑定与首次创建权限组合。

不要把本地 Node 测试、dry-run 或本文档当作真实部署成功证据。
