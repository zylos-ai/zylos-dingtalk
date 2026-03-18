import { jest } from '@jest/globals';

// Mock config
const mockCredentials = { app_key: 'k', app_secret: 's', robot_code: 'robot-123' };
jest.unstable_mockModule('../src/lib/config.js', () => ({
  getCredentials: () => mockCredentials,
  DATA_DIR: '/tmp/test-dingtalk',
}));

// Mock axios
const mockAxios = jest.fn();
mockAxios.post = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: mockAxios }));

// Pre-seed token for all tests
mockAxios.mockResolvedValueOnce({
  data: { errcode: 0, access_token: 'test-token', expires_in: 7200 },
});

const {
  replyViaWebhook,
  sendDM, sendGroup,
  sendTextDM, sendMarkdownDM,
  sendTextGroup, sendMarkdownGroup,
} = await import('../src/lib/message.js');
const { getAccessToken } = await import('../src/lib/client.js');

// Initialize token cache
await getAccessToken();

beforeEach(() => {
  mockAxios.post.mockReset();
});

// ─── replyViaWebhook ─────────────────────────────────────────────────────────

describe('replyViaWebhook', () => {
  test('returns data on success', async () => {
    mockAxios.post.mockResolvedValueOnce({ data: { errcode: 0 } });

    const result = await replyViaWebhook('https://webhook.url', 'text', { text: { content: 'hi' } });
    expect(result).toEqual({ errcode: 0 });
    expect(mockAxios.post).toHaveBeenCalledWith(
      'https://webhook.url',
      expect.objectContaining({ msgtype: 'text' }),
      expect.any(Object),
    );
  });

  test('throws on errcode non-zero', async () => {
    mockAxios.post.mockResolvedValueOnce({
      data: { errcode: 40035, errmsg: 'invalid parameter' },
    });

    await expect(
      replyViaWebhook('https://webhook.url', 'text', { text: { content: 'hi' } }),
    ).rejects.toThrow('Webhook reply failed: invalid parameter');
  });
});

// ─── sendDM ───────────────────────────────────────────────────────────────────

describe('sendDM', () => {
  test('returns result on success', async () => {
    // apiRequestV2 uses mockAxios (the default export)
    mockAxios.mockResolvedValueOnce({
      data: { processQueryKey: 'pqk-123' },
    });

    const result = await sendDM('user-1', 'sampleText', { content: 'hello' });
    expect(result).toEqual({ processQueryKey: 'pqk-123' });
  });

  test('throws on error code in response', async () => {
    mockAxios.mockResolvedValueOnce({
      data: { code: 'InvalidParameter', message: 'userIds is empty' },
    });

    await expect(
      sendDM('user-1', 'sampleText', { content: 'hello' }),
    ).rejects.toThrow('DM send failed');
  });
});

// ─── sendGroup ────────────────────────────────────────────────────────────────

describe('sendGroup', () => {
  test('returns result on success', async () => {
    mockAxios.mockResolvedValueOnce({
      data: { processQueryKey: 'pqk-456' },
    });

    const result = await sendGroup('conv-1', 'sampleText', { content: 'hello' });
    expect(result).toEqual({ processQueryKey: 'pqk-456' });
  });

  test('throws on error code in response', async () => {
    mockAxios.mockResolvedValueOnce({
      data: { code: 'Forbidden', message: 'no permission' },
    });

    await expect(
      sendGroup('conv-1', 'sampleText', { content: 'hello' }),
    ).rejects.toThrow('Group send failed');
  });
});

// ─── sendTextDM / sendMarkdownDM ─────────────────────────────────────────────

describe('sendTextDM', () => {
  test('delegates to sendDM with sampleText', async () => {
    mockAxios.mockResolvedValueOnce({
      data: { processQueryKey: 'pqk-txt' },
    });

    const result = await sendTextDM('user-2', 'hi there');
    expect(result).toEqual({ processQueryKey: 'pqk-txt' });
  });
});

describe('sendMarkdownDM', () => {
  test('delegates to sendDM with sampleMarkdown', async () => {
    mockAxios.mockResolvedValueOnce({
      data: { processQueryKey: 'pqk-md' },
    });

    const result = await sendMarkdownDM('user-3', 'Title', '**bold**');
    expect(result).toEqual({ processQueryKey: 'pqk-md' });
  });
});

// ─── sendTextGroup / sendMarkdownGroup ───────────────────────────────────────

describe('sendTextGroup', () => {
  test('delegates to sendGroup with sampleText', async () => {
    mockAxios.mockResolvedValueOnce({
      data: { processQueryKey: 'pqk-grp-txt' },
    });

    const result = await sendTextGroup('conv-2', 'hello group');
    expect(result).toEqual({ processQueryKey: 'pqk-grp-txt' });
  });
});

describe('sendMarkdownGroup', () => {
  test('delegates to sendGroup with sampleMarkdown', async () => {
    mockAxios.mockResolvedValueOnce({
      data: { processQueryKey: 'pqk-grp-md' },
    });

    const result = await sendMarkdownGroup('conv-3', 'Title', '# heading');
    expect(result).toEqual({ processQueryKey: 'pqk-grp-md' });
  });
});
