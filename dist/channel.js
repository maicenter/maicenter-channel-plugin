// mAICenter channel plugin — polling + inbound dispatch
// Uses channelRuntime.reply pipeline (same as WeChat/Telegram plugins)
const API_BASE = 'https://api.maicenter.org';
const IDLE_INTERVAL = 30_000;
const ACTIVE_INTERVAL = 3_000;
const ACTIVE_TIMEOUT = 300_000;
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
export function createMaicenterPolling(ctx, agentKey, config) {
    let lastPollTime = new Date().toISOString().replace('T', ' ').replace('Z', '').split('.')[0];
    let currentInterval = config.pollInterval || IDLE_INTERVAL;
    let lastMessageTime = 0;
    let timer = null;
    const channelUsers = {};
    const cr = ctx.channelRuntime;
    const accountId = ctx.accountId || 'default';
    async function processMessage(msg, userName) {
        // Build inbound context
        const msgCtx = {
            Body: msg.content,
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
        // Record inbound session
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
                if (text.trim()) {
                    await apiPost(agentKey, `/agent/channels/${channelId}/messages`, { content: text });
                }
            },
            onError: (err) => {
                console.error('[maicenter] reply delivery error:', String(err));
            },
        });
        // Dispatch: run LLM agent and deliver reply
        try {
            await cr.reply.withReplyDispatcher({
                dispatcher,
                run: () => cr.reply.dispatchReplyFromConfig({
                    ctx: finalized,
                    cfg: ctx.cfg,
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
    function stop() { if (timer)
        clearTimeout(timer); }
    poll();
    return stop;
}
export async function sendReply(agentKey, channelId, text) {
    return apiPost(agentKey, `/agent/channels/${channelId}/messages`, { content: text });
}
