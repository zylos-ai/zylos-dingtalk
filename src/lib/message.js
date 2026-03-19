import fs from 'fs';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import { getAccessToken, apiRequestV1, apiRequestV2 } from './client.js';
import { getCredentials, DATA_DIR } from './config.js';

const MEDIA_DIR = path.join(DATA_DIR, 'media');
const DINGTALK_API_V2 = 'https://api.dingtalk.com';
const MAX_FILE_CONTENT_LENGTH = 50000; // 50K chars max for extracted text
const MAX_DOWNLOAD_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_TEXT_READ_SIZE = 2 * 1024 * 1024; // 2MB text direct-read limit
const MAX_PARSE_FILE_SIZE = 20 * 1024 * 1024; // 20MB parse safety limit
const MEDIA_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const MEDIA_FILE_MAX_COUNT = 500;
const MEDIA_TOTAL_MAX_SIZE = 512 * 1024 * 1024; // 512MB

const TEXT_FILE_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml', '.html', '.htm',
  '.log', '.conf', '.ini', '.sh', '.py', '.js', '.ts', '.css', '.sql',
]);

const PARSEABLE_EXTENSIONS = new Set(['.docx', '.pdf']);

function sanitizeFileName(fileName) {
  return (fileName || 'file').replace(/[/\\:*?"<>|]/g, '_').slice(0, 120);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/**
 * Cleanup downloaded media files.
 * Removes files older than max age and enforces count/size caps.
 */
export function cleanupMediaCache({ silent = false } = {}) {
  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });

    const now = Date.now();
    const entries = fs.readdirSync(MEDIA_DIR, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const fullPath = path.join(MEDIA_DIR, d.name);
        const stat = fs.statSync(fullPath);
        return {
          name: d.name,
          path: fullPath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    const kept = [];
    let removedByAge = 0;
    for (const file of entries) {
      if (now - file.mtimeMs > MEDIA_FILE_MAX_AGE_MS) {
        try {
          fs.unlinkSync(file.path);
          removedByAge += 1;
        } catch {}
      } else {
        kept.push(file);
      }
    }

    let removedByCount = 0;
    while (kept.length > MEDIA_FILE_MAX_COUNT) {
      const oldest = kept.shift();
      try {
        fs.unlinkSync(oldest.path);
        removedByCount += 1;
      } catch {}
    }

    let totalSize = kept.reduce((sum, f) => sum + f.size, 0);
    let removedBySize = 0;
    while (totalSize > MEDIA_TOTAL_MAX_SIZE && kept.length > 0) {
      const oldest = kept.shift();
      try {
        fs.unlinkSync(oldest.path);
      } catch {}
      totalSize -= oldest.size;
      removedBySize += 1;
    }

    if (!silent && (removedByAge || removedByCount || removedBySize)) {
      console.log(`[dingtalk] Media cache cleanup: -age ${removedByAge}, -count ${removedByCount}, -size ${removedBySize}, remaining ${kept.length}, total ${formatBytes(Math.max(0, totalSize))}`);
    }
  } catch (err) {
    if (!silent) {
      console.warn(`[dingtalk] Media cache cleanup failed: ${err.message}`);
    }
  }
}

/**
 * Reply via sessionWebhook (works for ~10 min after receiving message).
 */
export async function replyViaWebhook(sessionWebhook, msgtype, body) {
  const token = await getAccessToken();
  const res = await axios.post(sessionWebhook, {
    msgtype,
    ...body,
  }, {
    headers: { 'x-acs-dingtalk-access-token': token },
    timeout: 15000,
  });
  if (res.data?.errcode && res.data.errcode !== 0) {
    console.error(`[dingtalk] Webhook reply failed: ${res.data.errmsg} (errcode=${res.data.errcode})`);
    throw new Error(`Webhook reply failed: ${res.data.errmsg}`);
  }
  return res.data;
}

/**
 * Send text reply via sessionWebhook.
 */
export async function replyText(sessionWebhook, content, atUserIds = []) {
  return replyViaWebhook(sessionWebhook, 'text', {
    text: { content },
    at: { atUserIds, isAtAll: false },
  });
}

/**
 * Send markdown reply via sessionWebhook.
 */
export async function replyMarkdown(sessionWebhook, title, text, atUserIds = []) {
  return replyViaWebhook(sessionWebhook, 'markdown', {
    markdown: { title, text },
    at: { atUserIds, isAtAll: false },
  });
}

/**
 * Proactive send to 1:1 DM (batch).
 * userIds: array of staff IDs.
 */
export async function sendDM(userIds, msgKey, msgParam) {
  const creds = getCredentials();
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  const res = await apiRequestV2('POST', '/v1.0/robot/oToMessages/batchSend', {
    robotCode: creds.robot_code,
    userIds: ids,
    msgKey,
    msgParam: typeof msgParam === 'string' ? msgParam : JSON.stringify(msgParam),
  });
  if (res?.code && String(res.code) !== '0') {
    const msg = `DM send failed: ${res.message || res.code} (users=${ids.join(',')})`;
    console.error(`[dingtalk] ${msg}`);
    throw new Error(msg);
  }
  console.log(`[dingtalk] DM sent to ${ids.join(',')} (msgKey=${msgKey})`);
  return res;
}

/**
 * Proactive send to group chat.
 */
export async function sendGroup(openConversationId, msgKey, msgParam) {
  const creds = getCredentials();
  const res = await apiRequestV2('POST', '/v1.0/robot/groupMessages/send', {
    robotCode: creds.robot_code,
    openConversationId,
    msgKey,
    msgParam: typeof msgParam === 'string' ? msgParam : JSON.stringify(msgParam),
  });
  if (res?.code && String(res.code) !== '0') {
    const msg = `Group send failed: ${res.message || res.code} (group=${openConversationId})`;
    console.error(`[dingtalk] ${msg}`);
    throw new Error(msg);
  }
  console.log(`[dingtalk] Group message sent to ${openConversationId} (msgKey=${msgKey})`);
  return res;
}

/**
 * Send text message to DM.
 */
export async function sendTextDM(userIds, content) {
  return sendDM(userIds, 'sampleText', { content });
}

/**
 * Send markdown to DM.
 */
export async function sendMarkdownDM(userIds, title, text) {
  return sendDM(userIds, 'sampleMarkdown', { title, text });
}

/**
 * Send text to group.
 */
export async function sendTextGroup(conversationId, content) {
  return sendGroup(conversationId, 'sampleText', { content });
}

/**
 * Send markdown to group.
 */
export async function sendMarkdownGroup(conversationId, title, text) {
  return sendGroup(conversationId, 'sampleMarkdown', { title, text });
}

/**
 * Send image to DM.
 */
export async function sendImageDM(userIds, mediaId) {
  return sendDM(userIds, 'sampleImageMsg', { photoURL: mediaId });
}

/**
 * Send file to DM.
 */
export async function sendFileDM(userIds, mediaId, fileName, fileType) {
  return sendDM(userIds, 'sampleFile', { mediaId, fileName, fileType });
}

/**
 * Upload media to DingTalk.
 * type: image | voice | video | file
 */
export async function uploadMedia(filePath, type = 'image') {
  const token = await getAccessToken();
  const form = new FormData();
  form.append('media', fs.createReadStream(filePath));

  const res = await axios.post(
    `https://oapi.dingtalk.com/media/upload`,
    form,
    {
      params: { access_token: token, type },
      headers: form.getHeaders(),
      timeout: 60000,
    }
  );

  if (res.data.errcode && res.data.errcode !== 0) {
    throw new Error(`Upload failed: ${res.data.errmsg}`);
  }
  return res.data.media_id;
}

/**
 * Download media by URL to local media directory.
 */
export async function downloadMedia(url, filename) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  // Prevent path traversal
  const safeName = path.basename(filename || `dingtalk-${Date.now()}`);
  const destPath = path.join(MEDIA_DIR, safeName);

  const res = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    timeout: 60000,
  });

  const writer = fs.createWriteStream(destPath);
  res.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve(destPath));
    writer.on('error', reject);
  });
}

