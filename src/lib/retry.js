/**
 * Shared retry logic for DingTalk API calls.
 *
 * Single source of truth — imported by client.js, send.js, and tests.
 */

export const MAX_RETRIES = 3;
export const RETRY_BASE_DELAY = 1000; // 1s, 2s, 4s

/**
 * Check if an error is retryable (throttle or transient network).
 */
export function isRetryable(err) {
  const status = err.response?.status;
  if (status === 429) return true;
  if (status === 503) return true; // DingTalk circuit breaker / fuse
  if (err.response?.data?.code === 'Throttling') return true;
  if (err.response?.data?.code === 'ServiceUnavailable') return true;
  const code = err.code;
  return code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EAI_AGAIN';
}

/**
 * Execute an async function with exponential backoff retry on throttle/transient errors.
 */
export async function withRetry(fn, context = '', { maxRetries = MAX_RETRIES, baseDelay = RETRY_BASE_DELAY } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries && isRetryable(err)) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.warn(`[dingtalk] ${context} retryable error (attempt ${attempt + 1}/${maxRetries}): ${err.message}. Retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}
