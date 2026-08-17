# openclaw-dsh-bridge · DSH 三通道 IM 桥

让 **微信 / 飞书 / QQ** 里的消息直接驱动一个运行在 DeepSeek Harness（DSH）里的真实 agent：
有工作区文件、能跑命令、跨轮记忆、工具完整——不是只接了个聊天 API 的假机器人。

三通道共用同一套「通道适配器 + DSH 会话映射 + 白名单 + 去重/限流」机制
（v0.7.0 起，见 [SPEC.md](SPEC.md)）。

## 通道总览

| 通道 | 形态 | 连接方式 | 状态 |
| --- | --- | --- | --- |
| 微信 | 官方 ClawBot / iLink（长轮询） | 设置页扫码绑定 | ✅ |
| 飞书 | 企业自建应用 + 事件订阅长连接（WebSocket） | 填 AppID/AppSecret/EncryptKey 后连接 | ✅ |
| QQ | 开放平台机器人（WebSocket 网关） | 填 AppID/Token，缺省沙箱环境 | ✅ |

三条通道均走**官方接口**，仓库内不含任何逆向协议/hook 代码；不需要公网 IP、
端口映射或内网穿透（微信/飞书是出站长连接，QQ 是网关长连接）。

## 架构

```
微信 iLink 云 ──┐
飞书长连接云 ──┼──► 本插件（DSH webServer 内 Cordis 插件）
QQ 开放平台网关 ─┘          │  agents.create + agent.followup + session 事件流
                           ▼
                 DSH Agent 会话（每会话 / 每群一个，独立工作区）
                           │
               回复自动发回原 IM（分段 ≤1500 字符，总量 ≤4000）
```

同时保留 v0.6 的 OpenAI 兼容端点（`POST /openclaw-bridge/v1/chat/completions`），
任何自定义 baseURL 的客户端仍可接入，行为不变。

## 特性

- **三通道统一 IM 桥**：微信 / 飞书 / QQ 各自成卡（设置 → IM 桥接），
  每通道独立开关、独立白名单、独立状态；`GET /openclaw-bridge/channels` 返回注册表。
- **会话映射**：私聊每用户一会话；群聊每群一会话（成员@机器人触发、回复进群、
  发言带 `[群友 用户名]` 署名，可用 `groupSignature=0` 关闭）。
- **会话续接（v0.7.2 起）**：IM 会话 id 持久化到 `~/.dsh/openclaw-bridge/session-map.json`，
  插件/DSH 重启后同一用户/群的消息自动接回原上下文（`/new` 可开全新会话）。
- **历史去重**：网关/长连接每轮回放完整消息，插件按 `channel:eventId` 去重，
  只注入新增消息；入站限流 20 条/用户/分钟防刷。
- **隔离**：每个会话独立工作目录 `~/.dsh/openclaw-bridge/workspace/<key>`。
- **安全**：控制路由默认仅 127.0.0.1；跨主机访问必须携带 Bearer token（常数时间比较）；
  `authAlways=1` 可开启「回环也要求 Token」严格模式；凭据字段不回显；
  日志落盘 `~/.dsh/openclaw-bridge/logs/<channel>.log`（1MB 轮转）。
- **本地二维码（v0.7.2 起）**：设置页扫码登录的二维码由本机渲染
  （`GET /openclaw-bridge/qr?text=...` 返回 SVG），不再依赖第三方 QR 服务。
- **向后兼容**：旧 `allowlist` 自动迁移为 `whitelistWechat`；旧微信控制路由
  `/openclaw-bridge/wechat/*` 保留为别名；OpenAI 兼容端点零变化。

## 快速开始

### 1. 安装插件到 DSH Desktop

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

脚本会：
1. 把插件复制进 `DSH Desktop/resources/app/assets/plugins/dsh-openclaw-bridge/`；
2. 同步到 `~/.dsh/profiles/web/node_modules/@deepseek-ai/`；
3. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加启用条目；
4. 给 `dsh-host-apiproxy` 的设置命名空间白名单打补丁（加入 `openclaw-bridge`，
   否则设置页的 IM 桥接栏读不到配置）。

