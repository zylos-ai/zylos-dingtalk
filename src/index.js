import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import http from 'http';
import dotenv from 'dotenv';
import { execFile } from 'child_process';
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import { getConfig, saveConfig, watchConfig, stopWatching, getCredentials, DATA_DIR } from './lib/config.js';
import { getUserInfo } from './lib/contact.js';

dotenv.config({ path: path.join(os.homedir(), 'zylos/.env') });

const C4_RECEIVE = path.join(os.homedir(), 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const INTERNAL_TOKEN_PATH = path.join(DATA_DIR, '.internal-token');

// --- State ---
let config = getConfig();
let streamClient = null;
let internalServer = null;

// Deduplication: msgId -> timestamp
const processedMessages = new Map();
const DEDUP_TTL = 5 * 60 * 1000;
let dedupCleanupInterval = null;

// Chat history: conversationId -> [{ msgId, userId, userName, text, timestamp }]
const chatHistories = new Map();
const DEFAULT_HISTORY_LIMIT = 5;

// User name cache: staffId -> { name, cachedAt }
const userNameCache = new Map();
const USER_CACHE_TTL = 10 * 60 * 1000;
const USER_CACHE_PATH = path.join(DATA_DIR, 'user-cache.json');

// --- Init ---
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'media'), { recursive: true });

if (!config.enabled) {
  console.log('[dingtalk] Component disabled in config, exiting.');
  process.exit(0);
}

const creds = getCredentials();
if (!creds.app_key || !creds.app_secret) {
  console.error('[dingtalk] DINGTALK_APP_KEY and DINGTALK_APP_SECRET are required. Exiting.');
  process.exit(1);
}

// --- Internal token ---
const internalToken = crypto.randomUUID();
fs.writeFileSync(INTERNAL_TOKEN_PATH, internalToken, { mode: 0o600 });

// --- User cache persistence ---
function loadUserCache() {
  try {
    if (fs.existsSync(USER_CACHE_PATH)) {
      const data = JSON.parse(fs.readFileSync(USER_CACHE_PATH, 'utf8'));
      for (const [k, v] of Object.entries(data)) {
        userNameCache.set(k, v);
      }
    }
  } catch {}
}

function persistUserCache() {
  try {
    const obj = {};
    for (const [k, v] of userNameCache) obj[k] = v;
    fs.writeFileSync(USER_CACHE_PATH, JSON.stringify(obj, null, 2));
  } catch {}
}

loadUserCache();
const userCachePersistInterval = setInterval(persistUserCache, 60000);

// --- Dedup ---
function isDuplicate(msgId) {
  if (processedMessages.has(msgId)) return true;
  processedMessages.set(msgId, Date.now());
  return false;
}

dedupCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of processedMessages) {
    if (now - ts > DEDUP_TTL) processedMessages.delete(id);
  }
}, 60000);

// --- User name resolution ---
async function resolveUserName(staffId) {
  if (!staffId) return 'Unknown';

  const cached = userNameCache.get(staffId);
  if (cached && Date.now() - cached.cachedAt < USER_CACHE_TTL) {
    return cached.name;
  }

  try {
    const result = await getUserInfo(staffId);
    if (result.success) {
      userNameCache.set(staffId, { name: result.user.name, cachedAt: Date.now() });
      return result.user.name;
    }
  } catch (err) {
    console.error(`[dingtalk] Failed to resolve user ${staffId}:`, err.message);
  }

  return staffId;
}

// --- Chat history ---
function recordHistory(conversationId, entry) {
  if (!chatHistories.has(conversationId)) {
    chatHistories.set(conversationId, []);
  }
  const history = chatHistories.get(conversationId);
  // Dedup by msgId
  if (entry.msgId && history.some(h => h.msgId === entry.msgId)) return;
  history.push(entry);
  // Keep limited
  const limit = (config.message?.context_messages || DEFAULT_HISTORY_LIMIT) * 2;
  while (history.length > limit) history.shift();
}

function getContextMessages(conversationId, currentMsgId) {
  const history = chatHistories.get(conversationId) || [];
  const limit = config.message?.context_messages || DEFAULT_HISTORY_LIMIT;
  return history
    .filter(m => m.msgId !== currentMsgId)
    .slice(-limit);
}

// --- Permission checks ---
function isOwner(staffId) {
  return config.owner?.bound && config.owner.staff_id === String(staffId);
}

function checkDMPermission(staffId) {
  if (isOwner(staffId)) return true;
  switch (config.dmPolicy) {
    case 'open': return true;
    case 'owner': return false;
    case 'allowlist': return (config.dmAllowFrom || []).includes(String(staffId));
    default: return false;
  }
}

function checkGroupPermission(staffId, conversationId) {
  if (isOwner(staffId)) return true;
  switch (config.groupPolicy) {
    case 'disabled': return false;
    case 'open': return true;
    case 'allowlist': {
      const groupConfig = config.groups?.[conversationId];
      if (!groupConfig) return false;
      if (!groupConfig.allowFrom || groupConfig.allowFrom.length === 0) return true;
      if (groupConfig.allowFrom.includes('*')) return true;
      return groupConfig.allowFrom.includes(String(staffId));
    }
    default: return false;
  }
}

