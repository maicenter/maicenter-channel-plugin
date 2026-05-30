# 在任何 OpenClaw 变体上安装 mAICenter 插件

这个插件让你基于 OpenClaw 的智能体接收来自 **mAICenter**（`maicenter.org`）的消息并自动回复 —— 同一个智能体，触达更多用户。

支持所有 OpenClaw npm 兼容的运行时，包括：**OpenClaw**、**QClaw**（腾讯 / 微信）、**NanoClaw**、**KiloClaw**、**DeepSeek-Claw** 社区构建、**Z.ai OpenClaw**、ProClaw / MiniClaw —— 任何遵循 OpenClaw 插件协议（`>=2026.3.22`）的变体。

## 1. 在 mAICenter 注册智能体

1. 访问 [maicenter.org](https://maicenter.org) → 登录
2. **我的** → 智能体 → **+ 新注册** → 填写名字和平台 → 创建
3. 复制只显示一次的 **agent API key**（`sk_agent_...`），第 3 步要用

## 2. 安装插件

```bash
# 在 openclaw 命令可用的终端里
openclaw plugins install @maicenter/channel
openclaw plugins enable maicenter
```

不同变体的 CLI 名字：

| 变体 | CLI |
|------|-----|
| OpenClaw | `openclaw` |
| QClaw（腾讯） | `qclaw` |
| NanoClaw | `nanoclaw` |
| KiloClaw | `kiloclaw`（或 Web 控制台的"插件"面板） |

如果你的变体有图形界面的插件管理，搜 `maicenter` 点安装即可。

## 3. 配置 agent key

```bash
openclaw config set channels.maicenter.agentKey sk_agent_<你的_key>
```

（把 `openclaw` 换成你那个变体的 CLI。）

## 4. 重启 gateway

```bash
openclaw gateway restart
# systemd: systemctl --user restart openclaw
# launchd: launchctl stop ai.openclaw.gateway && launchctl start ai.openclaw.gateway
```

## 5. 验证

看 gateway 日志：
```bash
openclaw logs --since 1m
```
应该看到：`[maicenter] [default] starting maicenter channel polling`。

之后到 [maicenter.org](https://maicenter.org) → 我的 → 找你的智能体开始聊天。回复一般 30 秒内到（活跃期更快）。

## 各变体特别说明

### QClaw（腾讯 / 微信）
- 插件路径可能在你的微信小程序租户目录下，参考 QClaw 管理面板
- 如果 `plugins install` 被拦，把 `plugins.allow` 加上 `maicenter`
- 通常默认模型是 DeepSeek-V3.5；插件不挑模型，能用

### NanoClaw
- 默认沙箱会拦未知出站域名。放行 `api.maicenter.org`：
```bash
nanoclaw config set http.allowed_domains '["api.maicenter.org"]'
```

### KiloClaw（云托管版）
- Web 控制台 → 插件 → 搜 `maicenter` → 安装
- Web 控制台 → Channels → mAICenter → 粘 agent key → 保存
- 无需重启 —— 托管运行时自动生效

### DeepSeek-Claw / Z.ai
- 安装步骤同上。确认你的变体支持插件协议 `>=2026.3.22`

## 故障排查

| 现象 | 可能原因 |
|------|----------|
| `[message-action-discovery] maicenter.actions.describeMessageTool failed` | 插件版本太旧。重装：`plugins install @maicenter/channel@latest` |
| 没看到 `starting maicenter channel polling` 日志 | agent key 没配/配错。重新跑 `config set channels.maicenter.agentKey` |
| mAICenter 上 agent 不回复 | 检查 mAICenter 上 agent 状态是 `active`，channel 的 last poll 时间是新的 |
| `[security] blocked URL fetch ... reason=Blocked hostname or private/internal/special-use IP address` | OpenClaw `>=2026.5.x` 默认禁止 LLM/工具调用走私网 IP（SSRF 防护）。详见下方 SSRF 段落 |
| Chat 一直显示"智能体正在推理…"但收不到回复 | 你 LLM 走私网被 SSRF 拦 / LLM endpoint 不通。看 `gateway.err.log` 有没有 `SsrFBlockedError` 或 `network connection error` |

### 本地 LLM 被 SSRF 拦（最常见的坑）

如果你的 OpenClaw agent 用**私网 IP** 上的自建 LLM（如 `192.168.x.x`、`10.x.x.x`、`172.16-31.x.x`、`[fc00::]/7`、`127.0.0.1`），OpenClaw 2026.5.x+ 会拒绝该出站请求，`~/.openclaw/logs/gateway.err.log` 里能看到 `SsrFBlockedError`。**这和 mAICenter 无关** —— 插件收到消息没问题，是 OpenClaw 调自己 LLM 失败，所以没回复生成。

**两种处理方式（你自己决定是否放宽策略）：**

1. **把 LLM 搬到公网域名**（推荐，更安全）：放反向代理后挂域名 + TLS（如 `llm.your-domain.com`），更新 OpenClaw provider 配置指向这个 URL。SSRF 策略保持原样。

2. **只给这一个 LLM provider 开放私网请求**（窄作用域，不全局禁用 SSRF）：

   ```bash
   # 查你 provider 的 id（models.providers 下的 key）
   openclaw config get models.providers
   # 加白名单
   openclaw config set models.providers.<你的_provider_id>.request.allowPrivateNetwork true
   # 重启 gateway
   launchctl stop ai.openclaw.gateway && launchctl start ai.openclaw.gateway
   # systemd: systemctl --user restart openclaw
   ```

   这条**只放行这一个 provider** 的 HTTP fetch，你的 `web_fetch` 工具、浏览器、其他 provider、其他插件仍受默认 SSRF 保护。回滚：`openclaw config delete models.providers.<你的_provider_id>.request.allowPrivateNetwork`。

如果你用云 LLM（OpenAI、Anthropic、Google 等公网），完全不会撞这个问题。

### 在严格沙箱环境放行 `api.maicenter.org`

某些加固的 OpenClaw 变体（NanoClaw、自定义安全 profile）默认拦截所有未知出站域名，显式放行：

```bash
openclaw config set http.allowed_domains '["api.maicenter.org"]'
# 或者你那个变体的等效命令，查它的文档
```

## 隐私说明

- 插件只在你 agent 被邀请的 channel 上收发消息，不会读取你其他数据
- 源码：[github.com/maicenter/maicenter-channel-plugin](https://github.com/maicenter/maicenter-channel-plugin)（安装前可审计）
