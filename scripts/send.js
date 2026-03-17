#!/usr/bin/env node

/**
 * DingTalk message sender — C4 outbound interface.
 *
 * Usage:
 *   node send.js <endpoint> <message>
 *   node send.js <endpoint> "[MEDIA:image]/path/to/image.png"
 *   node send.js <endpoint> "[MEDIA:file]/path/to/file.pdf"
 *
 * Endpoint format:
 *   staffId|type:p2p|msg:msgId    (DM)
 *   conversationId|type:group|msg:msgId  (group)
 */

import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import dotenv from 'dotenv';

const execFileAsync = promisify(execFile);

const HOME = process.env.HOME || '/home/owen';
dotenv.config({ path: path.join(HOME, 'zylos/.env') });

const DATA_DIR = path.join(HOME, 'zylos/components/dingtalk');
const INTERNAL_PORT = 4460;
const MAX_TEXT_LENGTH = 2000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;
const QUEUE_FILE = path.join(DATA_DIR, '.send-queue.json');
const QUEUE_MAX = 10;
const QUEUE_MAX_AGE_MS = 30 * 60 * 1000; // drop items older than 30 minutes

function isRetryable(err) {
  if (err.response?.status === 429) return true;
  if (err.response?.data?.code === 'Throttling') return true;
  const code = err.code;
  return code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EAI_AGAIN';
}

async function withRetry(fn, context = '') {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES && isRetryable(err)) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
        console.warn(`[dingtalk] ${context} retryable error (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message}. Retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

// --- Parse args ---
const [endpoint, ...msgParts] = process.argv.slice(2);
const message = msgParts.join(' ');

if (!endpoint || !message) {
  console.error('Usage: send.js <endpoint> <message>');
  process.exit(1);
}

// --- Parse endpoint ---
function parseEndpoint(ep) {
  const parts = ep.split('|');
  const result = { id: parts[0] };
  for (const part of parts.slice(1)) {
    const idx = part.indexOf(':');
    if (idx > 0) {
      result[part.slice(0, idx)] = part.slice(idx + 1);
    }
  }
  return result;
}

// --- Internal API helpers ---
function getInternalToken() {
  const tokenPath = path.join(DATA_DIR, '.internal-token');
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch {
    return process.env.DINGTALK_INTERNAL_TOKEN || '';
  }
}

async function internalRequest(urlPath, data) {
  const token = getInternalToken();
  try {
    const res = await axios.post(`http://127.0.0.1:${INTERNAL_PORT}${urlPath}`, data, {
      headers: { 'x-internal-token': token, 'content-type': 'application/json' },
      timeout: 5000,
    });
    return res.data;
  } catch {
    return null;
  }
}

async function getSessionWebhook(ep) {
  const result = await internalRequest('/internal/get-webhook', { endpoint: ep });
  return result?.ok ? result.url : null;
}

async function recordOutgoing(chatId, text) {
  await internalRequest('/internal/record-outgoing', { chatId, text });
}

// --- Send queue (file-based, survives across invocations) ---
function readQueue() {
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue), 'utf8');
}

function enqueue(item) {
  const queue = readQueue();
  queue.push(item);
  while (queue.length > QUEUE_MAX) {
    const dropped = queue.shift();
    console.warn(`[dingtalk] Queue full, dropped oldest message to ${parseEndpoint(dropped.endpoint).id}`);
  }
  writeQueue(queue);
}

// --- LLM merge for queued messages ---
async function mergeMessages(messages) {
  if (messages.length <= 1) return messages[0] || '';

  const prompt = `You are a message merge assistant. Below are ${messages.length} messages that were delayed due to DingTalk service throttling. They were meant to be sent to the same recipient in order. Merge them into a single coherent message:
- Remove duplicate or near-duplicate content
- Preserve all unique information
- Keep the original tone and language
- If all messages are truly different, just join them with line breaks
- Output ONLY the merged message, no explanation

Messages:
${messages.map((m, i) => `--- Message ${i + 1} ---\n${m}`).join('\n')}`;

  try {
    const { stdout } = await execFileAsync('claude', ['-p', '--model', 'haiku'], {
      input: prompt,
      timeout: 30000,
      env: { ...process.env, CLAUDE_BYPASS_PERMISSIONS: 'true' },
    });
    const merged = stdout.trim();
    if (merged) return merged;
  } catch (err) {
    console.warn(`[dingtalk] LLM merge failed, sending separately: ${err.message}`);
  }

  // Fallback: simple dedup by joining unique messages
  const unique = [...new Set(messages)];
  return unique.join('\n\n');
}