// --- Owner auto-binding ---
async function tryBindOwner(staffId, name) {
  if (config.owner?.bound) return;
  config.owner = { bound: true, staff_id: String(staffId), name };
  saveConfig(config);
  console.log(`[dingtalk] Owner bound: ${name} (${staffId})`);
}

// --- C4 forwarding ---
function forwardToC4(channel, endpoint, content) {
  const args = [
    C4_RECEIVE,
    '--channel', channel,
    '--endpoint', endpoint,
    '--json',
    '--content', content,
  ];

  execFile('node', args, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('[dingtalk] C4 forward error:', err.message);
      if (stderr) console.error('[dingtalk] C4 stderr:', stderr);
    }
  });
}

// --- Message handler ---
async function handleBotMessage(res) {
  let msg;
  try {
    msg = JSON.parse(res.data);
  } catch (err) {
    console.error('[dingtalk] Failed to parse message data:', err.message);
    // ACK to prevent retry
    streamClient.socketCallBackResponse(res.headers.messageId, { status: 'FAIL' });
    return;
  }

  const {
    msgId,
    senderStaffId,
    senderNick,
    conversationType,
    conversationId,
    conversationTitle,
    text,
    msgtype,
    sessionWebhook,
    sessionWebhookExpiredTime,
    isInAtList,
  } = msg;

  // Dedup
  if (isDuplicate(msgId)) {
    streamClient.socketCallBackResponse(res.headers.messageId, { status: 'OK' });
    return;
  }

  // Resolve user name (prefer senderNick, fallback to API)
  const userName = senderNick || await resolveUserName(senderStaffId);

  // conversationType: "1" = 1:1 DM, "2" = group
  const isGroup = conversationType === '2';
  const isDM = !isGroup;

  // Permission check
  if (isDM) {
    // Auto-bind owner on first DM
    if (!config.owner?.bound) {
      await tryBindOwner(senderStaffId, userName);
    }
    if (!checkDMPermission(senderStaffId)) {
      console.log(`[dingtalk] DM denied: ${userName} (${senderStaffId})`);
      streamClient.socketCallBackResponse(res.headers.messageId, { status: 'OK' });
      return;
    }
  } else {
    if (!checkGroupPermission(senderStaffId, conversationId)) {
      console.log(`[dingtalk] Group denied: ${userName} in ${conversationTitle}`);
      streamClient.socketCallBackResponse(res.headers.messageId, { status: 'OK' });
      return;
    }
  }

  // Extract content based on msgtype
  let contentText = '';
  let mediaPath = null;

  switch (msgtype) {
    case 'text':
      contentText = text?.content?.trim() || '';
      break;
    case 'richText':
      contentText = '[rich text message]';
      break;
    case 'picture':
      contentText = '[image]';
      // TODO: download image if URL available in msg
      break;
    case 'video':
      contentText = '[video]';
      break;
    case 'audio':
      contentText = '[audio]';
      break;
    case 'file':
      contentText = '[file]';
      break;
    default:
      contentText = `[${msgtype || 'unknown'}]`;
  }

  if (!contentText) {
    streamClient.socketCallBackResponse(res.headers.messageId, { status: 'OK' });
    return;
  }

  // Record to history
  recordHistory(conversationId, {
    msgId,
    userId: senderStaffId,
    userName,
    text: contentText,
    timestamp: new Date().toISOString(),
  });

  // Build C4 message
  const replyEndpoint = isGroup
    ? `${conversationId}|type:group|msg:${msgId}`
    : `${senderStaffId}|type:p2p|msg:${msgId}`;

  // Store sessionWebhook in a temp map so send.js can use it
  storeSessionWebhook(replyEndpoint, sessionWebhook, sessionWebhookExpiredTime);

  let c4Content = '';

  if (isDM) {
    c4Content = `[DingTalk DM] ${userName} said: ${contentText}`;
  } else {
    const context = getContextMessages(conversationId, msgId);
    let contextStr = '';
    if (context.length > 0) {
      contextStr = '\n\n--- recent context ---\n' +
        context.map(m => `${m.userName}: ${m.text}`).join('\n');
    }
    c4Content = `[DingTalk GROUP:${conversationTitle || conversationId}] ${userName} said: ${contentText}${contextStr}`;
  }

  if (mediaPath) {
    c4Content += ` ---- file: ${mediaPath}`;
  }

  // Forward to C4
  forwardToC4('dingtalk', replyEndpoint, c4Content);

  // ACK
  streamClient.socketCallBackResponse(res.headers.messageId, { status: 'OK' });

  console.log(`[dingtalk] ${isDM ? 'DM' : 'GROUP'} from ${userName}: ${contentText.slice(0, 80)}`);
}

// --- Session webhook store ---
// Temporary storage for sessionWebhook URLs so send.js can use them for replies
const sessionWebhooks = new Map();
const WEBHOOK_CLEANUP_INTERVAL = 60000;

