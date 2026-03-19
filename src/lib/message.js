import fs from 'fs';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import { getAccessToken, apiRequestV1, apiRequestV2 } from './client.js';
import { getCredentials, DATA_DIR } from './config.js';

const MEDIA_DIR = path.join(DATA_DIR, 'media');
const MAX_FILE_CONTENT_LENGTH = 50000; // 50K chars max for extracted text

const TEXT_FILE_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml', '.html', '.htm',
  '.log', '.conf', '.ini', '.sh', '.py', '.js', '.ts', '.css', '.sql',
]);

const EXTRACTABLE_EXTENSIONS = new Set(['.docx', '.pdf']);

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

/**
 * Add "🤔思考中" emoji reaction to a message.
 * Silently fails — never throws.
 */
export async function addThinkingEmoji(robotCode, msgId, conversationId) {
  try {
    await apiRequestV2('POST', '/v1.0/robot/emotion/reply', {
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
    }, { timeout: 5000 });
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
    await apiRequestV2('POST', '/v1.0/robot/emotion/recall', {
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
    }, { timeout: 5000 });
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

  // Step 1: Exchange downloadCode for download URL
  const result = await apiRequestV2('POST', '/v1.0/robot/messageFiles/download', {
    downloadCode,
    robotCode: creds.robot_code,
  }, { timeout: 15000 });

  const downloadUrl = result?.downloadUrl;
  if (!downloadUrl) {
    throw new Error('No downloadUrl in response');
  }

  // Step 2: Download the file
  const safeName = `${Date.now()}-${(fileName || 'file').replace(/[/\\:*?"<>|]/g, '_')}`;
  const localPath = path.join(MEDIA_DIR, safeName);

  const res = await axios({
    method: 'GET',
    url: downloadUrl,
    responseType: 'arraybuffer',
    timeout: 60000,
  });

  fs.writeFileSync(localPath, res.data);
  console.log(`[dingtalk] File downloaded: ${localPath} (${res.data.length} bytes)`);
  return localPath;
}

/**
 * Extract text content from a downloaded file.
 * Supports: text files, .docx (mammoth), .pdf (pdf-parse).
 * Returns extracted text or null if not extractable.
 */
export async function extractFileContent(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);

  try {
    // Text files — direct read
    if (TEXT_FILE_EXTENSIONS.has(ext)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return truncateContent(content, fileName);
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