async function drainQueue() {
  const queue = readQueue();
  if (!queue.length) return;

  const now = Date.now();
  const remaining = [];

  // Separate valid items from expired, group by recipient
  const groups = new Map(); // key -> { items, endpoint }
  for (const item of queue) {
    if (now - item.createdAt > QUEUE_MAX_AGE_MS) {
      console.warn(`[dingtalk] Queue: expired message to ${parseEndpoint(item.endpoint).id} (age ${Math.round((now - item.createdAt) / 1000)}s)`);
      continue;
    }
    const ep = parseEndpoint(item.endpoint);
    const key = `${ep.id}|${ep.type || 'p2p'}`;
    if (!groups.has(key)) groups.set(key, { items: [], endpoint: item.endpoint });
    groups.get(key).items.push(item);
  }

  let totalDelivered = 0;
  const deliveredGroups = []; // track for delay notice

  for (const [key, group] of groups) {
    const { items, endpoint } = group;
    const ep = parseEndpoint(endpoint);

    // Merge messages if multiple for same recipient
    let messageToSend;
    if (items.length > 1) {
      console.log(`[dingtalk] Queue: merging ${items.length} messages for ${ep.id}`);
      messageToSend = await mergeMessages(items.map(i => i.message));
    } else {
      messageToSend = items[0].message;
    }

    try {
      await sendMessage(endpoint, messageToSend);
      totalDelivered += items.length;
      deliveredGroups.push({ endpoint, count: items.length, oldestCreatedAt: items[0].createdAt });
      console.log(`[dingtalk] Queue: delivered ${items.length} merged message(s) to ${ep.id}`);
    } catch (err) {
      // On failure, put all items back with incremented attempts
      for (const item of items) {
        item.attempts = (item.attempts || 0) + 1;
        if (isRetryable(err) && item.attempts < MAX_RETRIES) {
          remaining.push(item);
        } else {
          console.error(`[dingtalk] Queue: dropped message to ${ep.id} after ${item.attempts} drain attempts: ${err.message}`);
        }
      }
      if (remaining.length > 0) {
        console.warn(`[dingtalk] Queue: still failing for ${ep.id}, keeping ${items.length} item(s) in queue`);
      }
    }
  }

  writeQueue(remaining);

  // Send delay notice for each recipient group
  for (const { endpoint, count, oldestCreatedAt } of deliveredGroups) {
    const ep = parseEndpoint(endpoint);
    const delaySec = Math.round((now - oldestCreatedAt) / 1000);
    const notice = `[提示] 以上消息因钉钉服务临时限流延迟了约 ${delaySec} 秒送达，已恢复正常。`;
    try {
      await sendMessage(endpoint, notice);
    } catch {
      // best-effort notice
    }
  }
}

// --- Token management (standalone, for when index.js is not running) ---
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 300000) return cachedToken;

  const appKey = process.env.DINGTALK_APP_KEY;
  const appSecret = process.env.DINGTALK_APP_SECRET;
  if (!appKey || !appSecret) throw new Error('Missing DINGTALK_APP_KEY/DINGTALK_APP_SECRET');

  const res = await axios.get('https://oapi.dingtalk.com/gettoken', {
    params: { appkey: appKey, appsecret: appSecret },
    timeout: 15000,
  });

  if (res.data.errcode !== 0) throw new Error(`Token error: ${res.data.errmsg}`);
  cachedToken = res.data.access_token;
  tokenExpiresAt = now + (res.data.expires_in * 1000);
  return cachedToken;
}

