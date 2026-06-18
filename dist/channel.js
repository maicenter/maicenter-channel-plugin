// mAICenter channel plugin — polling + inbound dispatch
// Uses channelRuntime.reply pipeline (same as WeChat/Telegram plugins)
const API_BASE = 'https://api.maicenter.org';
const IDLE_INTERVAL = 30_000;
const ACTIVE_INTERVAL = 3_000;
const ACTIVE_TIMEOUT = 300_000;
// Local LAN ASR (svoic-asr-server on the DGX Spark). The plugin runs on a host
// inside the LAN (ProClaw / MiniClaw), so it reaches the ASR directly — unlike a
// Cloudflare Worker, which cannot route to 192.168.x / Tailscale. Overridable via
// plugin config (config.asrUrl / config.asrModel) so other hosts can repoint it.
const DEFAULT_ASR_URL = 'http://192.168.12.193:8084/v1/audio/transcriptions';
const DEFAULT_ASR_MODEL = 'paraformer-zh';
// Local LAN text-to-image (SANA 1.5 on the DGX Spark, port 8083). Same LAN-only
// reasoning as the ASR: the plugin runs inside the LAN and reaches it directly;
// the Cloudflare Worker cannot. Overridable via config.t2iUrl. We call SANA with
// return_base64 so we get the image bytes back over HTTP — the server writes the
// PNG to ITS OWN disk (the GPU host), which the plugin host (ProClaw) cannot read,
// so a file path is useless cross-host; base64 over HTTP is the portable channel.
const DEFAULT_T2I_URL = 'http://192.168.12.193:8083/generate';
async function apiGet(agentKey, path) {
    const resp = await fetch(`${API_BASE}${path}`, {
        headers: { 'Authorization': `Bearer agent:${agentKey}` },
    });
    return resp.json();
}
async function apiPost(agentKey, path, body) {
    const resp = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer agent:${agentKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return resp.json();
}
let msgCounter = 0;
function generateMessageSid() {
    return `mc_${Date.now()}_${++msgCounter}`;
}
// The text-to-image skill can't know the current channelId, hold the agent key,
// or reach R2 — and the SANA image server writes its PNG to the GPU host's own
// disk, which the plugin host (ProClaw) cannot read. So the skill cannot deliver
// an image itself. Instead it emits a machine-readable marker carrying just the
// PROMPT; the plugin (which owns the agent key + channelId via the deliver
// closure, and is on the LAN) calls SANA with return_base64, uploads the bytes to
// R2, and posts a real contentType:'image' message. The marker is then stripped
// from the text. Contract documented in the skill's SKILL.md.
//   [[MAICENTER_IMAGE_PROMPT: a watercolor crab wearing a hat]]
const IMAGE_PROMPT_MARKER_RE = /\[\[MAICENTER_IMAGE_PROMPT:([^\]]+)\]\]/g;
// Legacy/stray path-form marker the model sometimes emits ([[MAICENTER_IMAGE:/tmp/x.png]]).
// gemma-4-12b stubbornly keeps emitting this path form instead of the PROMPT
// form. The file lives on the GPU host, not here, so we can't deliver from it —
// but we MUST strip it so the raw marker never leaks into the chat, and we still
// want to produce an image. The basename (e.g. "t2i_fox_cartoon.png") is a crude,
// usually-English degradation of what the user actually asked for, so we DO NOT
// use it as the prompt when we have the user's real request available. Instead the
// deliver callback falls back to the user's original message text (see below);
// pathToPrompt is only a last-ditch fallback when even that is unavailable.
const IMAGE_PATH_MARKER_RE = /\[\[MAICENTER_IMAGE:([^\]]+)\]\]/g;
function pathToPrompt(p) {
    const base = (p.split('/').pop() || p).replace(/\.[a-z0-9]+$/i, '');
    return base.replace(/^t2i[_-]?/i, '').replace(/[_-]+/g, ' ').trim();
}
// Result of scanning a reply for image markers. `prompts` are explicit, trusted
// prompts from the PROMPT-form marker. `pathMarkers` are legacy path-form markers
// that carried no real prompt — for these the deliver callback decides the prompt
// (user's original message first, basename-derived only as last resort).
function extractImagePrompts(text) {
    const prompts = [];
    const pathMarkers = [];
    let m;
    IMAGE_PROMPT_MARKER_RE.lastIndex = 0;
    while ((m = IMAGE_PROMPT_MARKER_RE.exec(text)) !== null) {
        const p = m[1].trim();
        if (p)
            prompts.push(p);
    }
    // Legacy path-form markers: collect them so we still generate an image and
    // always strip the raw marker, but defer prompt selection to the caller.
    IMAGE_PATH_MARKER_RE.lastIndex = 0;
    while ((m = IMAGE_PATH_MARKER_RE.exec(text)) !== null) {
        pathMarkers.push(m[1].trim());
    }
    const cleaned = text
        .replace(IMAGE_PROMPT_MARKER_RE, '')
        .replace(IMAGE_PATH_MARKER_RE, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return { cleaned, prompts, pathMarkers };
}
// Pick the prompt for a legacy path-form marker. Priority:
//   1. user's original message text this turn (what they actually asked for) —
//      passed unmodified to SANA, which handles Chinese + instruction words fine;
//   2. basename-derived prompt as a last-ditch fallback (crude English, used only
//      when we somehow have no user text, e.g. an agent-initiated turn).
function promptForPathMarker(pathArg, userText) {
    const ut = (userText || '').trim();
    if (ut)
        return ut;
    return pathToPrompt(pathArg);
}
// Generate an image on the LAN SANA server (base64 over HTTP), upload it to R2 via
// the agent attachment endpoint, and post a contentType:'image' message into the
// channel. Best-effort: logs and returns false on any failure so a flaky image
// hop never crashes the reply path.
async function generateUploadAndSendImage(agentKey, channelId, prompt, t2iUrl) {
    try {
        // 1. Generate on SANA. Ask for base64 in the response — the PNG file SANA
        //    writes lives on the GPU host, not here, so we can't read it by path.
        const gen = await fetch(t2iUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt,
                width: 1024,
                height: 1024,
                steps: 20,
                guidance: 4.5,
                return_base64: true,
            }),
        });
        if (!gen.ok) {
            console.error(`[maicenter] t2i generate failed ${gen.status} for prompt: ${prompt.slice(0, 60)}`);
            return false;
        }
        const gj = await gen.json().catch(() => null);
        const b64 = (gj && (gj.image_base64 || gj.base64)) || '';
        if (!b64) {
            console.error('[maicenter] t2i returned no image_base64');
            return false;
        }
        // 2. Upload bytes to R2, get a channel-scoped key.
        const upResp = await fetch(`${API_BASE}/agent/channels/${channelId}/attachments`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer agent:${agentKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_base64: b64, mimeType: 'image/png', ext: 'png' }),
        });
        if (!upResp.ok) {
            const t = await upResp.text().catch(() => '');
            console.error(`[maicenter] image upload failed ${upResp.status}: ${t}`);
            return false;
        }
        const up = await upResp.json().catch(() => null);
        const key = up?.key;
        if (!key) {
            console.error('[maicenter] image upload returned no key');
            return false;
        }
        // 3. Post the image message (renderer keys off contentType:'image' +
        //    metadata.key; content is a short caption fallback).
        await apiPost(agentKey, `/agent/channels/${channelId}/messages`, {
            content: prompt.slice(0, 120),
            contentType: 'image',
            metadata: { key, mimeType: up.mimeType || 'image/png', size: up.size, prompt: prompt.slice(0, 200) },
        });
        return true;
    }
    catch (e) {
        console.error('[maicenter] generateUploadAndSendImage error:', e?.message || e);
        return false;
    }
}
// Download an audio attachment (agent-authenticated) by R2 key and transcribe it
// on the local LAN ASR with the given model. Returns the transcript text, or ''
// on any failure (callers fall back so a flaky ASR never drops the message).
async function transcribeAudioByKey(agentKey, channelId, key, filenameHint, mimeHint, asrUrl, asrModel) {
    if (!key)
        return '';
    try {
        // 1. Fetch the audio bytes via the agent attachment endpoint (LAN/edge OK —
        //    this is a normal HTTPS call to api.maicenter.org, not the ASR).
        const dlPath = `/agent/channels/${channelId}/attachments/${encodeURIComponent(key)}`;
        const dl = await fetch(`${API_BASE}${dlPath}`, {
            headers: { 'Authorization': `Bearer agent:${agentKey}` },
        });
        if (!dl.ok) {
            console.error(`[maicenter] audio download failed ${dl.status} for ${key}`);
            return '';
        }
        const bytes = new Uint8Array(await dl.arrayBuffer());
        const mimeType = mimeHint || dl.headers.get('Content-Type') || 'audio/webm';
        const filename = (filenameHint && filenameHint.trim()) || 'voice';
        // 2. POST to the local ASR (OpenAI-compatible multipart). This is the only
        //    LAN-only hop — works because the plugin runs inside the LAN.
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: mimeType }), filename);
        form.append('model', asrModel);
        form.append('response_format', 'json');
        const asr = await fetch(asrUrl, { method: 'POST', body: form });
        if (!asr.ok) {
            console.error(`[maicenter] ASR error ${asr.status} for ${key} (model ${asrModel})`);
            return '';
        }
        const ct = asr.headers.get('Content-Type') || '';
        let text = '';
        if (ct.includes('application/json')) {
            const data = await asr.json().catch(() => null);
            text = (data && typeof data.text === 'string') ? data.text : '';
        }
        else {
            text = (await asr.text()).trim();
        }
        return text.trim();
    }
    catch (e) {
        console.error('[maicenter] transcribe error:', e?.message || e);
        return '';
    }
}
// Convenience wrapper for the auto-transcribe path (default model, message obj).
async function transcribeAudioMessage(agentKey, msg, asrUrl, asrModel) {
    const key = msg.metadata?.key;
    if (!key)
        return '';
    return transcribeAudioByKey(agentKey, msg.channelId, key, msg.content, msg.metadata?.mimeType, asrUrl, asrModel);
}
// Write a transcript back to the server so every human in the channel can read
// it. The server merges it into metadata.transcripts[model] and clears the
// model from the pending queue. Best-effort: logs on failure, never throws.
async function writeTranscriptBack(agentKey, channelId, messageId, model, text) {
    try {
        const resp = await fetch(`${API_BASE}/agent/channels/${channelId}/messages/${messageId}/transcript`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer agent:${agentKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, text }),
        });
        if (!resp.ok) {
            const t = await resp.text().catch(() => '');
            console.error(`[maicenter] transcript writeback failed ${resp.status} for ${messageId} (${model}): ${t}`);
        }
    }
    catch (e) {
        console.error('[maicenter] transcript writeback error:', e?.message || e);
    }
}
export function createMaicenterPolling(ctx, agentKey, config) {
    let lastPollTime = new Date().toISOString().replace('T', ' ').replace('Z', '').split('.')[0];
    let currentInterval = config.pollInterval || IDLE_INTERVAL;
    let lastMessageTime = 0;
    let timer = null;
    let myAgentId = null;
    const channelUsers = {};
    const cr = ctx.channelRuntime;
    const accountId = ctx.accountId || 'default';
    const asrUrl = config.asrUrl || DEFAULT_ASR_URL;
    const asrModel = config.asrModel || DEFAULT_ASR_MODEL;
    const t2iUrl = config.t2iUrl || DEFAULT_T2I_URL;
    // Resolve our own agent id once so we can spot mentions targeted at us
    // (and apply the user's preferredModel for our dispatch).
    apiGet(agentKey, '/agent/profile').then((p) => {
        if (p?.id)
            myAgentId = p.id;
    }).catch(() => { });
    // --- Transcription capability gate (AUTHORITATIVE) ---
    // We only transcribe voice messages if THIS agent has a `voice`-type model
    // service registered on mAICenter (e.g. Pro虾's "普通话语音识别 (ASR)"). An
    // agent without an ASR service must never transcribe — no download, no LAN ASR
    // call, no write-back. We query the public /models endpoint filtered to our own
    // owner+type and cache the result, refreshing periodically so a newly-added (or
    // removed) service is picked up without a restart. We do NOT query per message.
    //
    // NOTE on visibility: the plugin authenticates with an `agent:` token, which the
    // /models endpoint does not treat as the owner (owner-detection uses user auth).
    // So we see only status='active' voice services here — exactly the right gate:
    // an unlisted/paused service shouldn't enable transcription either. Pro虾's ASR
    // is active, so it is visible.
    let hasVoiceModel = null; // null = not resolved yet
    const VOICE_CAP_REFRESH_MS = 10 * 60 * 1000;
    async function refreshVoiceCapability() {
        if (!myAgentId) {
            // Agent id not resolved yet — try to resolve it first so the gate works
            // even if the profile call above is still in flight.
            try {
                const p = await apiGet(agentKey, '/agent/profile');
                if (p?.id)
                    myAgentId = p.id;
            }
            catch { /* keep hasVoiceModel as-is; retried next refresh */ }
        }
        if (!myAgentId)
            return;
        try {
            const data = await apiGet(agentKey, `/models?owner=${encodeURIComponent(myAgentId)}&type=voice`);
            const list = Array.isArray(data?.models) ? data.models : [];
            // Defensive: also enforce type==='voice' in JS in case the API ever ignores
            // the filter, and require the service to be active (shared).
            const has = list.some((m) => m && m.type === 'voice' && (m.status === 'active' || m.shared === true));
            hasVoiceModel = has;
        }
        catch (e) {
            // On a query failure, do NOT flip a previously-known value. If we've never
            // resolved it, leave it null (transcription stays off until we know).
            console.error('[maicenter] voice-capability check failed:', e?.message || e);
        }
    }
    // Resolve capability promptly at startup, then refresh on a slow timer.
    refreshVoiceCapability();
    const voiceCapTimer = setInterval(refreshVoiceCapability, VOICE_CAP_REFRESH_MS);
    if (typeof voiceCapTimer.unref === 'function')
        voiceCapTimer.unref();
    // Per-channel buffer of silently-delivered messages — group/friend chat that
    // wasn't @-addressed to us. We flush this buffer as a context preamble in
    // front of the next addressed message so the LLM sees "刚才" naturally.
    // Bounded so a burst of group chatter doesn't grow unboundedly.
    const SILENT_BUFFER_MAX = 80;
    const silentBuffer = {};
    function pushSilent(channelId, who, msg) {
        const buf = silentBuffer[channelId] || (silentBuffer[channelId] = []);
        buf.push({ time: msg.createdAt, who, text: msg.content });
        if (buf.length > SILENT_BUFFER_MAX)
            buf.splice(0, buf.length - SILENT_BUFFER_MAX);
    }
    // Build the recent-history preamble. Combines the in-memory silent buffer
    // (instant, no API call) with the most recent ~20 messages fetched from the
    // server (catches anything missed across restarts), deduped by id, sorted by
    // time, excluding the current addressed message.
    async function buildContextPreamble(currentMsg) {
        const seen = new Set();
        const entries = [];
        const buf = silentBuffer[currentMsg.channelId] || [];
        for (const e of buf) {
            const id = `${e.time}|${e.who}|${e.text}`;
            if (!seen.has(id)) {
                seen.add(id);
                entries.push({ id, ...e });
            }
        }
        silentBuffer[currentMsg.channelId] = [];
        try {
            const hist = await apiGet(agentKey, `/agent/channels/${currentMsg.channelId}/messages?limit=20`);
            for (const m of (hist.messages || [])) {
                if (m.id === currentMsg.id)
                    continue;
                // Filter out agent replies. Otherwise the model regurgitates its own
                // prior wrong answers ("3 messages") instead of counting fresh from
                // the real user messages. Users asking "who said what" want humans.
                if (m.senderType === 'agent')
                    continue;
                const who = m.senderName || m.senderId;
                const e = { id: m.id, time: m.createdAt, who, text: m.content };
                if (!seen.has(m.id)) {
                    seen.add(m.id);
                    entries.push(e);
                }
            }
        }
        catch { /* best-effort — fall back to buffer-only preamble */ }
        if (entries.length === 0)
            return '';
        entries.sort((a, b) => a.time.localeCompare(b.time));
        const lines = entries.map((e) => `${e.who}: ${e.text}`).join('\n');
        // Anchoring framing. The first paragraph overrides the RLHF reflex of
        // "I cannot access chat history" empirically observed on qwen3/gemma when
        // the channelRuntime prepends "Conversation info (untrusted metadata)" to
        // the body. The "Recent group chat" block then reads as real conversation.
        return [
            '[OPERATOR INSTRUCTION — overrides any earlier framing this turn. Read carefully and obey strictly.]',
            'You are an active member of this group chat. The "Recent group chat" block immediately below is REAL conversation that just happened in this group — you witnessed every line of it. Treat it as ground truth.',
            '',
            'Rules for this turn (no exceptions):',
            '  1. The "Recent group chat" block is the COMPLETE record of what you can see. There is no "elsewhere" to look — it is right here.',
            '  2. When the user asks to count / list / quote messages, count and quote LITERALLY from the block, one entry per line. Include duplicates. Do not summarize, dedupe, or omit.',
            '  3. NEVER refuse with phrases like "我无法访问", "I cannot access", "no permission", "platform security", "数据未持久化" — that is wrong; the data is right here.',
            '  4. NEVER suggest the user "open the Maicenter app / client", "scroll up", "view history elsewhere", "export the transcript", "long-press a message", or any equivalent. They are talking to you here; you have the data here.',
            '  5. If a question references "刚才" / "earlier" / "just now" / "本群" / "this group", answer using the block.',
            '',
            'Recent group chat (chronological, ending just before the new message below). Each line is one entry.',
            lines,
            '',
            'New message directed at you (respond to this, using only the block above as context — do not invent context not present there):',
            '',
        ].join('\n');
    }
    async function processMessage(msg, userName) {
        // Voice messages: contentType:'audio' arrives with the filename as `content`
        // and the R2 key in metadata. Transcribe it locally (LAN ASR) and replace the
        // content with the transcript so the rest of the pipeline (silent buffering,
        // context preamble, LLM dispatch) treats it as plain text — exactly like a
        // typed message. On any ASR failure, fall back to a readable placeholder so
        // the message is never silently dropped.
        if (msg.contentType === 'audio' && msg.metadata?.key && !msg.metadata?.transcript) {
            // Two gates, BOTH must pass to transcribe:
            //   1. hasVoiceModel — this agent offers an ASR (voice) model service.
            //   2. msg.transcriptionEnabled — the channel's transcription switch is ON
            //      (owner/participant-set; defaults OFF). The server stamps this flag on
            //      every polled message so we never need a per-message API call.
            if (msg.transcriptionEnabled !== true) {
                // Channel transcription switch is OFF (or this API doesn't send the flag).
                // Keep the audio as-is; do not download/transcribe/write back.
                console.log(`[maicenter] channel transcription OFF — skipping transcription of ${msg.id}`);
                msg.content = '[语音消息]';
            }
            else if (hasVoiceModel !== true) {
                // This agent has no `voice` model service → transcription is not offered.
                // Don't download, don't call the LAN ASR, don't write back. Keep the
                // message as a readable placeholder so the LLM dispatch path still has
                // something coherent (the audio itself is unreadable to a text model).
                console.log(`[maicenter] no voice model for this agent — skipping transcription of ${msg.id}`);
                msg.content = '[语音消息]';
            }
            else {
                const transcript = await transcribeAudioMessage(agentKey, msg, asrUrl, asrModel);
                if (transcript) {
                    msg.content = transcript;
                    if (msg.metadata)
                        msg.metadata.transcript = transcript;
                    // Write the default-model transcript back so every human in the channel
                    // can read it in the UI (not just this agent's LLM). Fire-and-forget;
                    // failures are logged inside writeTranscriptBack.
                    if (!msg.metadata?.transcripts?.[asrModel]) {
                        writeTranscriptBack(agentKey, msg.channelId, msg.id, asrModel, transcript);
                    }
                }
                else {
                    msg.content = '[语音消息无法转写]';
                }
            }
        }
        // Silent (non-addressed) message in a group/friend channel — buffer it as
        // context. Silent path: no LLM call, no session record (those would create
        // orphan turns). Buffer is best-effort; the addressed path below also
        // pulls the latest history from the server so a restart-cleared buffer
        // doesn't strand "刚才" references.
        if (msg.addressed === false) {
            pushSilent(msg.channelId, msg.senderName || userName, msg);
            return;
        }
        // Build the preamble: in-memory buffer (cheap) UNION recent history pulled
        // from the server (resilient to plugin restarts). We pull a bounded window
        // and dedupe by message id.
        const preamble = await buildContextPreamble(msg);
        // Build inbound context
        const msgCtx = {
            Body: preamble + msg.content,
            From: msg.channelId,
            To: msg.channelId,
            AccountId: accountId,
            OriginatingChannel: 'maicenter',
            OriginatingTo: msg.channelId,
            MessageSid: generateMessageSid(),
            Timestamp: msg.createdAt,
            Provider: 'maicenter',
            ChatType: 'direct',
        };
        // Resolve routing
        const route = cr.routing.resolveAgentRoute({
            cfg: ctx.cfg,
            chatId: msg.channelId,
            chatType: 'direct',
            accountId,
            channel: 'maicenter',
        });
        if (route?.sessionKey) {
            msgCtx.SessionKey = route.sessionKey;
        }
        // Resolve store path and finalize context
        const storePath = cr.session.resolveStorePath(ctx.cfg?.session?.store, {
            sessionKey: route?.sessionKey,
        });
        const finalized = cr.reply.finalizeInboundContext(msgCtx);
        // Record inbound session for this addressed turn.
        await cr.session.recordInboundSession({
            storePath,
            sessionKey: route?.sessionKey,
            ctx: finalized,
            channel: 'maicenter',
            accountId,
            chatType: 'direct',
            onRecordError: (err) => console.error('[maicenter] recordInboundSession error:', String(err)),
        });
        // Create dispatcher with deliver callback to send reply to mAICenter
        const channelId = msg.channelId;
        const { dispatcher, replyOptions, markDispatchIdle } = cr.reply.createReplyDispatcherWithTyping({
            deliver: async (payload) => {
                const text = payload?.text || '';
                // The text-to-image skill embeds [[MAICENTER_IMAGE_PROMPT: ...]] markers
                // carrying the prompt. For each, generate on the LAN SANA server, upload to
                // R2, and post a real contentType:'image' message; then send the remaining
                // text. If an image hop fails we keep the original text so the user still
                // gets a reply rather than silence.
                //
                // Prompt priority (see promptForPathMarker): explicit PROMPT markers win;
                // for legacy path-form markers (gemma keeps emitting these), we fall back
                // to the user's ORIGINAL message this turn rather than the crude
                // basename-derived English, so "森林里的卡通小狐狸" reaches SANA verbatim
                // instead of being degraded to "fox cartoon". msg.content is the clean
                // user text (preamble is only added to msgCtx.Body, never to msg.content).
                const { cleaned, prompts, pathMarkers } = extractImagePrompts(text);
                const effectivePrompts = [
                    ...prompts,
                    ...pathMarkers.map((pm) => promptForPathMarker(pm, msg.content)),
                ].filter((p) => p && p.trim());
                let anyImageSent = false;
                for (const p of effectivePrompts) {
                    const ok = await generateUploadAndSendImage(agentKey, channelId, p, t2iUrl);
                    anyImageSent = anyImageSent || ok;
                }
                // Always send the cleaned text when any marker was present, so a raw
                // marker NEVER leaks into the chat — even if image generation failed
                // (cleaned still carries whatever real prose the reply had around it).
                const hadMarker = prompts.length > 0 || pathMarkers.length > 0;
                const outText = hadMarker ? cleaned : text;
                if (outText.trim()) {
                    await apiPost(agentKey, `/agent/channels/${channelId}/messages`, { content: outText });
                }
            },
            onError: (err) => {
                console.error('[maicenter] reply delivery error:', String(err));
            },
        });
        // Per-turn model override: did the user pick a specific model for this
        // @-mention? If so, clone the cfg and rewrite agents.defaults.model.primary
        // so this dispatch runs against that model. Default behavior unchanged.
        let dispatchCfg = ctx.cfg;
        const ourMention = (msg.metadata?.mentions || []).find((m) => m.type === 'agent' && (myAgentId ? m.id === myAgentId : true) && m.preferredModel);
        if (ourMention?.preferredModel?.providerKey && ourMention?.preferredModel?.modelId) {
            const fq = `${ourMention.preferredModel.providerKey}/${ourMention.preferredModel.modelId}`;
            dispatchCfg = {
                ...ctx.cfg,
                agents: {
                    ...(ctx.cfg?.agents || {}),
                    defaults: {
                        ...(ctx.cfg?.agents?.defaults || {}),
                        model: {
                            ...((ctx.cfg?.agents?.defaults?.model) || {}),
                            primary: fq,
                            // No fallbacks for an explicit override — if the user picked it,
                            // we honor it or fail loudly rather than silently route elsewhere.
                            fallbacks: [],
                        },
                        models: {
                            ...((ctx.cfg?.agents?.defaults?.models) || {}),
                            [fq]: ((ctx.cfg?.agents?.defaults?.models || {})[fq]) || {},
                        },
                    },
                },
            };
        }
        // Dispatch: run LLM agent and deliver reply
        try {
            await cr.reply.withReplyDispatcher({
                dispatcher,
                run: () => cr.reply.dispatchReplyFromConfig({
                    ctx: finalized,
                    cfg: dispatchCfg,
                    dispatcher,
                    replyOptions: { ...replyOptions, disableBlockStreaming: false },
                }),
            });
        }
        catch (e) {
            console.error('[maicenter] dispatch error:', e?.message || e);
        }
        finally {
            markDispatchIdle?.();
        }
    }
    async function poll() {
        try {
            const data = await apiGet(agentKey, `/agent/channels/messages?since=${encodeURIComponent(lastPollTime)}`);
            if (data.error || !data.messages) {
                schedule();
                return;
            }
            for (const msg of data.messages) {
                if (msg.senderType === 'agent')
                    continue;
                if (!channelUsers[msg.channelId]) {
                    const channels = await apiGet(agentKey, '/agent/channels');
                    for (const ch of (channels.channels || [])) {
                        channelUsers[ch.id] = ch.userName || ch.userId || 'user';
                    }
                }
                try {
                    await processMessage(msg, channelUsers[msg.channelId] || msg.senderId);
                }
                catch (e) {
                    console.error('[maicenter] processMessage error:', e?.message || e);
                }
                lastMessageTime = Date.now();
                currentInterval = config.activePollInterval || ACTIVE_INTERVAL;
            }
            if (data.messages.length > 0) {
                lastPollTime = data.messages[data.messages.length - 1].createdAt;
            }
            if (currentInterval <= ACTIVE_INTERVAL && Date.now() - lastMessageTime > ACTIVE_TIMEOUT) {
                currentInterval = config.pollInterval || IDLE_INTERVAL;
            }
        }
        catch (e) {
            // Network error, retry later
        }
        schedule();
    }
    function schedule() {
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(poll, currentInterval);
        if (timer && typeof timer.unref === 'function')
            timer.unref();
    }
    // --- On-demand transcription queue ---
    // Humans can request an audio message be (re-)transcribed with a specific
    // model. The server records pending models in metadata.transcribeRequests;
    // we poll a dedicated endpoint, run each requested model on the LAN ASR, and
    // write the result back (which also clears the pending entry). Runs on its own
    // slower cadence so it never perturbs the main message loop.
    const QUEUE_INTERVAL = 8_000;
    let queueTimer = null;
    let queueBusy = false;
    async function pollTranscribeQueue() {
        if (queueBusy) {
            scheduleQueue();
            return;
        }
        // Gate: an agent without a voice model service never services the on-demand
        // transcription queue either. Skip the whole poll (no API hit beyond this
        // early return) until/unless this agent gains a voice model.
        if (hasVoiceModel !== true) {
            scheduleQueue();
            return;
        }
        queueBusy = true;
        try {
            const data = await apiGet(agentKey, '/agent/channels/transcribe-queue');
            const items = (data && Array.isArray(data.items)) ? data.items : [];
            for (const item of items) {
                const { channelId, messageId, key, mimeType, models } = item;
                if (!channelId || !messageId || !key || !Array.isArray(models))
                    continue;
                for (const model of models) {
                    const text = await transcribeAudioByKey(agentKey, channelId, key, 'voice', mimeType || undefined, asrUrl, model);
                    if (text) {
                        await writeTranscriptBack(agentKey, channelId, messageId, model, text);
                    }
                    else {
                        // Don't clear the pending entry on failure — surface it and let it
                        // retry on a later queue poll. Avoid hammering by logging once here.
                        console.error(`[maicenter] queue transcription empty for ${messageId} (${model})`);
                    }
                }
            }
        }
        catch (e) {
            console.error('[maicenter] transcribe-queue poll error:', e?.message || e);
        }
        finally {
            queueBusy = false;
            scheduleQueue();
        }
    }
    function scheduleQueue() {
        if (queueTimer)
            clearTimeout(queueTimer);
        queueTimer = setTimeout(pollTranscribeQueue, QUEUE_INTERVAL);
        if (queueTimer && typeof queueTimer.unref === 'function')
            queueTimer.unref();
    }
    function stop() {
        if (timer)
            clearTimeout(timer);
        if (queueTimer)
            clearTimeout(queueTimer);
        clearInterval(voiceCapTimer);
    }
    poll();
    pollTranscribeQueue();
    return stop;
}
export async function sendReply(agentKey, channelId, text) {
    return apiPost(agentKey, `/agent/channels/${channelId}/messages`, { content: text });
}
// Infer model capability (text / image / vision / video / voiceSynth /
// voiceRecog) from common cues in the modelId or display name. Best-effort —
// the owner can re-classify in the mAICenter UI later.
function inferCapability(modelId, name) {
    const h = `${modelId} ${name || ''}`.toLowerCase();
    if (/\b(qwen[-_]?image|flux|sdxl|stable[-_]?diffusion|wan(?!ku)|sana|hidream)\b/.test(h))
        return 'image';
    if (/\b(longlive|video|cogvideo|wanku|hunyuan[-_]?video)\b/.test(h))
        return 'video';
    if (/\b(-vl|_vl|vl-|vision|vlm|clip)\b/.test(h))
        return 'vision';
    if (/\b(tts|voicesynth|cosyvoice|f5[-_]?tts|fish[-_]?speech|edge[-_]?tts)\b/.test(h))
        return 'voiceSynth';
    if (/\b(asr|stt|whisper|paraformer|voicerecog)\b/.test(h))
        return 'voiceRecog';
    return 'text';
}
// Walk through cfg.models.providers, flatten into a list of model entries,
// and PUT to mAICenter. Replaces the full catalog for this agent each call.
// Idempotent — re-running preserves any `shared` flags the owner set in UI.
export async function reportModelCatalog(cfg, agentKey) {
    const providers = cfg?.models?.providers || {};
    const models = [];
    for (const [providerKey, prov] of Object.entries(providers)) {
        const list = Array.isArray(prov?.models) ? prov.models : [];
        for (const m of list) {
            const modelId = String(m?.id || m?.name || '').trim();
            if (!modelId)
                continue;
            const displayName = m?.name && String(m.name).trim() !== modelId ? String(m.name) : undefined;
            const capability = inferCapability(modelId, displayName);
            models.push({
                providerKey,
                modelId,
                displayName,
                capability,
                contextWindow: typeof m?.contextWindow === 'number' ? m.contextWindow : undefined,
                maxTokens: typeof m?.maxTokens === 'number' ? m.maxTokens : undefined,
            });
        }
    }
    try {
        const resp = await fetch(`${API_BASE}/agent/me/models`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer agent:${agentKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ models }),
        });
        if (!resp.ok)
            return { count: models.length, error: `${resp.status} ${resp.statusText}` };
        return { count: models.length };
    }
    catch (e) {
        return { count: models.length, error: e?.message || String(e) };
    }
}
