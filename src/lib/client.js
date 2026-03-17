import axios from 'axios';
import { getCredentials } from './config.js';

const DINGTALK_API_V1 = 'https://oapi.dingtalk.com';
const DINGTALK_API_V2 = 'https://api.dingtalk.com';

const TOKEN_REFRESH_MARGIN = 5 * 60 * 1000; // refresh 5 min before expiry
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000; // 1s, 2s, 4s

/**
 * Check if an error is retryable (throttle or transient network).
 */
function isRetryable(err) {
  if (err.response?.status === 429) return true;
  if (err.response?.data?.code === 'Throttling') return true;
  const code = err.code;
  return code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EAI_AGAIN';
}

/**
 * Execute an async function with exponential backoff retry on throttle/transient errors.
 */
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

let cachedToken = null;
let tokenExpiresAt = 0;

export async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - TOKEN_REFRESH_MARGIN) {
    return cachedToken;
  }

  const creds = getCredentials();
  if (!creds.app_key || !creds.app_secret) {
    throw new Error('DINGTALK_APP_KEY and DINGTALK_APP_SECRET are required');
  }

  const res = await axios({
    method: 'GET',
    url: `${DINGTALK_API_V1}/gettoken`,
    params: { appkey: creds.app_key, appsecret: creds.app_secret },
    timeout: 15000,
  });

  if (res.data.errcode !== 0) {
    throw new Error(`Token error: ${res.data.errmsg} (${res.data.errcode})`);
  }

  cachedToken = res.data.access_token;
  tokenExpiresAt = now + (res.data.expires_in * 1000);
  console.log('[dingtalk] Access token refreshed');
  return cachedToken;
}

export function resetToken() {
  cachedToken = null;
  tokenExpiresAt = 0;
}

/**
 * Make an API request to DingTalk old API (oapi.dingtalk.com).
 * Token passed as query param.
 */
export async function apiRequestV1(method, apiPath, data = null, options = {}) {
  return withRetry(async () => {
    const token = await getAccessToken();
    const axiosConfig = {
      method,
      url: `${DINGTALK_API_V1}${apiPath}`,
      params: { access_token: token, ...(options.params || {}) },
      timeout: options.timeout || 30000,
    };

    if (data && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
      axiosConfig.data = data;
    }

    let res = await axios(axiosConfig);

    // Retry once on invalid token
    if (res.data.errcode === 42001 || res.data.errcode === 40014) {
      resetToken();
      const freshToken = await getAccessToken();
      axiosConfig.params.access_token = freshToken;
      res = await axios(axiosConfig);
    }

    // Throw on throttling so withRetry can handle it
    if (res.data.errcode === 88 || res.data.errmsg?.includes('Throttling')) {
      const err = new Error(`Throttled: ${res.data.errmsg}`);
      err.response = { status: 429, data: res.data };
      throw err;
    }

    return res.data;
  }, `V1 ${method} ${apiPath}`);
}

/**
 * Make an API request to DingTalk new API (api.dingtalk.com).
 * Token passed in header.
 */
export async function apiRequestV2(method, apiPath, data = null, options = {}) {
  return withRetry(async () => {
    const token = await getAccessToken();
    const axiosConfig = {
      method,
      url: `${DINGTALK_API_V2}${apiPath}`,
      headers: {
        'x-acs-dingtalk-access-token': token,
        ...(options.headers || {}),
      },
      timeout: options.timeout || 30000,
    };

    if (data && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
      axiosConfig.data = data;
    }

    let res = await axios(axiosConfig);

    // Retry once on invalid/expired token
    if (res.data?.code === 'InvalidAuthentication' || res.data?.code === 'ForbiddenByDeniedPermission') {
      console.warn(`[dingtalk] V2 token error (${res.data.code}), refreshing and retrying`);
      resetToken();
      const freshToken = await getAccessToken();
      axiosConfig.headers['x-acs-dingtalk-access-token'] = freshToken;
      res = await axios(axiosConfig);
    }

    // Throw on throttling so withRetry can handle it
    if (res.data?.code === 'Throttling') {
      const err = new Error(`Throttled: ${res.data.message || res.data.code}`);
      err.response = { status: 429, data: res.data };
      throw err;
    }

    return res.data;
  }, `V2 ${method} ${apiPath}`);
}

// Export for use in send.js standalone
export { withRetry, isRetryable };
