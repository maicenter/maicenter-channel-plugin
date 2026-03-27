#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// --- Config ---
const API_BASE = 'https://api.maicenter.org';
const STATE_DIR = join(homedir(), '.claude', 'channels', 'maicenter');
const ENV_FILE = join(STATE_DIR, '.env');

const IDLE_INTERVAL = 30_000;   // 30s when idle
const ACTIVE_INTERVAL = 3_000;  // 3s when active
const ACTIVE_TIMEOUT = 300_000; // 5 min → back to idle

// --- Read agent key ---
function getAgentKey(): string | null {
  // Env var takes precedence
  if (process.env.MAICENTER_AGENT_KEY) return process.env.MAICENTER_AGENT_KEY;

  // Read from state dir
  if (existsSync(ENV_FILE)) {
    const content = readFileSync(ENV_FILE, 'utf-8');
    const match = content.match(/^MAICENTER_AGENT_KEY=(.+)$/m);
    if (match) return match[1].trim();
  }
  return null;
}

const agentKey = getAgentKey();

// --- API helpers ---
async function apiGet(path: string): Promise<any> {
  if (!agentKey) return { error: 'No agent key configured' };
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { 'Authorization': `Bearer agent:${agentKey}` },
  });
  return resp.json();
}

async function apiPost(path: string, body: any): Promise<any> {
  if (!agentKey) return { error: 'No agent key configured' };
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer agent:${agentKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return resp.json();
}

// --- MCP Server ---
const mcp = new Server(
  { name: 'maicenter', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },
    },
    instructions: `The sender reads mAICenter web dashboard, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat.

Messages from mAICenter arrive as <channel source="maicenter" channel_id="..." message_id="..." user="..." user_id="..." ts="...">. Reply with the reply tool — pass channel_id back.

mAICenter is an AI agent platform at https://maicenter.org where human users can manage agents, chat with them, and view leaderboards.`,
  },
);

// --- Tools ---
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Reply to a mAICenter channel message. Pass channel_id from the inbound message.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel_id: { type: 'string', description: 'Channel ID from the inbound message' },
          text: { type: 'string', description: 'Reply text' },
        },
        required: ['channel_id', 'text'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'reply') {
    const { channel_id, text } = args as { channel_id: string; text: string };
    if (!channel_id || !text) {
      return { content: [{ type: 'text', text: 'Missing channel_id or text' }], isError: true };
    }

    const result = await apiPost(`/agent/channels/${channel_id}/messages`, { content: text });
    if (result.error) {
      return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
    }

    return { content: [{ type: 'text', text: `sent (id: ${result.id})` }] };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});

// --- Polling ---
let lastPollTime = new Date().toISOString();
let currentInterval = IDLE_INTERVAL;
let lastMessageTime = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

// Cache channel user names
const channelUsers: Record<string, string> = {};

async function poll() {
  try {
    const data = await apiGet(`/agent/channels/messages?since=${encodeURIComponent(lastPollTime)}`);

    if (data.error) {
      // Silently retry later
      schedulePoll();
      return;
    }

    const messages = data.messages || [];

    for (const msg of messages) {
      // Skip our own messages (agent replies)
      if (msg.senderType === 'agent') continue;

      // Resolve user name
      if (!channelUsers[msg.channelId]) {
        const channels = await apiGet('/agent/channels');
        for (const ch of (channels.channels || [])) {
          channelUsers[ch.id] = ch.userName || ch.userId || 'user';
        }
      }

      const userName = channelUsers[msg.channelId] || msg.senderId;

      // Deliver to LLM
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: msg.content,
          meta: {
            source: 'maicenter',
            channel_id: msg.channelId,
            message_id: msg.id,
            user: userName,
            user_id: msg.senderId,
            ts: msg.createdAt,
          },
        },
      });

      // Switch to active mode
      lastMessageTime = Date.now();
      currentInterval = ACTIVE_INTERVAL;
    }

    if (messages.length > 0) {
      // Update poll cursor to latest message time
      const latest = messages[messages.length - 1];
      lastPollTime = latest.createdAt;
    }

    // Check if we should go back to idle
    if (currentInterval === ACTIVE_INTERVAL && Date.now() - lastMessageTime > ACTIVE_TIMEOUT) {
      currentInterval = IDLE_INTERVAL;
    }
  } catch (e) {
    // Network error, retry later
  }

  schedulePoll();
}

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, currentInterval);
  pollTimer.unref(); // Don't prevent process exit
}

// --- Startup ---
if (!agentKey) {
  // Log to stderr (visible in daemon logs but not MCP)
  console.error('[maicenter] No MAICENTER_AGENT_KEY configured. Run /maicenter-channel:configure <key>');
  console.error(`[maicenter] Or write it to ${ENV_FILE}`);
} else {
  // Start polling
  console.error(`[maicenter] Starting channel polling (idle: ${IDLE_INTERVAL / 1000}s, active: ${ACTIVE_INTERVAL / 1000}s)`);
  poll();
}

// Ensure state dir exists
if (!existsSync(STATE_DIR)) {
  mkdirSync(STATE_DIR, { recursive: true });
}

// Connect MCP
const transport = new StdioServerTransport();
await mcp.connect(transport);

// Clean shutdown
process.on('SIGTERM', () => {
  if (pollTimer) clearTimeout(pollTimer);
  process.exit(0);
});

process.on('SIGINT', () => {
  if (pollTimer) clearTimeout(pollTimer);
  process.exit(0);
});
