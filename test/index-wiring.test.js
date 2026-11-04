/**
 * Wiring tests for src/index.js: drives the real Stream message handler with
 * mocked SDK / network / C4 boundaries and checks that access control stops
 * or continues processing, and that notices and the owner guide are sent.
 */

import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-wiring-'));
process.env.DINGTALK_INTERNAL_PORT = String(45000 + Math.floor(Math.random() * 10000));

const { GROUP_NOT_ENABLED_NOTICE, GROUP_NO_PERMISSION_NOTICE, OWNER_GUIDE_TEXT } =
  await import('../src/lib/access.js');

// ─── Mocks ───────────────────────────────────────────────────────────────────

let testConfig;
let configWatcher = null;
const mockSaveConfig = jest.fn(() => true);

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    owner: { bound: true, staff_id: 'owner1', name: 'Owner' },
    dmPolicy: 'owner',
    dmAllowFrom: [],
    groupPolicy: 'allowlist',
    groups: {},
    message: { context_messages: 5 },
    ...overrides,
  };
}
testConfig = baseConfig();

jest.unstable_mockModule('dotenv', () => ({ default: { config: () => ({}) } }));

jest.unstable_mockModule('../src/lib/config.js', () => ({
  getConfig: () => testConfig,
  saveConfig: mockSaveConfig,
  watchConfig: (cb) => { configWatcher = cb; },
  stopWatching: () => {},
  getCredentials: () => ({ app_key: 'k', app_secret: 's', robot_code: 'r' }),
  DATA_DIR: TEST_DATA_DIR,
}));

jest.unstable_mockModule('../src/lib/contact.js', () => ({
  getUserInfo: jest.fn(async () => ({ success: false })),
}));

const mockReplyText = jest.fn(async () => ({}));
const mockSendTextDM = jest.fn(async () => ({}));
const mockAddThinkingEmoji = jest.fn(async () => {});
jest.unstable_mockModule('../src/lib/message.js', () => ({
  addThinkingEmoji: mockAddThinkingEmoji,
  recallThinkingEmoji: jest.fn(async () => {}),
  downloadFileByCode: jest.fn(),
  extractFileContent: jest.fn(),
  cleanupMediaCache: jest.fn(),
  replyText: mockReplyText,
  sendTextDM: mockSendTextDM,
}));

const mockExecFile = jest.fn((cmd, args, opts, cb) => { if (cb) cb(null, '', ''); });
jest.unstable_mockModule('child_process', () => ({ execFile: mockExecFile }));

let robotHandler = null;
class FakeDWClient {
  constructor() { this.socket = null; }
  registerCallbackListener(topic, cb) { robotHandler = cb; }
  registerAllEventListener() {}
  socketCallBackResponse() {}
  getEndpoint() { return new Promise(() => {}); } // never connects
  disconnect() {}
}
jest.unstable_mockModule('dingtalk-stream', () => ({
  DWClient: FakeDWClient,
  TOPIC_ROBOT: '/v1.0/im/bot/messages/get',
}));

const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

await import('../src/index.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

let seq = 0;
function groupMsg(overrides = {}) {
  seq++;
  return {
    msgId: `g${seq}`,
    senderStaffId: 'u1',
    senderNick: 'User One',
    conversationType: '2',
    conversationId: 'cid1',
    conversationTitle: 'Team',
    msgtype: 'text',
    text: { content: 'hello' },
    sessionWebhook: 'https://hook/group',
    sessionWebhookExpiredTime: Date.now() + 600000,
    isInAtList: true,
    ...overrides,
  };
}

function dmMsg(overrides = {}) {
  seq++;
  return {
    msgId: `d${seq}`,
    senderStaffId: 'owner1',
    senderNick: 'Owner',
    conversationType: '1',
    conversationId: 'dmcid',
    msgtype: 'text',
    text: { content: 'hi' },
    sessionWebhook: 'https://hook/dm',
    sessionWebhookExpiredTime: Date.now() + 600000,
    ...overrides,
  };
}

// Dispatch without awaiting: allowed messages wait 3s for the emoji in `finally`.
async function dispatch(msg) {
  robotHandler({ headers: { messageId: `stream-${msg.msgId}` }, data: JSON.stringify(msg) });
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
}

function setConfig(cfg) {
  testConfig = cfg;
  configWatcher(cfg);
}

const forwarded = () => mockExecFile.mock.calls.length;

beforeEach(() => {
  mockReplyText.mockReset().mockResolvedValue({});
  mockSendTextDM.mockReset().mockResolvedValue({});
  mockExecFile.mockClear();
  mockAddThinkingEmoji.mockClear();
  mockSaveConfig.mockClear();
});

afterAll(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  warnSpy.mockRestore();
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
});

// ─── Group access ────────────────────────────────────────────────────────────