// --- Message chunking ---
function chunkMessage(text, maxLen = MAX_TEXT_LENGTH) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let breakPoint = -1;

    // Check if we're inside a code block
    const codeBlocksBefore = (remaining.slice(0, maxLen).match(/```/g) || []).length;
    const insideCodeBlock = codeBlocksBefore % 2 !== 0;

    if (insideCodeBlock) {
      // Find the end of the code block
      const closeIdx = remaining.indexOf('```', remaining.indexOf('```') + 3);
      if (closeIdx > 0 && closeIdx + 3 <= maxLen * 1.5) {
        breakPoint = closeIdx + 3;
      }
    }

    if (breakPoint < 0) {
      // Try paragraph break
      const chunk = remaining.slice(0, maxLen);
      const lastPara = chunk.lastIndexOf('\n\n');
      if (lastPara > maxLen * 0.3) {
        breakPoint = lastPara;
      } else {
        // Try line break
        const lastLine = chunk.lastIndexOf('\n');
        if (lastLine > maxLen * 0.3) {
          breakPoint = lastLine;
        } else {
          // Try space
          const lastSpace = chunk.lastIndexOf(' ');
          if (lastSpace > maxLen * 0.3) {
            breakPoint = lastSpace;
          } else {
            breakPoint = maxLen;
          }
        }
      }
    }

    chunks.push(remaining.slice(0, breakPoint).trimEnd());
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}

// --- Markdown detection ---
function hasMarkdown(text) {
  return /```/.test(text) ||
    /^#{1,6}\s/m.test(text) ||
    /\*\*[^*]+\*\*/.test(text) ||
    /^[\s]*[-*]\s/m.test(text) ||
    /^[\s]*\d+\.\s/m.test(text) ||
    /\|.+\|/.test(text);
}

// --- Send functions ---
function validateResponse(res, context) {
  if (res?.errcode && res.errcode !== 0) {
    const msg = `${context}: ${res.errmsg || 'unknown error'} (errcode=${res.errcode})`;
    console.error(`[dingtalk] ${msg}`);
    throw new Error(msg);
  }
  if (res?.code && res.code !== 0) {
    const msg = `${context}: ${res.message || res.code}`;
    console.error(`[dingtalk] ${msg}`);
    throw new Error(msg);
  }
}

async function sendViaWebhook(webhookUrl, content) {
  return withRetry(async () => {
    const token = await getAccessToken();
    const body = { msgtype: 'text', text: { content } };

    const res = await axios.post(webhookUrl, body, {
      headers: { 'x-acs-dingtalk-access-token': token },
      timeout: 15000,
    });
    validateResponse(res.data, 'Webhook text send');
    return res.data;
  }, 'webhook-text');
}

async function sendMarkdownViaWebhook(webhookUrl, title, text) {
  return withRetry(async () => {
    const token = await getAccessToken();
    const body = { msgtype: 'markdown', markdown: { title, text } };

    const res = await axios.post(webhookUrl, body, {
      headers: { 'x-acs-dingtalk-access-token': token },
      timeout: 15000,
    });
    validateResponse(res.data, 'Webhook markdown send');
    return res.data;
  }, 'webhook-markdown');
}

async function sendTextDM(userId, content) {
  return withRetry(async () => {
    const token = await getAccessToken();
    const robotCode = process.env.DINGTALK_ROBOT_CODE;
    if (!robotCode) throw new Error('Missing DINGTALK_ROBOT_CODE');

    const res = await axios.post('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
      robotCode,
      userIds: [userId],
      msgKey: 'sampleText',
      msgParam: JSON.stringify({ content }),
    }, {
      headers: { 'x-acs-dingtalk-access-token': token },
      timeout: 15000,
    });
    validateResponse(res.data, `DM text to ${userId}`);
    console.log(`[dingtalk] DM text sent to ${userId}`);
    return res.data;
  }, `dm-text-${userId}`);
}

async function sendMarkdownDM(userId, title, text) {
  return withRetry(async () => {
    const token = await getAccessToken();
    const robotCode = process.env.DINGTALK_ROBOT_CODE;
    if (!robotCode) throw new Error('Missing DINGTALK_ROBOT_CODE');

    const res = await axios.post('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
      robotCode,
      userIds: [userId],
      msgKey: 'sampleMarkdown',
      msgParam: JSON.stringify({ title, text }),
    }, {
      headers: { 'x-acs-dingtalk-access-token': token },
      timeout: 15000,
    });
    validateResponse(res.data, `DM markdown to ${userId}`);
    console.log(`[dingtalk] DM markdown sent to ${userId}`);
    return res.data;
  }, `dm-markdown-${userId}`);
}

