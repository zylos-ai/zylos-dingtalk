/**
 * Tests for scripts/send.js helper functions.
 *
 * Tests import shared modules (retry.js) directly — the same code
 * used by production. Pure helper logic (chunkMessage, validateResponse,
 * queue management) is replicated here since send.js is a CLI entry point.
 */

import { jest } from '@jest/globals';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { isRetryable, withRetry } from '../src/lib/retry.js';

// ─── validateResponse (matches send.js implementation) ──────────────────────
// DingTalk V1 responses use numeric errcode (0 = success).
// V2 responses use string code (absent or "0" = success, non-zero string = error).

function validateResponse(res, context) {
  if (res?.errcode && res.errcode !== 0) {
    const msg = `${context}: ${res.errmsg || 'unknown error'} (errcode=${res.errcode})`;
    throw new Error(msg);
  }
  if (res?.code && String(res.code) !== '0') {
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

  test('passes on string "0" code (V2 success variant)', () => {
    expect(() => validateResponse({ code: '0' }, 'test')).not.toThrow();
  });

  test('passes on numeric 0 code', () => {
    expect(() => validateResponse({ code: 0 }, 'test')).not.toThrow();
  });
});

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
    // Use fast baseDelay for tests
    const upload = () => withRetry(async () => {
      // This simulates the fixed code: FormData + stream created inside retry
      const stream = createStream();
      callCount++;
      if (callCount <= 2) throw err429;
      return { data: { errcode: 0, media_id: 'mid-123' } };
    }, 'media-upload', { baseDelay: 1 });

    const result = await upload();
    expect(result.data.media_id).toBe('mid-123');
    expect(streamCreateCount).toBe(3); // stream recreated each attempt
    expect(callCount).toBe(3);
  });
});

// ─── chunkMessage (matches send.js implementation) ──────────────────────────

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

// ─── Queue management (inline re-implementation) ───────────────────────────────

const QUEUE_MAX = 10;

describe('queue management', () => {
  let queueFile;

  function readQueue() {
    try {
      return JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    } catch {
      return [];
    }
  }

  function writeQueue(queue) {
    fs.writeFileSync(queueFile, JSON.stringify(queue), 'utf8');
  }

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

  function enqueue(item) {
    const queue = readQueue();
    queue.push(item);
    while (queue.length > QUEUE_MAX) queue.shift();
    writeQueue(queue);
  }

  beforeEach(() => {
    queueFile = path.join(os.tmpdir(), `.send-queue-test-${Date.now()}.json`);
  });

  afterEach(() => {
    try { fs.unlinkSync(queueFile); } catch {}
  });

  test('readQueue returns empty array when file missing', () => {
    expect(readQueue()).toEqual([]);
  });

  test('enqueue adds items and persists to file', () => {
    enqueue({ endpoint: 'user1|type:p2p', message: 'hello', attempts: 0, createdAt: Date.now() });
    const queue = readQueue();
    expect(queue.length).toBe(1);
    expect(queue[0].message).toBe('hello');
  });

  test('enqueue respects FIFO max of 10', () => {
    for (let i = 0; i < 12; i++) {
      enqueue({ endpoint: `user${i}|type:p2p`, message: `msg-${i}`, attempts: 0, createdAt: Date.now() });
    }
    const queue = readQueue();
    expect(queue.length).toBe(QUEUE_MAX);
    // Oldest two (msg-0, msg-1) should be dropped
    expect(queue[0].message).toBe('msg-2');
    expect(queue[9].message).toBe('msg-11');
  });

  test('queue items preserve endpoint and message', () => {
    const item = { endpoint: 'staff123|type:p2p|msg:abc', message: 'test content', attempts: 0, createdAt: Date.now() };
    enqueue(item);
    const queue = readQueue();
    expect(queue[0].endpoint).toBe('staff123|type:p2p|msg:abc');
    expect(queue[0].message).toBe('test content');
    const ep = parseEndpoint(queue[0].endpoint);
    expect(ep.id).toBe('staff123');
    expect(ep.type).toBe('p2p');
  });

  test('multiple enqueues maintain order', () => {
    enqueue({ endpoint: 'a|type:p2p', message: 'first', attempts: 0, createdAt: 1000 });
    enqueue({ endpoint: 'b|type:p2p', message: 'second', attempts: 0, createdAt: 2000 });
    enqueue({ endpoint: 'c|type:p2p', message: 'third', attempts: 0, createdAt: 3000 });
    const queue = readQueue();
    expect(queue.map(q => q.message)).toEqual(['first', 'second', 'third']);
  });
});

// ─── isRetryable (imported from shared module) ──────────────────────────────

describe('isRetryable', () => {
  test('returns true for HTTP 429', () => {
    const err = new Error('429');
    err.response = { status: 429 };
    expect(isRetryable(err)).toBe(true);
  });

  test('returns true for DingTalk Throttling code', () => {
    const err = new Error('throttled');
    err.response = { status: 200, data: { code: 'Throttling' } };
    expect(isRetryable(err)).toBe(true);
  });

  test('returns true for ECONNREFUSED', () => {
    const err = new Error('connect');
    err.code = 'ECONNREFUSED';
    expect(isRetryable(err)).toBe(true);
  });

  test('returns true for ETIMEDOUT', () => {
    const err = new Error('timeout');
    err.code = 'ETIMEDOUT';
    expect(isRetryable(err)).toBe(true);
  });

  test('returns true for ECONNRESET', () => {
    const err = new Error('reset');
    err.code = 'ECONNRESET';
    expect(isRetryable(err)).toBe(true);
  });

  test('returns true for EAI_AGAIN', () => {
    const err = new Error('dns');
    err.code = 'EAI_AGAIN';
    expect(isRetryable(err)).toBe(true);
  });

  test('returns false for auth errors', () => {
    const err = new Error('unauthorized');
    err.response = { status: 401 };
    expect(isRetryable(err)).toBe(false);
  });

  test('returns false for generic errors', () => {
    expect(isRetryable(new Error('missing config'))).toBe(false);
  });
});

// ─── withRetry (imported from shared module) ────────────────────────────────

describe('withRetry', () => {
  test('returns result on success', async () => {
    const result = await withRetry(() => Promise.resolve('ok'), 'test', { baseDelay: 1 });
    expect(result).toBe('ok');
  });

  test('retries on retryable error and succeeds', async () => {
    let calls = 0;
    const err = new Error('timeout');
    err.code = 'ETIMEDOUT';
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw err;
      return 'recovered';
    }, 'test', { baseDelay: 1 });
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });

  test('throws immediately on non-retryable error', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw new Error('auth failure');
    }, 'test', { baseDelay: 1 })).rejects.toThrow('auth failure');
    expect(calls).toBe(1);
  });
});
