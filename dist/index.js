// mAICenter channel plugin for OpenClaw
// Polls mAICenter web dashboard messages and dispatches to agent via gateway pipeline
import { createMaicenterPolling, sendReply, reportModelCatalog } from './channel.js';
function listMaicenterAccountIds(cfg) {
    if (cfg?.channels?.maicenter?.agentKey)
        return ['default'];
    return [];
}
function resolveMaicenterAccount(cfg, accountId) {
    const mc = cfg?.channels?.maicenter || {};
    return {
        accountId: accountId || 'default',
        name: 'mAICenter',
        agentKey: mc.agentKey || '',
        pollInterval: mc.pollInterval || 30,
        activePollInterval: mc.activePollInterval || 3,
        configured: Boolean(mc.agentKey),
        enabled: Boolean(mc.agentKey),
    };
}
const maicenterPlugin = {
    id: 'maicenter',
    meta: {
        id: 'maicenter',
        label: 'mAICenter',
        selectionLabel: 'mAICenter (poll)',
        docsPath: '/channels/maicenter',
        docsLabel: 'maicenter',
        blurb: 'Chat with your agent from maicenter.org web dashboard.',
        order: 80,
    },
    configSchema: {
        schema: { type: 'object', additionalProperties: false, properties: {} },
    },
    capabilities: {
        chatTypes: ['direct'],
        media: false,
        blockStreaming: true,
    },
    streaming: {
        blockStreamingCoalesceDefaults: { minChars: 100, idleMs: 2000 },
    },
    messaging: {},
    reload: { configPrefixes: ['channels.maicenter'] },
    config: {
        listAccountIds: (cfg) => listMaicenterAccountIds(cfg),
        resolveAccount: (cfg, accountId) => resolveMaicenterAccount(cfg, accountId),
        isConfigured: (account) => account.configured,
        describeAccount: (account) => ({
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured: account.configured,
        }),
    },
    outbound: {
        deliveryMode: 'direct',
        textChunkLimit: 4000,
        sendText: async (ctx) => {
            const account = resolveMaicenterAccount(ctx.cfg, ctx.accountId || 'default');
            if (!account.agentKey)
                throw new Error('maicenter: no agentKey configured');
            const result = await sendReply(account.agentKey, ctx.to, ctx.text);
            return { channel: 'maicenter', messageId: result.id || 'sent' };
        },
    },
    status: {
        defaultRuntime: { accountId: '', lastError: null, lastInboundAt: null, lastOutboundAt: null },
        collectStatusIssues: () => [],
        buildChannelSummary: ({ snapshot }) => ({
            configured: snapshot?.configured ?? false,
            lastError: snapshot?.lastError ?? null,
            lastInboundAt: snapshot?.lastInboundAt ?? null,
            lastOutboundAt: snapshot?.lastOutboundAt ?? null,
        }),
        buildAccountSnapshot: ({ account, runtime }) => ({
            ...runtime,
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured: account.configured,
        }),
    },
    gateway: {
        startAccount: async (ctx) => {
            const account = ctx.account || {};
            if (!account.configured || !account.agentKey) {
                ctx.log?.error?.('[maicenter] not configured — run: openclaw config set channels.maicenter.agentKey <key>');
                throw new Error('maicenter not configured: missing agentKey');
            }
            ctx.log?.info?.(`[${account.accountId}] starting maicenter channel polling`);
            ctx.setStatus?.({ accountId: account.accountId, running: true, lastStartAt: Date.now(), lastEventAt: Date.now() });
            // Report the local model catalog so mAICenter can show it on the agent
            // profile page and let the owner share specific models. Fire-and-forget;
            // re-report every hour in case config changed.
            const reportNow = () => reportModelCatalog(ctx.cfg, account.agentKey).then((r) => {
                if (r.error)
                    ctx.log?.error?.(`[maicenter] model report error: ${r.error}`);
                else
                    ctx.log?.info?.(`[maicenter] reported ${r.count} models`);
            }).catch((e) => ctx.log?.error?.(`[maicenter] model report failed: ${e?.message || e}`));
            reportNow();
            const reportTimer = setInterval(reportNow, 60 * 60 * 1000);
            if (typeof reportTimer.unref === 'function')
                reportTimer.unref();
            const stop = createMaicenterPolling(ctx, account.agentKey, {
                pollInterval: (account.pollInterval || 30) * 1000,
                activePollInterval: (account.activePollInterval || 3) * 1000,
            });
            return new Promise((resolve) => {
                if (ctx.abortSignal) {
                    ctx.abortSignal.addEventListener('abort', () => {
                        stop();
                        clearInterval(reportTimer);
                        ctx.setStatus?.({ accountId: account.accountId, running: false });
                        resolve();
                    });
                }
            });
        },
    },
    lifecycle: {},
    security: {},
    pairing: {},
    threading: {},
    allowlist: {},
    bindings: {},
    groups: {},
    actions: {
        // Returns null = "no special tool schema for messages on this channel".
        // Required to be a function — OpenClaw's describeMessageToolSafely calls it.
        describeMessageTool: () => null,
    },
    directory: {},
    execApprovals: {},
};
export default {
    id: 'maicenter',
    name: 'mAICenter',
    description: 'mAICenter channel — chat with your agents from maicenter.org',
    configSchema: maicenterPlugin.configSchema,
    register(api) {
        api.registerChannel({ plugin: maicenterPlugin });
    },
};
export { maicenterPlugin };
