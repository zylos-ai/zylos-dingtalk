import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { checkOutbound } from '../src/lib/outbound.js';
import { recordInbound, readStore, lookupInbound, INBOUND_TTL_MS, MAX_INBOUND } from '../src/lib/conversations.js';

const owner = { bound: true, staff_id: 'u-owner', name: 'O' };
const ep = (id, type, msg) => ({ id, type, msg });
const store = (conversations = {}, inbound = {}) => ({ conversations, inbound });
const p2p = (...ids) => Object.fromEntries(ids.map(id => [id, { type: 'p2p', seenAt: 1 }]));
const grp = (...ids) => Object.fromEntries(ids.map(id => [id, { type: 'group', seenAt: 1 }]));
const reason = (...a) => checkOutbound(...a).reason;

describe('outbound DM policy (recorded p2p conversations)', () => {
  const s = store(p2p('u-a', 'u-x'));
  test.each([
    ['owner (bound from a DM, no record needed)', { owner, dmPolicy: 'owner' }, 'u-owner', true],
    ['owner with unknown dmPolicy', { owner, dmPolicy: 'Owner' }, 'u-owner', true],
    ['stranger under owner policy', { owner, dmPolicy: 'owner' }, 'u-x', false],
    ['allowlisted user', { owner, dmPolicy: 'allowlist', dmAllowFrom: ['u-a'] }, 'u-a', true],
    ['unlisted user under allowlist', { owner, dmPolicy: 'allowlist', dmAllowFrom: ['u-a'] }, 'u-x', false],
    ['anyone recorded under open', { owner, dmPolicy: 'open' }, 'u-x', true],
  ])('%s', (_name, config, to, allowed) => {
    expect(reason(config, ep(to, 'p2p'), s) === null).toBe(allowed);
  });

  test('endpoint without type is a DM', () => {
    expect(reason({ owner, dmPolicy: 'owner' }, ep('u-x'), s)).toMatch(/DM recipient u-x/);
  });
});

describe('real type comes from component records, not the endpoint', () => {
  const open = { owner, dmPolicy: 'open', groupPolicy: 'open' };

  test('unknown id declared p2p: treated as group, blocked even under dmPolicy=open', () => {
    expect(reason(open, ep('u-new', 'p2p'), store())).toMatch(/unknown conversation u-new/);
  });

  test('unknown id declared group: strict group policy applies', () => {
    expect(reason({ owner, groupPolicy: 'allowlist', groups: {} }, ep('cidNew', 'group'), store())).toMatch(/not enabled/);
    expect(checkOutbound(open, ep('cidNew', 'group'), store())).toEqual({ reason: null, type: 'group' });
  });

  test('recorded group id declared p2p is blocked (no DM routing to a group)', () => {
    expect(reason(open, ep('cidG', 'p2p'), store(grp('cidG')))).toMatch(/does not match/);
  });

  test('recorded DM id declared group is blocked (group policy cannot be used for a DM)', () => {
    expect(reason(open, ep('u-a', 'group'), store(p2p('u-a')))).toMatch(/does not match/);
  });

  test('unreadable/empty store: everything except owner DM and configured groups is unknown', () => {
    const cfg = { owner, dmPolicy: 'open', groupPolicy: 'allowlist', groups: { cidA: {} } };
    expect(reason(cfg, ep('u-owner', 'p2p'), null)).toBeNull();
    expect(reason(cfg, ep('cidA', 'group'), null)).toBeNull();
    expect(reason(cfg, ep('u-x', 'p2p'), null)).not.toBeNull();
  });
});

describe('outbound group policy', () => {
  const allowlist = { owner, groupPolicy: 'allowlist', groups: { cidA: { name: 'a' } } };
  const s = store(grp('cidA', 'cidX'), {
    'cidX|m1': { senderStaffId: 'u-owner', at: Date.now() },
    'cidX|m2': { senderStaffId: 'u-x', at: Date.now() },
    'cidX|old': { senderStaffId: 'u-owner', at: Date.now() - INBOUND_TTL_MS - 1 },
  });

  test('enabled group', () => expect(reason(allowlist, ep('cidA', 'group'), s)).toBeNull());
  test('open policy allows any group', () => expect(reason({ owner, groupPolicy: 'open' }, ep('cidX', 'group'), s)).toBeNull());
  test('non-enabled group: proactive send blocked', () => expect(reason(allowlist, ep('cidX', 'group'), s)).toMatch(/group cidX is not enabled/));
  test('non-enabled group: reply to an owner message allowed', () => expect(reason(allowlist, ep('cidX', 'group', 'm1'), s)).toBeNull());
  test('non-enabled group: reply to a non-owner message blocked', () => expect(reason(allowlist, ep('cidX', 'group', 'm2'), s)).not.toBeNull());
  test('owner proof expires after the TTL', () => expect(reason(allowlist, ep('cidX', 'group', 'old'), s)).not.toBeNull());
  test('proof is per conversation: owner msg id from another group does not count', () => {
    expect(reason(allowlist, ep('cidZ', 'group', 'm1'), store(grp('cidZ'), s.inbound))).not.toBeNull();
  });

  test('disabled: everything blocked, owner replies included', () => {
    const disabled = { ...allowlist, groupPolicy: 'disabled' };
    expect(reason(disabled, ep('cidA', 'group'), s)).not.toBeNull();
    expect(reason(disabled, ep('cidX', 'group', 'm1'), s)).not.toBeNull();
  });

  test('no owner bound: inbound proof alone is not enough', () => {
    expect(reason({ groupPolicy: 'allowlist', groups: {} }, ep('cidX', 'group', 'm1'), s)).not.toBeNull();
  });
});

