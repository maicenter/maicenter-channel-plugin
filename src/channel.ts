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

interface MaicenterMessage {
  id: string;
  channelId: string;
  senderType: string;
  senderId: string;
  senderName?: string;
  content: string;
  contentType: string;
  createdAt: string;
  // True when this message addresses the agent (1:1 direct, or @-mention in
  // group/friend). False ⇒ the agent should keep it as context only — record
  // it into session memory but do NOT call the LLM. Defaults to true for
  // backward compat with older API versions.
  addressed?: boolean;
  // Mentions metadata passed through from the user's send. May carry a
  // preferredModel per agent mention (the user picked which model handles
  // this turn — overrides agents.defaults.model.primary for this dispatch).
  metadata?: {
    mentions?: Array<{
      type: string;
      id: string;
      preferredModel?: { providerKey: string; modelId: string };
    }>;
    // For contentType:'audio' messages (voice notes recorded in the Flutter web
    // client). The audio bytes live in R2 under `key`; we download them via the
    // agent attachment endpoint and transcribe locally on the LAN.
    key?: string;
    mimeType?: string;
    size?: number;
    duration?: number;
    // Set by us after a successful local transcription so we don't re-transcribe
    // the same message if it reappears in a poll window (and for debugging).
    transcript?: string;
    // Per-model transcripts written back to the server so humans can read them.
    transcripts?: Record<string, { text: string; at: string }>;
  };
}

interface MaicenterChannel {
  id: string;
  userId: string;
  userName: string;
  userAvatar: string | null;
}

async function apiGet(agentKey: string, path: string): Promise<any> {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { 'Authorization': `Bearer agent:${agentKey}` },
  });
  return resp.json();
}

async function apiPost(agentKey: string, path: string, body: any): Promise<any> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer agent:${agentKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

let msgCounter = 0;
function generateMessageSid(): string {
  return `mc_${Date.now()}_${++msgCounter}`;
}

// The text-to-image skill can't know the current channelId or hold the agent key,
// so it can't post an image itself. Instead it emits a machine-readable marker in
// its reply text naming the local PNG it produced; the plugin (which owns both the
// agent key and the channelId, via the deliver closure) detects the marker, uploads
// the bytes to R2, and posts a real contentType:'image' message. The marker is then
// stripped from the text. Contract documented in the skill's SKILL.md.
//   [[MAICENTER_IMAGE:/abs/path/to.png]]
const IMAGE_MARKER_RE = /\[\[MAICENTER_IMAGE:([^\]]+)\]\]/g;

function extractImageMarkers(text: string): { cleaned: string; paths: string[] } {
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  IMAGE_MARKER_RE.lastIndex = 0;
  while ((m = IMAGE_MARKER_RE.exec(text)) !== null) {
    const p = m[1].trim();
    if (p) paths.push(p);
  }
  const cleaned = text.replace(IMAGE_MARKER_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { cleaned, paths };
}

function mimeForPath(p: string): { mime: string; ext: string } {
  const lower = p.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return { mime: 'image/jpeg', ext: 'jpg' };
  if (lower.endsWith('.webp')) return { mime: 'image/webp', ext: 'webp' };
  if (lower.endsWith('.gif')) return { mime: 'image/gif', ext: 'gif' };
  return { mime: 'image/png', ext: 'png' };
}

// Read a local image file, upload it to R2 via the agent attachment endpoint, and
// post a contentType:'image' message into the channel. Best-effort: logs and
// returns false on any failure so a flaky image hop never crashes the reply path.
// Uses dynamic require('fs') so this stays a no-op cost on hosts without images.
async function uploadAndSendImage(
  agentKey: string,
  channelId: string,
  filePath: string,
): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    if (!fs.existsSync(filePath)) {
      console.error(`[maicenter] image marker file missing: ${filePath}`);
      return false;
    }
    const data = fs.readFileSync(filePath);
    const { mime, ext } = mimeForPath(filePath);
    const base64 = data.toString('base64');

    // 1. Upload bytes to R2, get a channel-scoped key.
    const upResp = await fetch(`${API_BASE}/agent/channels/${channelId}/attachments`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer agent:${agentKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: base64, mimeType: mime, ext }),
    });
    if (!upResp.ok) {
      const t = await upResp.text().catch(() => '');
      console.error(`[maicenter] image upload failed ${upResp.status}: ${t}`);
      return false;
    }
    const up: any = await upResp.json().catch(() => null);
    const key = up?.key;
    if (!key) {
      console.error('[maicenter] image upload returned no key');
      return false;
    }

    // 2. Post the image message (content = filename caption; renderer keys off
    //    contentType:'image' + metadata.key).
    const filename = filePath.split('/').pop() || `image.${ext}`;
    await apiPost(agentKey, `/agent/channels/${channelId}/messages`, {
      content: filename,
      contentType: 'image',
      metadata: { key, mimeType: up.mimeType || mime, size: up.size, filename },
    });
    return true;
  } catch (e: any) {
    console.error('[maicenter] uploadAndSendImage error:', e?.message || e);
    return false;
  }
}