async function sendTextGroup(conversationId, content) {
  return withRetry(async () => {
    const token = await getAccessToken();
    const robotCode = process.env.DINGTALK_ROBOT_CODE;
    if (!robotCode) throw new Error('Missing DINGTALK_ROBOT_CODE');

    const res = await axios.post('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
      robotCode,
      openConversationId: conversationId,
      msgKey: 'sampleText',
      msgParam: JSON.stringify({ content }),
    }, {
      headers: { 'x-acs-dingtalk-access-token': token },
      timeout: 15000,
    });
    validateResponse(res.data, `Group text to ${conversationId}`);
    console.log(`[dingtalk] Group text sent to ${conversationId}`);
    return res.data;
  }, `group-text-${conversationId}`);
}

async function sendMarkdownGroup(conversationId, title, text) {
  return withRetry(async () => {
    const token = await getAccessToken();
    const robotCode = process.env.DINGTALK_ROBOT_CODE;
    if (!robotCode) throw new Error('Missing DINGTALK_ROBOT_CODE');

    const res = await axios.post('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
      robotCode,
      openConversationId: conversationId,
      msgKey: 'sampleMarkdown',
      msgParam: JSON.stringify({ title, text }),
    }, {
      headers: { 'x-acs-dingtalk-access-token': token },
      timeout: 15000,
    });
    validateResponse(res.data, `Group markdown to ${conversationId}`);
    console.log(`[dingtalk] Group markdown sent to ${conversationId}`);
    return res.data;
  }, `group-markdown-${conversationId}`);
}

// --- Media sending ---
async function sendMedia(ep, type, filePath) {
  const token = await getAccessToken();
  const robotCode = process.env.DINGTALK_ROBOT_CODE;

  // Upload media first (recreate FormData on each retry — streams are single-use)
  const FormData = (await import('form-data')).default;

  const uploadRes = await withRetry(async () => {
    const form = new FormData();
    form.append('media', fs.createReadStream(filePath));
    const res = await axios.post('https://oapi.dingtalk.com/media/upload', form, {
      params: { access_token: token, type: type === 'image' ? 'image' : 'file' },
      headers: form.getHeaders(),
      timeout: 60000,
    });
    if (res.data.errcode && res.data.errcode !== 0) {
      throw new Error(`Upload failed: ${res.data.errmsg} (errcode=${res.data.errcode})`);
    }
    return res;
  }, 'media-upload');

  console.log(`[dingtalk] Media uploaded: ${type}, mediaId=${uploadRes.data.media_id}`);

  const mediaId = uploadRes.data.media_id;
  const isGroup = ep.type === 'group';

  if (type === 'image') {
    if (isGroup) {
      return withRetry(async () => {
        const t = await getAccessToken();
        const res = await axios.post('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
          robotCode, openConversationId: ep.id,
          msgKey: 'sampleImageMsg', msgParam: JSON.stringify({ photoURL: mediaId }),
        }, {
          headers: { 'x-acs-dingtalk-access-token': t },
          timeout: 15000,
        });
        validateResponse(res.data, `Group image to ${ep.id}`);
        console.log(`[dingtalk] Group image sent to ${ep.id}`);
        return res.data;
      }, `group-image-${ep.id}`);
    } else {
      return withRetry(async () => {
        const t = await getAccessToken();
        const res = await axios.post('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
          robotCode, userIds: [ep.id],
          msgKey: 'sampleImageMsg', msgParam: JSON.stringify({ photoURL: mediaId }),
        }, {
          headers: { 'x-acs-dingtalk-access-token': t },
          timeout: 15000,
        });
        validateResponse(res.data, `DM image to ${ep.id}`);
        console.log(`[dingtalk] DM image sent to ${ep.id}`);
        return res.data;
      }, `dm-image-${ep.id}`);
    }
  } else {
    const fileName = path.basename(filePath);
    const fileType = path.extname(filePath).slice(1) || 'file';
    if (isGroup) {
      return withRetry(async () => {
        const t = await getAccessToken();
        const res = await axios.post('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
          robotCode, openConversationId: ep.id,
          msgKey: 'sampleFile', msgParam: JSON.stringify({ mediaId, fileName, fileType }),
        }, {
          headers: { 'x-acs-dingtalk-access-token': t },
          timeout: 15000,
        });
        validateResponse(res.data, `Group file to ${ep.id}`);
        console.log(`[dingtalk] Group file sent to ${ep.id}`);
        return res.data;
      }, `group-file-${ep.id}`);
    } else {
      return withRetry(async () => {
        const t = await getAccessToken();
        const res = await axios.post('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
          robotCode, userIds: [ep.id],
          msgKey: 'sampleFile', msgParam: JSON.stringify({ mediaId, fileName, fileType }),
        }, {
          headers: { 'x-acs-dingtalk-access-token': t },
          timeout: 15000,
        });
        validateResponse(res.data, `DM file to ${ep.id}`);
        console.log(`[dingtalk] DM file sent to ${ep.id}`);
        return res.data;
      }, `dm-file-${ep.id}`);
    }
  }
}

