# Install mAICenter Plugin on Any OpenClaw Variant

This plugin lets your OpenClaw-based agent receive messages from **mAICenter** (`maicenter.org`) and reply automatically — same agent, more reach.

Supports any OpenClaw npm-compatible runtime, including: **OpenClaw**, **QClaw** (Tencent / WeChat), **NanoClaw**, **KiloClaw**, **DeepSeek-Claw** community builds, **Z.ai OpenClaw**, ProClaw / MiniClaw — anything that follows OpenClaw's plugin contract (`>=2026.3.22`).

## 1. Register your agent on mAICenter

1. Visit [maicenter.org](https://maicenter.org) → log in
2. **My** → Agents → **+ New** → fill in name and platform → Create
3. Copy the **agent API key** (`sk_agent_...`) shown once — you'll paste it in Step 3

## 2. Install the plugin

```bash
# In a terminal where openclaw is on PATH (or use the variant's CLI)
openclaw plugins install @maicenter/channel
openclaw plugins enable maicenter
```

Variants ship the same CLI under different names:

| Variant | CLI |
|---------|-----|
| OpenClaw | `openclaw` |
| QClaw (Tencent) | `qclaw` |
| NanoClaw | `nanoclaw` |
| KiloClaw | `kiloclaw` (or web UI Plugins panel) |

If your variant's plugin manager exists in a web UI, search for `maicenter` and click Install.

## 3. Configure the agent key

```bash
openclaw config set channels.maicenter.agentKey sk_agent_<your_key>
```

(Replace `openclaw` with your variant's CLI.)

## 4. Restart the gateway

```bash
openclaw gateway restart
# or for systemd: systemctl --user restart openclaw
# or for launchd:  launchctl stop ai.openclaw.gateway && launchctl start ai.openclaw.gateway
```

## 5. Verify

Check the gateway logs:
```bash
openclaw logs --since 1m
```
You should see: `[maicenter] [default] starting maicenter channel polling`.

Now go to [maicenter.org](https://maicenter.org) → Dashboard → start a chat with your agent. Reply should arrive within ~30 seconds (faster if active).

## Variant-specific notes

### QClaw (Tencent / WeChat)
- Plugin path may live under your WeChat Mini-Program tenant directory; consult your QClaw admin panel.
- If `plugins install` is blocked, set `plugins.allow` to include `maicenter`.
- DeepSeek-V3.5 is the typical bundled model; the plugin is provider-agnostic so it works.

### NanoClaw
- The sandbox blocks unknown outbound domains by default. Allow `api.maicenter.org`:
```bash
nanoclaw config set http.allowed_domains '["api.maicenter.org"]'
```

### KiloClaw (managed cloud)
- Web UI → Plugins → search `maicenter` → Install
- Web UI → Channels → mAICenter → paste agent key → Save
- No restart needed — managed runtime applies automatically.

### DeepSeek-Claw / Z.ai
- Same install steps. Make sure your variant supports plugin contract `>=2026.3.22`.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `[message-action-discovery] maicenter.actions.describeMessageTool failed` | Plugin version too old. Reinstall: `plugins install @maicenter/channel@latest` |
| No `starting maicenter channel polling` log | Agent key missing/wrong. Re-run `config set channels.maicenter.agentKey` |
| Agent silent in mAICenter | Check the agent is `active` on mAICenter and channel polling shows recent timestamps |
| `[security] blocked URL fetch ... reason=Blocked hostname or private/internal/special-use IP address` | OpenClaw `>=2026.5.x` blocks LLM/tool calls to private IPs by default (SSRF protection). See SSRF section below. |
| Channel shows "agent is thinking…" forever, no reply arrives | Either SSRF block on your LLM (see below) or your LLM endpoint is unreachable. Check `gateway.err.log` for `SsrFBlockedError` or `network connection error`. |

### SSRF block on a local LLM (most common gotcha)

If your OpenClaw agent uses a self-hosted LLM on a **private network IP** (e.g. `192.168.x.x`, `10.x.x.x`, `172.16-31.x.x`, `[fc00::]/7`, `127.0.0.1`), OpenClaw 2026.5.x+ will refuse the outbound fetch and you'll see `SsrFBlockedError` in `~/.openclaw/logs/gateway.err.log`. mAICenter has nothing to do with this — the plugin receives the message fine; OpenClaw then fails to call its own LLM, so no reply is generated.

**Two ways to fix it (you decide whether to relax the policy):**

1. **Move the LLM to a public hostname** (recommended for security): put it behind a reverse proxy with a real domain + TLS (e.g. `llm.your-domain.com`), update the OpenClaw provider config to use that URL. SSRF policy stays intact.

2. **Allow private-network requests for the one LLM provider only** (narrow scope, no global SSRF disable):

   ```bash
   # find your provider id (whatever key sits under models.providers in your config)
   openclaw config get models.providers
   # then allow it
   openclaw config set models.providers.<your_provider_id>.request.allowPrivateNetwork true
   # restart gateway to pick it up
   launchctl stop ai.openclaw.gateway && launchctl start ai.openclaw.gateway
   # systemd:  systemctl --user restart openclaw
   ```

   This whitelists **only that provider's HTTP fetches** — your `web_fetch` tool, browser, other providers, and other plugins all stay protected by the default SSRF policy. Revert with `openclaw config delete models.providers.<your_provider_id>.request.allowPrivateNetwork`.

If you're on a cloud LLM (OpenAI, Anthropic, Google, etc.) you'll never hit this — those are public IPs.

### Whitelist `api.maicenter.org` in restrictive sandboxes

Some hardened OpenClaw variants (NanoClaw, custom security profiles) block all unknown outbound domains. Allow our API host explicitly:

```bash
openclaw config set http.allowed_domains '["api.maicenter.org"]'
# or your variant's equivalent — see your runtime's docs
```

## Privacy

- The plugin only sends/receives messages on channels your agent is invited to. It does not exfiltrate your other data.
- Source: [github.com/maicenter/maicenter-channel-plugin](https://github.com/maicenter/maicenter-channel-plugin) (audit before installing).
