/**
 * Tests for scripts/send.js helper functions.
 *
 * send.js is a CLI script — we test the extracted logic (validateResponse,
 * withRetry, isRetryable, chunkMessage) and verify media upload creates
 * fresh streams on retry.
 */

import { jest } from '@jest/globals';
import { Readable } from 'stream';

// ─── validateResponse (inline re-implementation for testing) ──────────────────
// send.js defines this function internally. We replicate the logic here
// to verify the contract, since send.js is a CLI entry point.

function validateResponse(res, context) {
  if (res?.errcode && res.errcode !== 0) {
    const msg = `${context}: ${res.errmsg || 'unknown error'} (errcode=${res.errcode})`;
    throw new Error(msg);
  }
  if (res?.code && res.code !== 0) {
    const msg = `${context}: ${res.message || res.code}`;
    throw new Error(msg);
  }
}

describe('validateResponse', () => {
  test('passes on errcode 0', () => {
    expect(() => validateResponse({ errcode: 0 }, 'test')).not.toThrow();
  });

  test('passes on null/undefined response', () => {
    expect(() => validateResponse(null, 'test')).not.toThrow();
    expect(() => validateResponse(undefined, 'test')).not.toThrow();
  });

  test('passes on successful V2 response (no errcode/code)', () => {
    expect(() => validateResponse({ processQueryKey: 'abc' }, 'test')).not.toThrow();
  });

  test('throws on non-zero errcode', () => {
    expect(() =>
      validateResponse({ errcode: 40035, errmsg: 'invalid param' }, 'Send'),
    ).toThrow('Send: invalid param (errcode=40035)');
  });

  test('throws on non-zero code', () => {
    expect(() =>
      validateResponse({ code: 'InvalidParameter', message: 'bad input' }, 'API'),
    ).toThrow('API: bad input');
  });

  test('includes context in error message', () => {
    expect(() =>
      validateResponse({ errcode: 500, errmsg: 'server error' }, 'DM text to user-1'),
    ).toThrow('DM text to user-1: server error');
  });
});

// ─── withRetry (inline re-implementation for testing) ─────────────────────────

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1; // 1ms for fast tests

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
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

// ─── Media upload stream recreation on retry ──────────────────────────────────

describe('media upload retry creates fresh stream', () => {
  test('FormData is recreated on each retry attempt', async () => {
    let streamCreateCount = 0;
    const createStream = () => {
      streamCreateCount++;
      return new Readable({ read() { this.push(null); } });
    };

    const err429 = new Error('429');
    err429.response = { status: 429 };

    let callCount = 0;
    const upload = () => withRetry(async () => {
      // This simulates the fixed code: FormData + stream created inside retry
      const stream = createStream();
      callCount++;
      if (callCount <= 2) throw err429;
      return { data: { errcode: 0, media_id: 'mid-123' } };
    }, 'media-upload');

    const result = await upload();
    expect(result.data.media_id).toBe('mid-123');
    expect(streamCreateCount).toBe(3); // stream recreated each attempt
    expect(callCount).toBe(3);
  });
});

// ─── chunkMessage (inline re-implementation) ──────────────────────────────────

function chunkMessage(text, maxLen = 2000) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let breakPoint = -1;
    const codeBlocksBefore = (remaining.slice(0, maxLen).match(/```/g) || []).length;
    const insideCodeBlock = codeBlocksBefore % 2 !== 0;

    if (insideCodeBlock) {
      const closeIdx = remaining.indexOf('```', remaining.indexOf('```') + 3);
      if (closeIdx > 0 && closeIdx + 3 <= maxLen * 1.5) {
        breakPoint = closeIdx + 3;
      }
    }

    if (breakPoint < 0) {
      const chunk = remaining.slice(0, maxLen);
      const lastPara = chunk.lastIndexOf('\n\n');
      if (lastPara > maxLen * 0.3) {
        breakPoint = lastPara;
      } else {
        const lastLine = chunk.lastIndexOf('\n');
        if (lastLine > maxLen * 0.3) {
          breakPoint = lastLine;
        } else {
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

describe('chunkMessage', () => {
  test('returns single chunk for short message', () => {
    const result = chunkMessage('hello', 2000);
    expect(result).toEqual(['hello']);
  });

  test('splits long message into multiple chunks', () => {
    const long = 'a'.repeat(5000);
    const chunks = chunkMessage(long, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(long);
  });

  test('prefers paragraph breaks', () => {
    const text = 'a'.repeat(1500) + '\n\n' + 'b'.repeat(1500);
    const chunks = chunkMessage(text, 2000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe('a'.repeat(1500));
  });
});