// Download an audio attachment (agent-authenticated) by R2 key and transcribe it
// on the local LAN ASR with the given model. Returns the transcript text, or ''
// on any failure (callers fall back so a flaky ASR never drops the message).
async function transcribeAudioByKey(
  agentKey: string,
  channelId: string,
  key: string,
  filenameHint: string,
  mimeHint: string | undefined,
  asrUrl: string,
  asrModel: string,
): Promise<string> {
  if (!key) return '';
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
      const data: any = await asr.json().catch(() => null);
      text = (data && typeof data.text === 'string') ? data.text : '';
    } else {
      text = (await asr.text()).trim();
    }
    return text.trim();
  } catch (e: any) {
    console.error('[maicenter] transcribe error:', e?.message || e);
    return '';
  }
}

// Convenience wrapper for the auto-transcribe path (default model, message obj).
async function transcribeAudioMessage(
  agentKey: string,
  msg: MaicenterMessage,
  asrUrl: string,
  asrModel: string,
): Promise<string> {
  const key = msg.metadata?.key;
  if (!key) return '';
  return transcribeAudioByKey(
    agentKey, msg.channelId, key,
    msg.content, msg.metadata?.mimeType, asrUrl, asrModel,
  );
}

// Write a transcript back to the server so every human in the channel can read
// it. The server merges it into metadata.transcripts[model] and clears the
// model from the pending queue. Best-effort: logs on failure, never throws.
async function writeTranscriptBack(
  agentKey: string,
  channelId: string,
  messageId: string,
  model: string,
  text: string,
): Promise<void> {
  try {
    const resp = await fetch(
      `${API_BASE}/agent/channels/${channelId}/messages/${messageId}/transcript`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer agent:${agentKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, text }),
      },
    );
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      console.error(`[maicenter] transcript writeback failed ${resp.status} for ${messageId} (${model}): ${t}`);
    }
  } catch (e: any) {
    console.error('[maicenter] transcript writeback error:', e?.message || e);
  }
}