> ⚠️ **装配方式（v0.7.2 部署教训）**：本插件是**普通 Cordis 插件**
> （`dsh.client.inject` + `apply(ctx)`），**不是 profile bundle**——请**不要**把它写进
> `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`。bundle 层要求包声明
> `dsh.bundle.patch`，缺了 DSH 启动会报 `declares no dsh.bundle ... in its package.json`
> 并 exit 1。正确装配 = 依赖 `link:` + `cordis.patch.yml` 的 `insert` 条目
> （install.ps1 第 3 步就是这条路径），重启后由 include 层加载，与其他普通插件一致。

> 注意：第 4 步改的是 DSH 核心包（MIT 许可），DSH Desktop 更新后可能被覆盖，
> 重新跑一遍 install.ps1 即可恢复。

### 2. 设置页「IM 桥接」

重启 DSH Desktop 后，打开 **设置 → IM 桥接**，三张通道卡各自配置：

通用区（沿用原 ClawBot 栏）：

- **接收模型**：形如 `provider/model`（如 `deepseek-official/deepseek-v4-pro`），
  留空 = 使用 DSH 默认模型；保存后立即生效（新会话使用新模型）；
- **桥接 Token**：非回环访问时要求的 Bearer token；
- **工作目录**：所有通道共享的 agent 工作目录（绝对路径）；
- **自定义模型端点**（OpenAI 兼容）：`baseURL` + `API Key` + `模型名`，
  填了 baseURL 则接收模型改走该端点（完整能力保留，见 `lib/openai-compat.js`）。
- **群友署名**：群聊回复是否给发言者署名（默认开，`groupSignature=0` 关）。

#### 微信（iLink）

1. 微信卡点 **连接** —— 出现二维码（微信官方小程序 `liteapp.weixin.qq.com`）；
2. 微信里启用官方 ClawBot 插件扫码确认绑定；若要求配对码，填回卡片提交；
3. 状态 **已连接** 后直接给 Bot 发消息即可。

#### 飞书（企业自建应用）

1. 飞书开放平台创建企业自建应用，开启机器人能力；
2. 订阅事件 `im.message.receive_v1`（事件订阅模式选**长连接**，免公网回调地址）；
3. 卡片填入 **App ID / App Secret / Encrypt Key**（Encrypt Key 可留空 = 不加密），
   点 **保存**，再点 **连接**；卡片「连接测试」可先校验凭据；
4. 私聊机器人直接发消息；群聊需把机器人拉进群、@它触发。

#### QQ（开放平台机器人）

1. QQ 开放平台（q.qq.com）创建机器人，拿到 **AppID / 机器人 Token**；
2. 卡片填入凭据，`沙箱环境` 默认开启 —— 沙箱内仅测试频道/成员可见；
3. 点 **连接**，状态 **已连接** 后在测试频道 @机器人 或私聊它；
4. 功能验证通过后在开放平台提交 **发布审核**，审核通过后关闭沙箱
   （`qqSandbox=0` 切生产环境）。

### 3. 三条通道共用的指令

对任意通道的机器人发送（私聊或群@）：

- `/help` —— 查看指令
- `/list` —— 列出可接管的会话（live + 已持久化）
- `/attach <会话id>` —— 接管该 DSH 会话（与 DSH 界面同一会话、同一记忆）
- `/new` —— 开新会话（丢弃当前绑定）

### 4. 白名单（强烈建议）

每个通道卡都有独立白名单（如微信 `xxx@im.wechat`、飞书 `ou_xxx`、QQ `openid`，
用 `/list` 或通道日志可看到自己的 id）。白名单外的消息被静默忽略——
IM 驱动的是你 PC 上真实的 agent（完整文件/命令能力），务必只放行自己。

## 平台硬约束（官方条款）

- **微信**：会话每 24 小时过期需重新扫码；用户发消息后 24h 内最多主动发 10 条
  （含回复）—— 适合应答式助手，不适合主动轰炸。
- **飞书**：企业自建应用，消息权限按应用审核分配（`im:message`、p2p / group_at）；
  长连接模式心跳由平台协商。
- **QQ**：被动回复有 2 分钟窗口（携带 `msg_id`）；沙箱→发布审核制；
  主动消息频控数值以开放平台开发者文档为准（实现侧只做被动回复，不占用主动额度）。
- 本插件**只做被动回复**：收到消息 → agent 一轮 → 回复发出，不发起主动消息。

## 协议端点

`POST /openclaw-bridge/v1/chat/completions`（OpenAI chat completions 子集，
`model` = 会话 key，`messages` 只取 `role:user`，`stream` 支持 SSE）——
与 v0.6 完全一致，OpenClaw 等网关配置见 [docs/openclaw-config.md](docs/openclaw-config.md)。