describe('conversations store', () => {
  let dir; let file;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-conv-')); file = path.join(dir, 'conversations.json'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('records type and accepted group proof; type never flips', () => {
    recordInbound(file, { id: 'cid1', type: 'group', msgId: 'm1', senderStaffId: 'u1', accepted: true });
    recordInbound(file, { id: 'cid1', type: 'p2p' });
    const s = readStore(file);
    expect(s.conversations.cid1.type).toBe('group');
    expect(lookupInbound(s, 'cid1', 'm1')).toEqual({ senderStaffId: 'u1' });
  });

  test('not accepted / DM / unknown type: no proof written', () => {
    recordInbound(file, { id: 'cid2', type: 'group', msgId: 'm1', senderStaffId: 'u1' });
    recordInbound(file, { id: 'u1', type: 'p2p', msgId: 'm2', senderStaffId: 'u1', accepted: true });
    recordInbound(file, { id: 'x', type: null });
    const s = readStore(file);
    expect(s.inbound).toEqual({});
    expect(s.conversations.x).toBeUndefined();
  });

  test('proofs are pruned by count', () => {
    for (let i = 0; i < MAX_INBOUND + 5; i++) {
      recordInbound(file, { id: 'cid', type: 'group', msgId: `m${i}`, senderStaffId: 'u', accepted: true }, 1000 + i);
    }
    const s = readStore(file);
    expect(Object.keys(s.inbound).length).toBe(MAX_INBOUND);
    expect(s.inbound['cid|m0']).toBeUndefined();
  });

  test('corrupt file reads as empty', () => {
    fs.writeFileSync(file, '{not json');
    expect(readStore(file)).toEqual({ conversations: {}, inbound: {} });
  });
});

// ─── scripts/send.js (spawned) ───────────────────────────────────────────────

function makeHome(config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-send-'));
  const dataDir = path.join(home, 'zylos/components/dingtalk');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dataDir, '.internal-token'), 'tok');
  return { home, dataDir };
}

function runSend(home, port, args) {
  const env = { ...process.env, HOME: home, DINGTALK_INTERNAL_PORT: String(port) };
  delete env.DINGTALK_APP_KEY;
  delete env.DINGTALK_APP_SECRET;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/send.js', ...args], { env });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stderr }); });
  });
}

describe('send.js enforces the policy before any DingTalk call', () => {
  const homes = [];
  afterAll(() => homes.forEach(h => fs.rmSync(h, { recursive: true, force: true })));

  test('blocked DM exits 1 with outbound blocked and is not queued', async () => {
    const { home, dataDir } = makeHome({ owner, dmPolicy: 'owner' });
    homes.push(home);
    recordInbound(path.join(dataDir, 'conversations.json'), { id: 'u-x', type: 'p2p' });
    const r = await runSend(home, 1, ['u-x|type:p2p', 'hello']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('outbound blocked: DM recipient u-x');
    expect(fs.existsSync(path.join(dataDir, '.send-queue.json'))).toBe(false);
  });

  test('group + msg -> owner proof -> allowed -> reads /internal/get-webhook and goes on to send', async () => {
    const { home, dataDir } = makeHome({ owner, groupPolicy: 'allowlist', groups: {} });
    homes.push(home);
    // Records exactly as src/index.js writes them for an accepted owner message.
    recordInbound(path.join(dataDir, 'conversations.json'),
      { id: 'cidX', type: 'group', msgId: 'm1', senderStaffId: 'u-owner', accepted: true });

    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        requests.push({ url: req.url, token: req.headers['x-internal-token'], body: JSON.parse(body || '{}') });
        res.setHeader('content-type', 'application/json');
        // Webhook URL points back at this local stub; the send then stops at the
        // missing app credentials (no DingTalk network access in tests).
        res.end(JSON.stringify(req.url === '/internal/get-webhook'
          ? { ok: true, url: `http://127.0.0.1:${server.address().port}/hook` } : { ok: true }));
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      const r = await runSend(home, server.address().port, ['cidX|type:group|msg:m1', 'hello']);
      expect(r.stderr).not.toContain('outbound blocked');
      expect(r.stderr).toContain('Missing DINGTALK_APP_KEY');
      expect(requests).toContainEqual({ url: '/internal/get-webhook', token: 'tok', body: { endpoint: 'cidX|type:group|msg:m1' } });

      // Same group, message not written by the owner -> blocked before any request.
      requests.length = 0;
      const r2 = await runSend(home, server.address().port, ['cidX|type:group|msg:other', 'hello']);
      expect(r2.status).toBe(1);
      expect(r2.stderr).toContain('outbound blocked: group cidX is not enabled');
      expect(requests).toEqual([]);
    } finally {
      server.close();
    }
  });
});