function storeSessionWebhook(endpoint, webhookUrl, expiresAt) {
  if (!webhookUrl) return;
  sessionWebhooks.set(endpoint, { url: webhookUrl, expiresAt });
}

// Clean up expired webhooks
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of sessionWebhooks) {
    if (now > val.expiresAt) sessionWebhooks.delete(key);
  }
}, WEBHOOK_CLEANUP_INTERVAL);

// --- Internal API server ---
// Provides session webhook lookup and history recording for send.js
function startInternalServer(port) {
  const server = http.createServer((req, res) => {
    // Auth check
    const token = req.headers['x-internal-token'];
    if (token !== internalToken) {
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);

        if (req.url === '/internal/record-outgoing') {
          const { chatId, text } = data;
          if (chatId) {
            recordHistory(String(chatId), {
              msgId: `out_${Date.now()}_${Math.random().toString(36).slice(2)}`,
              userId: 'bot',
              userName: 'bot',
              text: String(text).slice(0, 4000),
              timestamp: new Date().toISOString(),
            });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));

        } else if (req.url === '/internal/get-webhook') {
          const { endpoint } = data;
          const wh = sessionWebhooks.get(endpoint);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (wh && Date.now() < wh.expiresAt) {
            res.end(JSON.stringify({ ok: true, url: wh.url }));
          } else {
            res.end(JSON.stringify({ ok: false }));
          }

        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      } catch (err) {
        res.writeHead(400);
        res.end('Bad request');
      }
    });
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[dingtalk] Internal API on 127.0.0.1:${port}`);
  });

  return server;
}

// --- Config watch ---
watchConfig((newConfig) => {
  config = newConfig;
  if (!newConfig.enabled) {
    console.log('[dingtalk] Component disabled, shutting down.');
    shutdown();
  }
});

// --- Private IP detection ---
function isPrivateIP(hostname) {
  // Check for RFC 1918 private addresses and other non-routable ranges
  const privatePatterns = [
    /^10\./,                          // 10.0.0.0/8
    /^172\.(1[6-9]|2\d|3[01])\./,    // 172.16.0.0/12
    /^192\.168\./,                    // 192.168.0.0/16
    /^127\./,                         // 127.0.0.0/8 (loopback)
    /^169\.254\./,                    // 169.254.0.0/16 (link-local)
  ];
  return privatePatterns.some(p => p.test(hostname));
}

function extractHostFromURL(url) {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return null;
  }
}

// --- Main ---
async function main() {
  console.log(`[dingtalk] Starting... Data dir: ${DATA_DIR}`);

  // Start internal API (webhook port + 1000, following wecom pattern)
  const internalPort = 4460; // fixed internal port (4459 used by wecom)
  internalServer = startInternalServer(internalPort);

  // Create stream client
  streamClient = new DWClient({
    clientId: creds.app_key,
    clientSecret: creds.app_secret,
    debug: false,
  });

  // Register bot message handler
  streamClient.registerCallbackListener(TOPIC_ROBOT, async (res) => {
    try {
      await handleBotMessage(res);
    } catch (err) {
      console.error('[dingtalk] Message handler error:', err);
      try {
        streamClient.socketCallBackResponse(res.headers.messageId, { status: 'FAIL' });
      } catch {}
    }
  });

  // Register generic event handler
  streamClient.registerAllEventListener((msg) => {
    return { status: 'SUCCESS' };
  });

  // Connect with private IP detection — retry if gateway returns a private IP
  const MAX_ENDPOINT_RETRIES = 3;
  try {
    for (let attempt = 0; attempt < MAX_ENDPOINT_RETRIES; attempt++) {
      await streamClient.getEndpoint();
      const host = extractHostFromURL(streamClient.dw_url);
      if (host && isPrivateIP(host)) {
        console.warn(`[dingtalk] Gateway returned private IP ${host}, retrying (${attempt + 1}/${MAX_ENDPOINT_RETRIES})...`);
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      // _connect() is a private method of dingtalk-stream DWClient.
      // Tested with dingtalk-stream@2.1.4. If the SDK updates, verify this still works.
      await streamClient._connect();
      console.log('[dingtalk] Stream connected');
      return;
    }
    // All retries got private IPs, try connecting anyway as last resort
    console.warn('[dingtalk] All endpoint retries returned private IPs, attempting connection anyway');
    // See version note above re: _connect()
    await streamClient._connect();
    console.log('[dingtalk] Stream connected (private IP fallback)');
  } catch (err) {
    console.error('[dingtalk] Stream connection failed:', err.message);
    process.exit(1);
  }
}

// --- Graceful shutdown ---
async function shutdown() {
  console.log('[dingtalk] Shutting down...');
  stopWatching();
  clearInterval(dedupCleanupInterval);
  clearInterval(userCachePersistInterval);
  persistUserCache();

  if (streamClient) {
    try { streamClient.disconnect(); } catch {}
  }
  if (internalServer) {
    internalServer.close();
  }

  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error('[dingtalk] Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[dingtalk] Unhandled rejection:', err);
});

main().catch(err => {
  console.error('[dingtalk] Fatal error:', err);
  process.exit(1);
});
