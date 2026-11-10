import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { outboundDenialReason } from '../src/lib/outbound.js';

const owner = { bound: true, staff_id: 'u-owner', name: 'O' };
const ep = (id, type, msg) => ({ id, type, msg });

describe('outbound DM policy', () => {
  test.each([
    ['owner', { owner, dmPolicy: 'owner' }, 'u-owner', true],
    ['owner with unknown dmPolicy', { owner, dmPolicy: 'Owner' }, 'u-owner', true],
    ['stranger under owner policy', { owner, dmPolicy: 'owner' }, 'u-x', false],
    ['allowlisted user', { owner, dmPolicy: 'allowlist', dmAllowFrom: ['u-a'] }, 'u-a', true],
    ['unlisted user under allowlist', { owner, dmPolicy: 'allowlist', dmAllowFrom: ['u-a'] }, 'u-x', false],
    ['anyone under open', { owner, dmPolicy: 'open' }, 'u-x', true],
  ])('%s', (_name, config, to, allowed) => {
    expect(outboundDenialReason(config, ep(to, 'p2p')) === null).toBe(allowed);
  });

  test('endpoint without type is checked as a DM', () => {
    expect(outboundDenialReason({ owner, dmPolicy: 'owner' }, ep('u-x'))).toMatch(/DM recipient u-x/);
  });
});

describe('outbound group policy', () => {
  const allowlist = { owner, groupPolicy: 'allowlist', groups: { cidA: { name: 'a' } } };

  test('enabled group', () => {
    expect(outboundDenialReason(allowlist, ep('cidA', 'group'))).toBeNull();
  });

  test('open policy allows any group', () => {
    expect(outboundDenialReason({ owner, groupPolicy: 'open' }, ep('cidX', 'group'))).toBeNull();
  });

  test('non-enabled group: proactive send blocked', () => {
    expect(outboundDenialReason(allowlist, ep('cidX', 'group'))).toMatch(/group cidX is not enabled/);
  });

  test('non-enabled group: reply to an owner message allowed', () => {
    expect(outboundDenialReason(allowlist, ep('cidX', 'group', 'm1'), { senderStaffId: 'u-owner' })).toBeNull();
  });

  test('non-enabled group: reply to a non-owner message blocked', () => {
    expect(outboundDenialReason(allowlist, ep('cidX', 'group', 'm1'), { senderStaffId: 'u-x' })).not.toBeNull();
  });

  test('disabled: everything blocked, owner replies included', () => {
    const disabled = { ...allowlist, groupPolicy: 'disabled' };
    expect(outboundDenialReason(disabled, ep('cidA', 'group'))).not.toBeNull();
    expect(outboundDenialReason(disabled, ep('cidA', 'group', 'm1'), { senderStaffId: 'u-owner' })).not.toBeNull();
  });

  test('no owner bound: inbound proof alone is not enough', () => {
    expect(outboundDenialReason({ groupPolicy: 'allowlist', groups: {} }, ep('cidX', 'group', 'm1'), { senderStaffId: 'u-owner' })).not.toBeNull();
  });
});

describe('send.js enforces the policy before any network call', () => {
  test('blocked DM exits 1 with outbound blocked', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-send-'));
    const dataDir = path.join(home, 'zylos/components/dingtalk');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ owner, dmPolicy: 'owner' }));
    const r = spawnSync(process.execPath, ['scripts/send.js', 'u-x|type:p2p', 'hello'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, DINGTALK_INTERNAL_PORT: '1' },
      timeout: 20000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('outbound blocked: DM recipient u-x');
    expect(fs.existsSync(path.join(dataDir, '.send-queue.json'))).toBe(false);
  });
});