// --- Thinking Emoji ---

async function postV2NoRetry(apiPath, data, timeout = 5000) {
  const token = await getAccessToken();
  const res = await axios.post(`${DINGTALK_API_V2}${apiPath}`, data, {
    headers: { 'x-acs-dingtalk-access-token': token },
    timeout,
  });

  if (res.data?.code && String(res.data.code) !== '0') {
    throw new Error(res.data.message || res.data.code);
  }
  return res.data;
}

/**
 * Add "🤔思考中" emoji reaction to a message.
 * Silently fails — never throws.
 */
export async function addThinkingEmoji(robotCode, msgId, conversationId) {
  try {
    await postV2NoRetry('/v1.0/robot/emotion/reply', {
      robotCode,
      openMsgId: msgId,
      openConversationId: conversationId,
      emotionType: 2,
      emotionName: '🤔思考中',
      textEmotion: {
        emotionId: '2659900',
        emotionName: '🤔思考中',
        text: '🤔思考中',
        backgroundId: 'im_bg_1',
      },
    }, 5000);
  } catch (err) {
    console.warn(`[dingtalk] Add thinking emoji failed (non-blocking): ${err.message}`);
  }
}

/**
 * Recall "🤔思考中" emoji reaction from a message.
 * Silently fails — never throws.
 */
export async function recallThinkingEmoji(robotCode, msgId, conversationId) {
  try {
    await postV2NoRetry('/v1.0/robot/emotion/recall', {
      robotCode,
      openMsgId: msgId,
      openConversationId: conversationId,
      emotionType: 2,
      emotionName: '🤔思考中',
      textEmotion: {
        emotionId: '2659900',
        emotionName: '🤔思考中',
        text: '🤔思考中',
        backgroundId: 'im_bg_1',
      },
    }, 5000);
  } catch (err) {
    console.warn(`[dingtalk] Recall thinking emoji failed (non-blocking): ${err.message}`);
  }
}

