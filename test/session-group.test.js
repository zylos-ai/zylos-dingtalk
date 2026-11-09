import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { sessionGroupFromEndpoint } from '../src/lib/session-group.js';
import { buildC4ReceiveArgs, classifyC4Rejection, sendToC4, GENERIC_REJECT_REPLY, UNCERTAIN_REPLY } from '../src/lib/c4.js';

describe('sessionGroupFromEndpoint', () => {
  test('DM maps to dm-<staffId>', () => {
    expect(sessionGroupFromEndpoint('manager4567|type:p2p|msg:m1')).toBe('dm-manager4567');
  });

  test('endpoint without type is a DM (matches send.js)', () => {
    expect(sessionGroupFromEndpoint('0123456')).toBe('dm-0123456');
  });

  test('group maps base64 conversation ids to a Core-safe name', () => {
    expect(sessionGroupFromEndpoint('cidAbC+dE/f12==|type:group|msg:m1')).toBe('group-cidAbC-dE_f12');
  });

  test('per-message parts never change the group', () => {
    const a = sessionGroupFromEndpoint('cidX1|type:group|msg:m1');
    const b = sessionGroupFromEndpoint('cidX1|type:group|msg:m2');
    expect(a).toBe(b);
  });

  test('DM and group with the same id stay separate', () => {
    expect(sessionGroupFromEndpoint('abc|type:p2p')).not.toBe(sessionGroupFromEndpoint('abc|type:group'));
  });

  test('rejects empty, invalid or overlong ids', () => {
    expect(() => sessionGroupFromEndpoint('')).toThrow();
    expect(() => sessionGroupFromEndpoint('a b|type:p2p')).toThrow();
    expect(() => sessionGroupFromEndpoint(`${'x'.repeat(100)}|type:group`)).toThrow();
  });

  test('CLI prints the group', () => {
    const out = execFileSync(process.execPath, ['scripts/session-group.js', 'cidQ+1=|type:group|msg:9'], { encoding: 'utf8' });
    expect(out).toBe('group-cidQ-1\n');
  });
});

describe('buildC4ReceiveArgs', () => {
  let dir;
  const prev = process.env.ZYLOS_DIR;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-c4-'));
    fs.mkdirSync(path.join(dir, '.claude/skills/comm-bridge/scripts'), { recursive: true });
    process.env.ZYLOS_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = prev;
  });
  const manifest = (options) => fs.writeFileSync(
    path.join(dir, '.claude/skills/comm-bridge/scripts/c4-receive-options.json'), JSON.stringify({ options }));
  const base = ['--channel', 'dingtalk', '--endpoint', 'e', '--json', '--content', 'c'];

  test('old Core without manifest: args unchanged', () => {
    expect(buildC4ReceiveArgs({ channel: 'dingtalk', endpoint: 'e', content: 'c', sessionGroup: 'dm-1' })).toEqual(base);
  });

  test('manifest without --session-group: args unchanged', () => {
    manifest({ '--channel': {} });
    expect(buildC4ReceiveArgs({ channel: 'dingtalk', endpoint: 'e', content: 'c', sessionGroup: 'dm-1' })).toEqual(base);
  });

  test('manifest with --session-group: group passed', () => {
    manifest({ '--session-group': { takesValue: true } });
    expect(buildC4ReceiveArgs({ channel: 'dingtalk', endpoint: 'e', content: 'c', sessionGroup: 'dm-1' }))
      .toEqual([...base, '--session-group', 'dm-1']);
  });
});

describe('sendToC4 rejection handling', () => {
  const reject = (persisted) => ({ ok: false, error: { code: 'X', message: 'core text', persisted } });
  const run = (responses) => new Promise((resolve) => {
    const notices = [];
    let calls = 0;
    const exec = (_bin, _args, _opts, cb) => {
      const r = responses[calls++];
      cb(r === 'ok' ? null : new Error('fail'), r === 'ok' ? '' : JSON.stringify(r ?? ''));
    };
    sendToC4('dingtalk', 'u1|type:p2p|msg:m', 'hi', (n) => notices.push(n),
      { exec, retryDelayMs: 1, onDone: (outcome) => resolve({ outcome, notices, calls }) });
  });

  test('classifies persisted', () => {
    expect(classifyC4Rejection(reject(['row']))).toBe('committed');
    expect(classifyC4Rejection(reject([]))).toBe('not_stored');
    expect(classifyC4Rejection(reject(undefined))).toBe('uncertain');
  });

  test('success sends no notice', async () => {
    expect(await run(['ok'])).toEqual({ outcome: 'sent', notices: [], calls: 1 });
  });

  test('committed: no notice text, no resend', async () => {
    expect(await run([reject(['row'])])).toEqual({ outcome: 'committed', notices: [null], calls: 1 });
  });

  test('not stored: generic notice, no resend', async () => {
    expect(await run([reject([])])).toEqual({ outcome: 'rejected', notices: [GENERIC_REJECT_REPLY], calls: 1 });
  });

  test('unstructured failure twice: retried once, uncertain notice', async () => {
    expect(await run([null, null])).toEqual({ outcome: 'failed', notices: [UNCERTAIN_REPLY], calls: 2 });
  });

  test('invalid endpoint is never sent to the overall group', async () => {
    const notices = [];
    let called = false;
    await new Promise((resolve) => sendToC4('dingtalk', 'a b|type:p2p', 'hi', (n) => notices.push(n),
      { exec: () => { called = true; }, onDone: resolve }));
    expect(called).toBe(false);
    expect(notices).toEqual([GENERIC_REJECT_REPLY]);
  });
});