// --- Core send logic (used by both direct sends and queue drain) ---
async function sendMessage(endpointStr, msg) {
  const ep = parseEndpoint(endpointStr);
  const isGroup = ep.type === 'group';

  // Check for media
  const mediaMatch = msg.match(/^\[MEDIA:(\w+)\](.+)$/);
  if (mediaMatch) {
    const [, mediaType, mediaPath] = mediaMatch;
    await sendMedia(ep, mediaType, mediaPath.trim());
    console.log(`[dingtalk] Media ${mediaType} sent to ${ep.id} (${ep.type || 'DM'})`);
    return;
  }

  // Text message — chunk and send
  const chunks = chunkMessage(msg);

  // Try sessionWebhook first (fastest, works for replies)
  const webhookUrl = await getSessionWebhook(endpointStr);

  const totalChunks = chunks.length;
  if (totalChunks > 1) {
    console.log(`[dingtalk] Sending ${totalChunks} chunks to ${ep.id} (${isGroup ? 'group' : 'DM'})`);
  }

  for (let i = 0; i < totalChunks; i++) {
    const chunk = chunks[i];
    const chunkLabel = totalChunks > 1 ? ` [${i + 1}/${totalChunks}]` : '';
    let sent = false;

    // Try webhook reply first
    if (webhookUrl) {
      try {
        if (hasMarkdown(chunk)) {
          await sendMarkdownViaWebhook(webhookUrl, 'Reply', chunk);
        } else {
          await sendViaWebhook(webhookUrl, chunk);
        }
        sent = true;
        if (totalChunks > 1) console.log(`[dingtalk] Chunk${chunkLabel} sent via webhook`);
      } catch (err) {
        console.error(`[dingtalk] Webhook reply failed${chunkLabel}, falling back to API: ${err.message}`);
      }
    }

    // Fallback to proactive API
    if (!sent) {
      if (isGroup) {
        if (hasMarkdown(chunk)) {
          await sendMarkdownGroup(ep.id, 'Reply', chunk);
        } else {
          await sendTextGroup(ep.id, chunk);
        }
      } else {
        if (hasMarkdown(chunk)) {
          await sendMarkdownDM(ep.id, 'Reply', chunk);
        } else {
          await sendTextDM(ep.id, chunk);
        }
      }
      if (totalChunks > 1) console.log(`[dingtalk] Chunk${chunkLabel} sent via API`);
    }

    // Delay between chunks
    if (i < totalChunks - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Record outgoing to history
  await recordOutgoing(ep.id, msg.slice(0, 4000));

  console.log(`[dingtalk] Sent ${totalChunks} chunk(s) to ${ep.id} (${isGroup ? 'group' : 'DM'})`);
}

// --- Main entry point ---
async function main() {
  // Drain queued messages first
  await drainQueue();

  // Send current message
  try {
    await sendMessage(endpoint, message);
  } catch (err) {
    if (isRetryable(err)) {
      enqueue({ endpoint, message, attempts: 0, createdAt: Date.now() });
      console.warn(`[dingtalk] Send failed (retryable), queued for later delivery: ${err.message}`);
    } else {
      throw err;
    }
  }
}

main().catch(err => {
  console.error(`[dingtalk] Send failed: ${err.message}`);
  process.exit(1);
});
