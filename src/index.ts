// mAICenter channel plugin for OpenClaw
// Polls mAICenter web dashboard messages and dispatches to agent via gateway pipeline

import { createMaicenterPolling, sendReply } from './channel.js';

function listMaicenterAccountIds(cfg: any): string[] {
  if (cfg?.channels?.maicenter?.agentKey) return ['default'];
  return [];
}

function resolveMaicenterAccount(cfg: any, accountId?: string | null) {
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

const maicenterPlugin: any = {
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
    listAccountIds: (cfg: any) => listMaicenterAccountIds(cfg),
    resolveAccount: (cfg: any, accountId?: string | null) => resolveMaicenterAccount(cfg, accountId),
    isConfigured: (account: any) => account.configured,
    describeAccount: (account: any) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  outbound: {
    deliveryMode: 'direct',
    textChunkLimit: 4000,
    sendText: async (ctx: any) => {
      const account = resolveMaicenterAccount(ctx.cfg, ctx.accountId || 'default');
      if (!account.agentKey) throw new Error('maicenter: no agentKey configured');
      const result = await sendReply(account.agentKey, ctx.to, ctx.text);
      return { channel: 'maicenter', messageId: result.id || 'sent' };
    },
  },
  status: {
    defaultRuntime: { accountId: '', lastError: null, lastInboundAt: null, lastOutboundAt: null },
    collectStatusIssues: () => [],
    buildChannelSummary: ({ snapshot }: any) => ({
      configured: snapshot?.configured ?? false,
      lastError: snapshot?.lastError ?? null,
      lastInboundAt: snapshot?.lastInboundAt ?? null,
      lastOutboundAt: snapshot?.lastOutboundAt ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }: any) => ({
      ...runtime,
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  gateway: {
    startAccount: async (ctx: any) => {
      const account = ctx.account || {};
      if (!account.configured || !account.agentKey) {
        ctx.log?.error?.('[maicenter] not configured — run: openclaw config set channels.maicenter.agentKey <key>');
        throw new Error('maicenter not configured: missing agentKey');
      }

      ctx.log?.info?.(`[${account.accountId}] starting maicenter channel polling`);
      ctx.setStatus?.({ accountId: account.accountId, running: true, lastStartAt: Date.now(), lastEventAt: Date.now() });

      const stop = createMaicenterPolling(ctx, account.agentKey, {
        pollInterval: (account.pollInterval || 30) * 1000,
        activePollInterval: (account.activePollInterval || 3) * 1000,
      });

      return new Promise<void>((resolve) => {
        if (ctx.abortSignal) {
          ctx.abortSignal.addEventListener('abort', () => {
            stop();
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
  actions: {},
  directory: {},
  execApprovals: {},
};

export default {
  id: 'maicenter',
  name: 'mAICenter',
  description: 'mAICenter channel — chat with your agents from maicenter.org',
  configSchema: maicenterPlugin.configSchema,
  register(api: any) {
    api.registerChannel({ plugin: maicenterPlugin });
  },
};

export { maicenterPlugin };