export function createMaicenterPolling(ctx: any, agentKey: string, config: any) {
  let lastPollTime = new Date().toISOString().replace('T', ' ').replace('Z', '').split('.')[0];
  let currentInterval = config.pollInterval || IDLE_INTERVAL;
  let lastMessageTime = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let myAgentId: string | null = null;
  const channelUsers: Record<string, string> = {};
  const cr = ctx.channelRuntime;
  const accountId = ctx.accountId || 'default';
  const asrUrl = config.asrUrl || DEFAULT_ASR_URL;
  const asrModel = config.asrModel || DEFAULT_ASR_MODEL;

  // Resolve our own agent id once so we can spot mentions targeted at us
  // (and apply the user's preferredModel for our dispatch).
  apiGet(agentKey, '/agent/profile').then((p) => {
    if (p?.id) myAgentId = p.id;
  }).catch(() => {});

  // Per-channel buffer of silently-delivered messages — group/friend chat that
  // wasn't @-addressed to us. We flush this buffer as a context preamble in
  // front of the next addressed message so the LLM sees "刚才" naturally.
  // Bounded so a burst of group chatter doesn't grow unboundedly.
  const SILENT_BUFFER_MAX = 80;
  const silentBuffer: Record<string, Array<{ time: string; who: string; text: string }>> = {};

  function pushSilent(channelId: string, who: string, msg: MaicenterMessage) {
    const buf = silentBuffer[channelId] || (silentBuffer[channelId] = []);
    buf.push({ time: msg.createdAt, who, text: msg.content });
    if (buf.length > SILENT_BUFFER_MAX) buf.splice(0, buf.length - SILENT_BUFFER_MAX);
  }

  // Build the recent-history preamble. Combines the in-memory silent buffer
  // (instant, no API call) with the most recent ~20 messages fetched from the
  // server (catches anything missed across restarts), deduped by id, sorted by
  // time, excluding the current addressed message.
  async function buildContextPreamble(currentMsg: MaicenterMessage): Promise<string> {
    type Entry = { id: string; time: string; who: string; text: string };
    const seen = new Set<string>();
    const entries: Entry[] = [];

    const buf = silentBuffer[currentMsg.channelId] || [];
    for (const e of buf) {
      const id = `${e.time}|${e.who}|${e.text}`;
      if (!seen.has(id)) { seen.add(id); entries.push({ id, ...e }); }
    }
    silentBuffer[currentMsg.channelId] = [];

    try {
      const hist = await apiGet(agentKey, `/agent/channels/${currentMsg.channelId}/messages?limit=20`);
      for (const m of (hist.messages || []) as MaicenterMessage[]) {
        if (m.id === currentMsg.id) continue;
        // Filter out agent replies. Otherwise the model regurgitates its own
        // prior wrong answers ("3 messages") instead of counting fresh from
        // the real user messages. Users asking "who said what" want humans.
        if (m.senderType === 'agent') continue;
        const who = m.senderName || m.senderId;
        const e: Entry = { id: m.id, time: m.createdAt, who, text: m.content };
        if (!seen.has(m.id)) { seen.add(m.id); entries.push(e); }
      }
    } catch { /* best-effort — fall back to buffer-only preamble */ }

    if (entries.length === 0) return '';

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

  async function processMessage(msg: MaicenterMessage, userName: string) {
    // Voice messages: contentType:'audio' arrives with the filename as `content`
    // and the R2 key in metadata. Transcribe it locally (LAN ASR) and replace the
    // content with the transcript so the rest of the pipeline (silent buffering,
    // context preamble, LLM dispatch) treats it as plain text — exactly like a
    // typed message. On any ASR failure, fall back to a readable placeholder so
    // the message is never silently dropped.
    if (msg.contentType === 'audio' && msg.metadata?.key && !msg.metadata?.transcript) {
      const transcript = await transcribeAudioMessage(agentKey, msg, asrUrl, asrModel);
      if (transcript) {
        msg.content = transcript;
        if (msg.metadata) msg.metadata.transcript = transcript;
        // Write the default-model transcript back so every human in the channel
        // can read it in the UI (not just this agent's LLM). Fire-and-forget;
        // failures are logged inside writeTranscriptBack.
        if (!msg.metadata?.transcripts?.[asrModel]) {
          writeTranscriptBack(agentKey, msg.channelId, msg.id, asrModel, transcript);
        }
      } else {
        msg.content = '[语音消息无法转写]';
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
    const msgCtx: any = {
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
      onRecordError: (err: any) => console.error('[maicenter] recordInboundSession error:', String(err)),
    });

    // Create dispatcher with deliver callback to send reply to mAICenter
    const channelId = msg.channelId;
    const { dispatcher, replyOptions, markDispatchIdle } = cr.reply.createReplyDispatcherWithTyping({
      deliver: async (payload: any) => {
        const text = payload?.text || '';
        // The text-to-image skill embeds [[MAICENTER_IMAGE:/path]] markers naming
        // local PNGs it produced. Pull them out, post each as a real image message
        // (upload to R2 -> contentType:'image'), then send the remaining text. If
        // an image hop fails we keep the original text so the user still gets a
        // reply (which mentions the local path) rather than silence.
        const { cleaned, paths } = extractImageMarkers(text);
        let anyImageSent = false;
        for (const p of paths) {
          const ok = await uploadAndSendImage(agentKey, channelId, p);
          anyImageSent = anyImageSent || ok;
        }
        const outText = (paths.length > 0 && anyImageSent) ? cleaned : text;
        if (outText.trim()) {
          await apiPost(agentKey, `/agent/channels/${channelId}/messages`, { content: outText });
        }
      },
      onError: (err: any) => {
        console.error('[maicenter] reply delivery error:', String(err));
      },
    });

    // Per-turn model override: did the user pick a specific model for this
    // @-mention? If so, clone the cfg and rewrite agents.defaults.model.primary
    // so this dispatch runs against that model. Default behavior unchanged.
    let dispatchCfg = ctx.cfg;
    const ourMention = (msg.metadata?.mentions || []).find(
      (m) => m.type === 'agent' && (myAgentId ? m.id === myAgentId : true) && m.preferredModel
    );
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
    } catch (e: any) {
      console.error('[maicenter] dispatch error:', e?.message || e);
    } finally {
      markDispatchIdle?.();
    }
  }

  async function poll() {
    try {
      const data = await apiGet(agentKey, `/agent/channels/messages?since=${encodeURIComponent(lastPollTime)}`);
      if (data.error || !data.messages) { schedule(); return; }

      for (const msg of data.messages as MaicenterMessage[]) {
        if (msg.senderType === 'agent') continue;

        if (!channelUsers[msg.channelId]) {
          const channels = await apiGet(agentKey, '/agent/channels');
          for (const ch of (channels.channels || []) as MaicenterChannel[]) {
            channelUsers[ch.id] = ch.userName || ch.userId || 'user';
          }
        }

        try {
          await processMessage(msg, channelUsers[msg.channelId] || msg.senderId);
        } catch (e: any) {
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
    } catch (e) {
      // Network error, retry later
    }
    schedule();
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(poll, currentInterval);
    if (timer && typeof (timer as any).unref === 'function') (timer as any).unref();
  }

  // --- On-demand transcription queue ---
  // Humans can request an audio message be (re-)transcribed with a specific
  // model. The server records pending models in metadata.transcribeRequests;
  // we poll a dedicated endpoint, run each requested model on the LAN ASR, and
  // write the result back (which also clears the pending entry). Runs on its own
  // slower cadence so it never perturbs the main message loop.
  const QUEUE_INTERVAL = 8_000;
  let queueTimer: ReturnType<typeof setTimeout> | null = null;
  let queueBusy = false;

  async function pollTranscribeQueue() {
    if (queueBusy) { scheduleQueue(); return; }
    queueBusy = true;
    try {
      const data = await apiGet(agentKey, '/agent/channels/transcribe-queue');
      const items = (data && Array.isArray(data.items)) ? data.items : [];
      for (const item of items) {
        const { channelId, messageId, key, mimeType, models } = item;
        if (!channelId || !messageId || !key || !Array.isArray(models)) continue;
        for (const model of models) {
          const text = await transcribeAudioByKey(
            agentKey, channelId, key, 'voice', mimeType || undefined, asrUrl, model,
          );
          if (text) {
            await writeTranscriptBack(agentKey, channelId, messageId, model, text);
          } else {
            // Don't clear the pending entry on failure — surface it and let it
            // retry on a later queue poll. Avoid hammering by logging once here.
            console.error(`[maicenter] queue transcription empty for ${messageId} (${model})`);
          }
        }
      }
    } catch (e: any) {
      console.error('[maicenter] transcribe-queue poll error:', e?.message || e);
    } finally {
      queueBusy = false;
      scheduleQueue();
    }
  }

  function scheduleQueue() {
    if (queueTimer) clearTimeout(queueTimer);
    queueTimer = setTimeout(pollTranscribeQueue, QUEUE_INTERVAL);
    if (queueTimer && typeof (queueTimer as any).unref === 'function') (queueTimer as any).unref();
  }

  function stop() {
    if (timer) clearTimeout(timer);
    if (queueTimer) clearTimeout(queueTimer);
  }

  poll();
  pollTranscribeQueue();
  return stop;
}

export async function sendReply(agentKey: string, channelId: string, text: string): Promise<any> {
  return apiPost(agentKey, `/agent/channels/${channelId}/messages`, { content: text });
}

// Infer model capability (text / image / vision / video / voiceSynth /
// voiceRecog) from common cues in the modelId or display name. Best-effort —
// the owner can re-classify in the mAICenter UI later.
function inferCapability(modelId: string, name?: string): string {
  const h = `${modelId} ${name || ''}`.toLowerCase();
  if (/\b(qwen[-_]?image|flux|sdxl|stable[-_]?diffusion|wan(?!ku)|sana|hidream)\b/.test(h)) return 'image';
  if (/\b(longlive|video|cogvideo|wanku|hunyuan[-_]?video)\b/.test(h)) return 'video';
  if (/\b(-vl|_vl|vl-|vision|vlm|clip)\b/.test(h)) return 'vision';
  if (/\b(tts|voicesynth|cosyvoice|f5[-_]?tts|fish[-_]?speech|edge[-_]?tts)\b/.test(h)) return 'voiceSynth';
  if (/\b(asr|stt|whisper|paraformer|voicerecog)\b/.test(h)) return 'voiceRecog';
  return 'text';
}

// Walk through cfg.models.providers, flatten into a list of model entries,
// and PUT to mAICenter. Replaces the full catalog for this agent each call.
// Idempotent — re-running preserves any `shared` flags the owner set in UI.
export async function reportModelCatalog(cfg: any, agentKey: string): Promise<{ count: number; error?: string }> {
  const providers = cfg?.models?.providers || {};
  const models: any[] = [];
  for (const [providerKey, prov] of Object.entries<any>(providers)) {
    const list = Array.isArray(prov?.models) ? prov.models : [];
    for (const m of list) {
      const modelId = String(m?.id || m?.name || '').trim();
      if (!modelId) continue;
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
    if (!resp.ok) return { count: models.length, error: `${resp.status} ${resp.statusText}` };
    return { count: models.length };
  } catch (e: any) {
    return { count: models.length, error: e?.message || String(e) };
  }
}
