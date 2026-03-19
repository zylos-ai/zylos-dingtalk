import { jest } from '@jest/globals';

// Mock config before importing client
const mockCredentials = { app_key: 'test-key', app_secret: 'test-secret', robot_code: 'test-robot' };
jest.unstable_mockModule('../src/lib/config.js', () => ({
  getCredentials: () => mockCredentials,
}));

// Mock axios
const mockAxios = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: mockAxios }));

const { getAccessToken, resetToken, apiRequestV1, apiRequestV2, withRetry, isRetryable } =
  await import('../src/lib/client.js');

beforeEach(() => {
  jest.clearAllMocks();
  resetToken();
});

// ─── isRetryable ──────────────────────────────────────────────────────────────

describe('isRetryable', () => {
  test('returns true for HTTP 429', () => {
    const err = new Error('throttled');
    err.response = { status: 429 };
    expect(isRetryable(err)).toBe(true);
  });

  test('returns true for DingTalk Throttling code', () => {
    const err = new Error('throttled');
    err.response = { status: 200, data: { code: 'Throttling' } };
    expect(isRetryable(err)).toBe(true);
  });

  test('returns true for ECONNREFUSED', () => {
    const err = new Error('refused');
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

  test('returns true for HTTP 503 (fuse/circuit breaker)', () => {
    const err = new Error('fused');
    err.response = { status: 503, data: { code: 'ServiceUnavailable' } };
    expect(isRetryable(err)).toBe(true);
  });

  test('returns true for ServiceUnavailable code', () => {
    const err = new Error('service unavailable');
    err.response = { status: 200, data: { code: 'ServiceUnavailable' } };
    expect(isRetryable(err)).toBe(true);
  });

  test('returns true for EAI_AGAIN', () => {
    const err = new Error('dns');
    err.code = 'EAI_AGAIN';
    expect(isRetryable(err)).toBe(true);
  });

  test('returns true for ENOTFOUND', () => {
    const err = new Error('dns not found');
    err.code = 'ENOTFOUND';
    expect(isRetryable(err)).toBe(true);
  });

  test('returns false for auth error', () => {
    const err = new Error('auth failed');
    err.response = { status: 401 };
    expect(isRetryable(err)).toBe(false);
  });

  test('returns false for generic error', () => {
    expect(isRetryable(new Error('something'))).toBe(false);
  });
});

// ─── withRetry ────────────────────────────────────────────────────────────────

describe('withRetry', () => {
  test('returns result on first success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, 'test');
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on 429 and succeeds', async () => {
    const err429 = new Error('429');
    err429.response = { status: 429 };
    const fn = jest.fn()
      .mockRejectedValueOnce(err429)
      .mockResolvedValue('ok');

    const result = await withRetry(fn, 'test');
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('retries on transient network error and succeeds', async () => {
    const errNet = new Error('connection refused');
    errNet.code = 'ECONNREFUSED';
    const fn = jest.fn()
      .mockRejectedValueOnce(errNet)
      .mockRejectedValueOnce(errNet)
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, 'test');
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('throws after max retries exhausted', async () => {
    const err429 = new Error('429');
    err429.response = { status: 429 };
    const fn = jest.fn().mockRejectedValue(err429);

    await expect(withRetry(fn, 'test')).rejects.toThrow('429');
    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  }, 30000);

  test('retries on 503 fuse and succeeds', async () => {
    const err503 = new Error('fused');
    err503.response = { status: 503, data: { code: 'ServiceUnavailable', message: 'The request has failed due to fused.' } };
    const fn = jest.fn()
      .mockRejectedValueOnce(err503)
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, 'test');
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('throws immediately on non-retryable error', async () => {
    const authErr = new Error('forbidden');
    authErr.response = { status: 403 };
    const fn = jest.fn().mockRejectedValue(authErr);

    await expect(withRetry(fn, 'test')).rejects.toThrow('forbidden');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ─── getAccessToken ───────────────────────────────────────────────────────────

describe('getAccessToken', () => {
  test('fetches and caches token', async () => {
    mockAxios.mockResolvedValueOnce({
      data: { errcode: 0, access_token: 'tok-123', expires_in: 7200 },
    });

    const token = await getAccessToken();
    expect(token).toBe('tok-123');
    expect(mockAxios).toHaveBeenCalledTimes(1);

    // Second call should use cache
    const token2 = await getAccessToken();
    expect(token2).toBe('tok-123');
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  test('throws on token error', async () => {
    mockAxios.mockResolvedValueOnce({
      data: { errcode: 40001, errmsg: 'invalid appkey' },
    });

    await expect(getAccessToken()).rejects.toThrow('Token error: invalid appkey');
  });

  test('refreshes after resetToken', async () => {
    mockAxios
      .mockResolvedValueOnce({ data: { errcode: 0, access_token: 'tok-1', expires_in: 7200 } })
      .mockResolvedValueOnce({ data: { errcode: 0, access_token: 'tok-2', expires_in: 7200 } });

    await getAccessToken();
    resetToken();
    const token = await getAccessToken();
    expect(token).toBe('tok-2');
    expect(mockAxios).toHaveBeenCalledTimes(2);
  });
});

// ─── apiRequestV1 ─────────────────────────────────────────────────────────────

describe('apiRequestV1', () => {
  test('returns data on success', async () => {
    // gettoken call, then the actual API call
    mockAxios
      .mockResolvedValueOnce({ data: { errcode: 0, access_token: 'tok', expires_in: 7200 } })
      .mockResolvedValueOnce({ data: { errcode: 0, userid: '123' } });

    const result = await apiRequestV1('GET', '/user/get');
    expect(result).toEqual({ errcode: 0, userid: '123' });
  });

  test('retries on token expired (42001)', async () => {
    mockAxios
      // gettoken
      .mockResolvedValueOnce({ data: { errcode: 0, access_token: 'tok-old', expires_in: 7200 } })
      // API returns expired
      .mockResolvedValueOnce({ data: { errcode: 42001, errmsg: 'token expired' } })
      // resetToken + gettoken again
      .mockResolvedValueOnce({ data: { errcode: 0, access_token: 'tok-new', expires_in: 7200 } })
      // API retry succeeds
      .mockResolvedValueOnce({ data: { errcode: 0, result: 'ok' } });

    const result = await apiRequestV1('GET', '/test');
    expect(result).toEqual({ errcode: 0, result: 'ok' });
  });

  test('retries on throttling (errcode 88)', async () => {
    mockAxios
      // gettoken
      .mockResolvedValueOnce({ data: { errcode: 0, access_token: 'tok', expires_in: 7200 } })
      // API returns throttled
      .mockResolvedValueOnce({ data: { errcode: 88, errmsg: 'Throttling limit reached' } })
      // withRetry retries — token is still cached, so just the API call
      .mockResolvedValueOnce({ data: { errcode: 0, result: 'ok' } });

    const result = await apiRequestV1('GET', '/test');
    expect(result).toEqual({ errcode: 0, result: 'ok' });
  });
});

// ─── apiRequestV2 ─────────────────────────────────────────────────────────────

describe('apiRequestV2', () => {
  test('retries on InvalidAuthentication', async () => {
    mockAxios
      // gettoken
      .mockResolvedValueOnce({ data: { errcode: 0, access_token: 'tok-old', expires_in: 7200 } })
      // API returns invalid auth
      .mockResolvedValueOnce({ data: { code: 'InvalidAuthentication', message: 'bad token' } })
      // resetToken + gettoken
      .mockResolvedValueOnce({ data: { errcode: 0, access_token: 'tok-new', expires_in: 7200 } })
      // API retry succeeds
      .mockResolvedValueOnce({ data: { processQueryKey: 'abc123' } });

    const result = await apiRequestV2('POST', '/v1.0/robot/oToMessages/batchSend', { test: 1 });
    expect(result).toEqual({ processQueryKey: 'abc123' });
  });

  test('retries on Throttling response code', async () => {
    mockAxios
      // gettoken
      .mockResolvedValueOnce({ data: { errcode: 0, access_token: 'tok', expires_in: 7200 } })
      // API returns throttled
      .mockResolvedValueOnce({ data: { code: 'Throttling', message: 'rate limited' } })
      // withRetry retries — token cached
      .mockResolvedValueOnce({ data: { processQueryKey: 'ok' } });

    const result = await apiRequestV2('POST', '/v1.0/test', {});
    expect(result).toEqual({ processQueryKey: 'ok' });
  });

  test('returns data on success', async () => {
    mockAxios
      .mockResolvedValueOnce({ data: { errcode: 0, access_token: 'tok', expires_in: 7200 } })
      .mockResolvedValueOnce({ data: { processQueryKey: 'pqk-1' } });

    const result = await apiRequestV2('POST', '/v1.0/test', { foo: 1 });
    expect(result).toEqual({ processQueryKey: 'pqk-1' });
  });
});
