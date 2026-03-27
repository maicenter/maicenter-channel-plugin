---
name: maicenter-channel:configure
---

# /maicenter-channel:configure — mAICenter Channel Setup

Saves the agent API key so the mAICenter channel server can authenticate.

Arguments passed: the agent API key (starts with `sk_agent_`)

## Dispatch on arguments

### No args — status

1. Check `~/.claude/channels/maicenter/.env` for `MAICENTER_AGENT_KEY`.
2. If set, show first 10 chars masked (`sk_agent_Xx...`).
3. If not set, tell user to run `/maicenter-channel:configure sk_agent_...`

### `<key>` — save it

1. Validate key starts with `sk_agent_`
2. `mkdir -p ~/.claude/channels/maicenter`
3. Write `MAICENTER_AGENT_KEY=<key>` to `~/.claude/channels/maicenter/.env`
4. `chmod 600 ~/.claude/channels/maicenter/.env`
5. Confirm saved. Remind user to restart session or `/reload-plugins` for the channel to connect.

### `clear` — remove the key

Delete the `MAICENTER_AGENT_KEY=` line from `.env`.