控制路由（均 loopback-only）：

| 路由 | 说明 |
| --- | --- |
| `GET /openclaw-bridge/channels` | 渠道注册表（implemented/enabled/status） |
| `POST /openclaw-bridge/channels/<id>/login` | 连接通道（wechat/feishu/qq） |
| `POST /openclaw-bridge/channels/<id>/verify` | 提交配对码（仅微信） |
| `POST /openclaw-bridge/channels/<id>/logout` | 断开通道 |
| `GET /openclaw-bridge/wechat/status` 等 | 旧微信别名路由（保留） |

## 安全模型

- 回环地址请求免 token；非回环必须带 `Authorization: Bearer <token>` 或
  `x-openclaw-bridge-token`；token 来源：环境变量 `OPENCLAW_BRIDGE_TOKEN`，
  未设置时首次启动自动生成到 `~/.dsh/openclaw-bridge/token.txt`；
- 入站去重（`channel:eventId`，LRU 5 万）+ 入站限流（20 条/用户/分钟）；
- 凭据（飞书 AppSecret/EncryptKey、QQ Token）保存时不回显；
- 回复整编：单段 ≤1500 字符、总量 ≤4000，超长截断并提示；
- 桥接后的 agent 拥有 DSH 全部工具能力（文件、命令、网络）——
  默认隔离工作区，谨慎决定谁能与机器人对话。

## 合规说明

- 三通道均为**官方接口**：微信 ClawBot/iLink、飞书开放平台（企业自建应用）、
  QQ 开放平台机器人；仓库不含任何逆向协议/hook 代码；
- QQ 属开放平台审核制：沙箱阶段仅测试成员可见；发布需遵循平台审核与内容规范；
- 插件本体 MIT 许可证；依赖的 DSH 核心包（`@deepseek-ai/*`）均为 MIT；
- 与腾讯、字节（飞书）、DeepSeek 均无隶属关系；
- 使用者自行承担账号风险与数据处理义务；对外托管需自行满足
  《个人信息保护法》等要求；本项目不提供法律建议。

## 调研报告

- [docs/wechat-clawbot-doc-note.md](docs/wechat-clawbot-doc-note.md) —— 微信 Clawbot 平台接口核对
- [docs/feishu-bot-dsh-report.md](docs/feishu-bot-dsh-report.md) —— 飞书长连接协议（对照官方 SDK）
- [docs/qq-bot-dsh-report.md](docs/qq-bot-dsh-report.md) —— QQ 开放平台协议（对照官方 botgo SDK）

## 更新与卸载

**更新**：拉取新版本后重跑 `install.ps1` 并重启 DSH Desktop。注意两类"副本失效"：

- DSH Desktop 更新会整体替换 `resources/app`，清掉 apiproxy 白名单补丁与
  assets/plugins 副本；
- `~/.dsh/profiles/web` 是 npm 托管的 profile，未声明的插件目录可能被 npm 修剪。

两者都只需重跑 `install.ps1`（幂等）即可恢复。

**卸载**：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

脚本会回滚四处安装产物，并默认删除桥接数据（token/通道会话凭据/工作区，
加 `-KeepData` 保留），之后重启 DSH Desktop 即完全移除。

## 测试

```powershell
# 单元测试（137 项断言：协议 11 + 微信 21 + 自定义端点 11 + 共享层 15 +
# 注册表/迁移 + ws 6 + 飞书 20 + QQ 24；mock DSH 核心服务 + mock 三朵云 +
# mock 网关长连接，全部本地端口）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test.ps1

# 集成测试：克隆 DSH home、起一个真实的 dsh web 实例（独立端口），
# 跑通 插件 -> agent -> 真实模型 全链路（含流式）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\integration-test.ps1
```

`install.ps1` 参数：`-Target`（DSH Desktop 的 resources\app 目录，留空自动探测）、
`-DshHome`（DSH home 覆盖，默认 `~/.dsh`）、`-SkipDesktop`。

## 开发

```bash
node --check lib/index.js          # 语法检查（无构建步骤）
node --check lib/channels/qq.js    # 各通道同理
```

插件是纯 ESM、零构建；运行时只依赖 node 内置模块与 DSH 核心包
（peerDependencies 声明，随 DSH 提供）。架构与决策见 [SPEC.md](SPEC.md)。

## 许可证

[MIT](LICENSE)