// --- File Content Extraction ---

/**
 * Download a file from DingTalk using downloadCode.
 * Two-step: exchange downloadCode for URL, then download the file.
 */
export async function downloadFileByCode(downloadCode, fileName) {
  const creds = getCredentials();
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  cleanupMediaCache({ silent: true });

  // Step 1: Exchange downloadCode for download URL
  const result = await apiRequestV2('POST', '/v1.0/robot/messageFiles/download', {
    downloadCode,
    robotCode: creds.robot_code || creds.app_key,
  }, { timeout: 15000 });

  const downloadUrl = result?.downloadUrl;
  if (!downloadUrl) {
    throw new Error('No downloadUrl in response');
  }

  // Step 2: Download the file
  const safeName = `${Date.now()}-${sanitizeFileName(fileName)}`;
  const localPath = path.join(MEDIA_DIR, safeName);

  const res = await axios({
    method: 'GET',
    url: downloadUrl,
    responseType: 'stream',
    timeout: 60000,
    maxBodyLength: MAX_DOWNLOAD_FILE_SIZE,
    maxContentLength: MAX_DOWNLOAD_FILE_SIZE,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  const contentLength = Number(res.headers?.['content-length'] || 0);
  if (contentLength > MAX_DOWNLOAD_FILE_SIZE) {
    throw new Error(`File too large (${formatBytes(contentLength)} > ${formatBytes(MAX_DOWNLOAD_FILE_SIZE)})`);
  }

  let writtenBytes = 0;
  const writer = fs.createWriteStream(localPath);

  return new Promise((resolve, reject) => {
    function cleanupPartial() {
      try {
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
      } catch {}
    }

    res.data.on('data', (chunk) => {
      writtenBytes += chunk.length;
      if (writtenBytes > MAX_DOWNLOAD_FILE_SIZE) {
        res.data.destroy(new Error(`File too large while streaming (${formatBytes(writtenBytes)} > ${formatBytes(MAX_DOWNLOAD_FILE_SIZE)})`));
      }
    });

    res.data.on('error', (err) => {
      writer.destroy(err);
    });

    writer.on('error', (err) => {
      cleanupPartial();
      reject(err);
    });

    writer.on('finish', () => {
      console.log(`[dingtalk] File downloaded: ${localPath} (${formatBytes(writtenBytes)})`);
      cleanupMediaCache({ silent: true });
      resolve(localPath);
    });

    res.data.pipe(writer);
  });
}

/**
 * Extract text content from a downloaded file.
 * Supports: text files, .docx (mammoth), .pdf (pdf-parse).
 * Returns extracted text or null if not extractable.
 */
export async function extractFileContent(filePath, displayName = null) {
  const ext = path.extname(filePath).toLowerCase();
  const fileName = sanitizeFileName(displayName || path.basename(filePath));

  try {
    const stat = fs.statSync(filePath);

    // Text files — direct read
    if (TEXT_FILE_EXTENSIONS.has(ext)) {
      if (stat.size > MAX_TEXT_READ_SIZE) {
        return `[文件: ${fileName}]\n[文本文件较大(${formatBytes(stat.size)})，已跳过全文提取]`;
      }
      const content = fs.readFileSync(filePath, 'utf8');
      return truncateContent(content, fileName);
    }

    if (PARSEABLE_EXTENSIONS.has(ext) && stat.size > MAX_PARSE_FILE_SIZE) {
      return `[文件: ${fileName}]\n[文件较大(${formatBytes(stat.size)})，已跳过内容提取]`;
    }

    // Word documents — mammoth
    if (ext === '.docx') {
      const mammoth = await import('mammoth');
      const result = await mammoth.default.extractRawText({ path: filePath });
      return truncateContent(result.value, fileName);
    }

    // PDF — pdf-parse
    if (ext === '.pdf') {
      const pdfParse = (await import('pdf-parse')).default;
      const dataBuffer = fs.readFileSync(filePath);
      const pdfData = await pdfParse(dataBuffer);
      return truncateContent(pdfData.text, fileName);
    }

    // Not extractable
    return null;
  } catch (err) {
    console.error(`[dingtalk] Failed to extract content from ${fileName}: ${err.message}`);
    return null;
  }
}

function truncateContent(text, fileName) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (trimmed.length > MAX_FILE_CONTENT_LENGTH) {
    return `[文件: ${fileName}]\n\`\`\`\n${trimmed.slice(0, MAX_FILE_CONTENT_LENGTH)}\n...(内容过长，已截断)\n\`\`\``;
  }
  return `[文件: ${fileName}]\n\`\`\`\n${trimmed}\n\`\`\``;
}
