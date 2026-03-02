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
import axios from 'axios';
import dotenv from 'dotenv';

const HOME = process.env.HOME || '/home/owen';
dotenv.config({ path: path.join(HOME, 'zylos/.env') });

const DATA_DIR = path.join(HOME, 'zylos/components/dingtalk');
const INTERNAL_PORT = 4459;
const MAX_TEXT_LENGTH = 2000;

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
async function sendViaWebhook(webhookUrl, content) {
  const token = await getAccessToken();
  const body = { msgtype: 'text', text: { content } };

  const res = await axios.post(webhookUrl, body, {
    headers: { 'x-acs-dingtalk-access-token': token },
    timeout: 15000,
  });
  return res.data;
}

async function sendMarkdownViaWebhook(webhookUrl, title, text) {
  const token = await getAccessToken();
  const body = { msgtype: 'markdown', markdown: { title, text } };

  const res = await axios.post(webhookUrl, body, {
    headers: { 'x-acs-dingtalk-access-token': token },
    timeout: 15000,
  });
  return res.data;
}

async function sendTextDM(userId, content) {
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
  return res.data;
}

async function sendMarkdownDM(userId, title, text) {
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
  return res.data;
}

async function sendTextGroup(conversationId, content) {
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
  return res.data;
}

async function sendMarkdownGroup(conversationId, title, text) {
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
  return res.data;
}

// --- Media sending ---
async function sendMedia(ep, type, filePath) {
  const token = await getAccessToken();
  const robotCode = process.env.DINGTALK_ROBOT_CODE;

  // Upload media first
  const FormData = (await import('form-data')).default;
  const form = new FormData();
  form.append('media', fs.createReadStream(filePath));

  const uploadRes = await axios.post('https://oapi.dingtalk.com/media/upload', form, {
    params: { access_token: token, type: type === 'image' ? 'image' : 'file' },
    headers: form.getHeaders(),
    timeout: 60000,
  });

  if (uploadRes.data.errcode && uploadRes.data.errcode !== 0) {
    throw new Error(`Upload failed: ${uploadRes.data.errmsg}`);
  }

  const mediaId = uploadRes.data.media_id;
  const isGroup = ep.type === 'group';

  if (type === 'image') {
    if (isGroup) {
      return sendGroup(ep.id, 'sampleImageMsg', JSON.stringify({ photoURL: mediaId }));
    } else {
      const res = await axios.post('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
        robotCode, userIds: [ep.id],
        msgKey: 'sampleImageMsg', msgParam: JSON.stringify({ photoURL: mediaId }),
      }, {
        headers: { 'x-acs-dingtalk-access-token': token },
        timeout: 15000,
      });
      return res.data;
    }
  } else {
    const fileName = path.basename(filePath);
    const fileType = path.extname(filePath).slice(1) || 'file';
    if (isGroup) {
      return sendGroup(ep.id, 'sampleFile', JSON.stringify({ mediaId, fileName, fileType }));
    } else {
      const res = await axios.post('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
        robotCode, userIds: [ep.id],
        msgKey: 'sampleFile', msgParam: JSON.stringify({ mediaId, fileName, fileType }),
      }, {
        headers: { 'x-acs-dingtalk-access-token': token },
        timeout: 15000,
      });
      return res.data;
    }
  }
}

// --- Main send logic ---
async function run() {
  const ep = parseEndpoint(endpoint);
  const isGroup = ep.type === 'group';

  // Check for media
  const mediaMatch = message.match(/^\[MEDIA:(\w+)\](.+)$/);
  if (mediaMatch) {
    const [, mediaType, mediaPath] = mediaMatch;
    await sendMedia(ep, mediaType, mediaPath.trim());
    console.log(`[dingtalk] Media sent: ${mediaType}`);
    return;
  }

  // Text message — chunk and send
  const chunks = chunkMessage(message);

  // Try sessionWebhook first (fastest, works for replies)
  const webhookUrl = await getSessionWebhook(endpoint);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
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
      } catch (err) {
        console.error(`[dingtalk] Webhook reply failed, falling back to API: ${err.message}`);
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
    }

    // Delay between chunks
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Record outgoing to history
  const chatId = isGroup ? ep.id : ep.id;
  await recordOutgoing(chatId, message.slice(0, 4000));

  console.log(`[dingtalk] Sent ${chunks.length} chunk(s) to ${ep.id}`);
}

run().catch(err => {
  console.error(`[dingtalk] Send failed: ${err.message}`);
  process.exit(1);
});