describe('group access wiring', () => {
  test('handler was registered', () => {
    expect(typeof robotHandler).toBe('function');
  });

  test('blocked mention in a not-enabled group -> one notice, not forwarded', async () => {
    setConfig(baseConfig({ groupPolicy: 'allowlist', groups: {} }));
    await dispatch(groupMsg());
    expect(mockReplyText).toHaveBeenCalledTimes(1);
    expect(mockReplyText).toHaveBeenCalledWith('https://hook/group', GROUP_NOT_ENABLED_NOTICE);
    expect(forwarded()).toBe(0);
    expect(mockAddThinkingEmoji).not.toHaveBeenCalled();
  });

  test('blocked mention with groupPolicy disabled -> not-enabled notice, not forwarded', async () => {
    setConfig(baseConfig({ groupPolicy: 'disabled' }));
    await dispatch(groupMsg());
    expect(mockReplyText).toHaveBeenCalledWith('https://hook/group', GROUP_NOT_ENABLED_NOTICE);
    expect(forwarded()).toBe(0);
  });

  test('blocked mention by non-allowed sender -> no-permission notice, not forwarded', async () => {
    setConfig(baseConfig({ groups: { cid1: { name: 'Team', allowFrom: ['u2'] } } }));
    await dispatch(groupMsg());
    expect(mockReplyText).toHaveBeenCalledTimes(1);
    expect(mockReplyText).toHaveBeenCalledWith('https://hook/group', GROUP_NO_PERMISSION_NOTICE);
    expect(forwarded()).toBe(0);
  });

  test('blocked non-mention -> no notice, not forwarded', async () => {
    setConfig(baseConfig({ groups: {} }));
    await dispatch(groupMsg({ isInAtList: false }));
    expect(mockReplyText).not.toHaveBeenCalled();
    expect(forwarded()).toBe(0);
  });

  test('allowed group mention -> forwarded to C4, no notice', async () => {
    setConfig(baseConfig({ groups: { cid1: { name: 'Team', allowFrom: [] } } }));
    await dispatch(groupMsg());
    expect(mockReplyText).not.toHaveBeenCalled();
    expect(forwarded()).toBe(1);
    expect(mockExecFile.mock.calls[0][1]).toEqual(expect.arrayContaining(['--endpoint', expect.stringMatching(/^cid1\|type:group/)]));
  });

  test('owner in a not-enabled group -> forwarded (owner bypass), no notice', async () => {
    setConfig(baseConfig({ groups: {} }));
    await dispatch(groupMsg({ senderStaffId: 'owner1' }));
    expect(mockReplyText).not.toHaveBeenCalled();
    expect(forwarded()).toBe(1);
  });

  test('notice send failure is swallowed and does not forward', async () => {
    setConfig(baseConfig({ groups: {} }));
    mockReplyText.mockRejectedValue(new Error('boom'));
    await dispatch(groupMsg());
    expect(mockReplyText).toHaveBeenCalledTimes(1);
    expect(forwarded()).toBe(0);
  });
});

// ─── Owner binding + guide ───────────────────────────────────────────────────

describe('owner bind wiring', () => {
  test('first DM binds owner, sends guide once and forwards; second DM sends no guide', async () => {
    setConfig(baseConfig({ owner: { bound: false, staff_id: '', name: '' } }));
    await dispatch(dmMsg({ senderStaffId: 'boss', senderNick: 'Boss' }));
    expect(mockSaveConfig).toHaveBeenCalledTimes(1);
    expect(testConfig.owner).toEqual({ bound: true, staff_id: 'boss', name: 'Boss' });
    expect(mockReplyText).toHaveBeenCalledTimes(1);
    expect(mockReplyText).toHaveBeenCalledWith('https://hook/dm', OWNER_GUIDE_TEXT);
    expect(forwarded()).toBe(1);

    await dispatch(dmMsg({ senderStaffId: 'boss', senderNick: 'Boss' }));
    expect(mockSaveConfig).toHaveBeenCalledTimes(1);
    expect(mockReplyText).toHaveBeenCalledTimes(1);
    expect(forwarded()).toBe(2);
  });

  test('guide send does not block forwarding the first DM', async () => {
    setConfig(baseConfig({ owner: { bound: false, staff_id: '', name: '' } }));
    mockReplyText.mockImplementation(() => new Promise(() => {})); // never settles
    await dispatch(dmMsg({ senderStaffId: 'boss2' }));
    expect(mockReplyText).toHaveBeenCalledWith('https://hook/dm', OWNER_GUIDE_TEXT);
    expect(forwarded()).toBe(1);
  });

  test('save failure -> no guide', async () => {
    setConfig(baseConfig({ owner: { bound: false, staff_id: '', name: '' } }));
    mockSaveConfig.mockReturnValueOnce(false);
    await dispatch(dmMsg({ senderStaffId: 'boss3' }));
    expect(mockReplyText).not.toHaveBeenCalled();
    expect(mockSendTextDM).not.toHaveBeenCalled();
  });

  test('no sessionWebhook -> guide via proactive DM', async () => {
    setConfig(baseConfig({ owner: { bound: false, staff_id: '', name: '' } }));
    await dispatch(dmMsg({ senderStaffId: 'boss4', sessionWebhook: undefined }));
    expect(mockReplyText).not.toHaveBeenCalled();
    expect(mockSendTextDM).toHaveBeenCalledWith(['boss4'], OWNER_GUIDE_TEXT);
  });

  test('DM allowlist with numeric entry -> forwarded', async () => {
    setConfig(baseConfig({ dmPolicy: 'allowlist', dmAllowFrom: [12345] }));
    await dispatch(dmMsg({ senderStaffId: '12345' }));
    expect(forwarded()).toBe(1);
  });

  test('DM from non-owner when owner already bound -> no guide, not forwarded', async () => {
    setConfig(baseConfig());
    await dispatch(dmMsg({ senderStaffId: 'stranger' }));
    expect(mockSaveConfig).not.toHaveBeenCalled();
    expect(mockReplyText).not.toHaveBeenCalled();
    expect(forwarded()).toBe(0);
  });
});
