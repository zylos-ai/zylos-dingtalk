/**
 * Tests for group access notices and the owner guide (src/lib/access.js).
 */

import { jest } from '@jest/globals';
import {
  GROUP_NOT_ENABLED_NOTICE,
  GROUP_NO_PERMISSION_NOTICE,
  OWNER_GUIDE_TEXT,
  DENY_GROUP_NOT_ENABLED,
  DENY_SENDER_NOT_ALLOWED,
  getGroupDenyReason,
  isBotMentioned,
  notifyGroupDenied,
  bindOwner,
  sendOwnerGuide,
  checkGroupAccess,
  bindOwnerWithGuide,
} from '../src/lib/access.js';

const OWNER = { bound: true, staff_id: 'owner1', name: 'Owner' };

function groupMsg(overrides = {}) {
  return {
    conversationId: 'cid1',
    conversationType: '2',
    senderStaffId: 'u1',
    sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=x',
    isInAtList: true,
    ...overrides,
  };
}

let logSpy, errSpy, warnSpy;
beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('user-facing texts', () => {
  test('match the agreed wording', () => {
    expect(GROUP_NOT_ENABLED_NOTICE).toBe('本群还没开通，请联系 Agent 管理者开启');
    expect(GROUP_NO_PERMISSION_NOTICE).toBe('你在本群暂无权限使用我，请联系 Agent 管理者开通');
    expect(OWNER_GUIDE_TEXT).toBe(
      '你已成为这个 Agent 的管理者。\n开启群聊：把我拉进群后，在群里 @我 说「开启本群」。\n开放私聊：跟我说「允许所有同事私聊你」，或「允许某某私聊你」。'
    );
  });
});

describe('getGroupDenyReason', () => {
  test('owner is always allowed', () => {
    expect(getGroupDenyReason({ owner: OWNER, groupPolicy: 'disabled' }, 'owner1', 'cid1')).toBeNull();
  });

  test('disabled policy -> group not enabled', () => {
    expect(getGroupDenyReason({ groupPolicy: 'disabled' }, 'u1', 'cid1')).toBe(DENY_GROUP_NOT_ENABLED);
  });

  test('open policy -> allowed', () => {
    expect(getGroupDenyReason({ groupPolicy: 'open' }, 'u1', 'cid1')).toBeNull();
  });

  test('allowlist with unconfigured group -> group not enabled', () => {
    expect(getGroupDenyReason({ groupPolicy: 'allowlist', groups: {} }, 'u1', 'cid1')).toBe(DENY_GROUP_NOT_ENABLED);
  });

  test('allowlist with configured group and empty/wildcard allowFrom -> allowed', () => {
    expect(getGroupDenyReason({ groupPolicy: 'allowlist', groups: { cid1: { allowFrom: [] } } }, 'u1', 'cid1')).toBeNull();
    expect(getGroupDenyReason({ groupPolicy: 'allowlist', groups: { cid1: { allowFrom: ['*'] } } }, 'u1', 'cid1')).toBeNull();
    expect(getGroupDenyReason({ groupPolicy: 'allowlist', groups: { cid1: {} } }, 'u1', 'cid1')).toBeNull();
  });

  test('allowlist with sender in allowFrom -> allowed', () => {
    expect(getGroupDenyReason({ groupPolicy: 'allowlist', groups: { cid1: { allowFrom: ['u1'] } } }, 'u1', 'cid1')).toBeNull();
  });

  test('allowlist with sender not in allowFrom -> sender not allowed', () => {
    expect(getGroupDenyReason({ groupPolicy: 'allowlist', groups: { cid1: { allowFrom: ['u2'] } } }, 'u1', 'cid1')).toBe(DENY_SENDER_NOT_ALLOWED);
  });

  test('non-array allowFrom fails closed (no substring matching)', () => {
    const cfg = { groupPolicy: 'allowlist', groups: { cid1: { allowFrom: 'u1,u2' } } };
    expect(getGroupDenyReason(cfg, 'u1', 'cid1')).toBe(DENY_SENDER_NOT_ALLOWED);
    expect(getGroupDenyReason({ groupPolicy: 'allowlist', groups: { cid1: { allowFrom: '' } } }, 'u1', 'cid1')).toBe(DENY_SENDER_NOT_ALLOWED);
    expect(getGroupDenyReason({ groupPolicy: 'allowlist', groups: { cid1: { allowFrom: '*' } } }, 'u1', 'cid1')).toBe(DENY_SENDER_NOT_ALLOWED);
  });

  test('allowFrom ids are compared as strings', () => {
    expect(getGroupDenyReason({ groupPolicy: 'allowlist', groups: { cid1: { allowFrom: [123] } } }, '123', 'cid1')).toBeNull();
  });

  test('unknown policy -> group not enabled', () => {
    expect(getGroupDenyReason({ groupPolicy: 'weird' }, 'u1', 'cid1')).toBe(DENY_GROUP_NOT_ENABLED);
  });
});

describe('isBotMentioned', () => {
  test('isInAtList true', () => {
    expect(isBotMentioned({ isInAtList: true })).toBe(true);
  });

  test('atUsers containing the bot dingtalkId', () => {
    expect(isBotMentioned({ chatbotUserId: 'bot', atUsers: [{ dingtalkId: 'bot' }] })).toBe(true);
  });

  test('no mention', () => {
    expect(isBotMentioned({ isInAtList: false })).toBe(false);
    expect(isBotMentioned({ chatbotUserId: 'bot', atUsers: [{ dingtalkId: 'other' }] })).toBe(false);
    expect(isBotMentioned({})).toBe(false);
  });
});

describe('notifyGroupDenied', () => {
  test('blocked mention in a not-enabled group -> exactly one notice', async () => {
    const reply = jest.fn().mockResolvedValue({});
    const sent = await notifyGroupDenied(groupMsg(), DENY_GROUP_NOT_ENABLED, reply);
    expect(sent).toBe(true);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(groupMsg().sessionWebhook, GROUP_NOT_ENABLED_NOTICE);
  });

  test('blocked mention by a non-allowed sender -> no-permission notice', async () => {
    const reply = jest.fn().mockResolvedValue({});
    await notifyGroupDenied(groupMsg(), DENY_SENDER_NOT_ALLOWED, reply);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(groupMsg().sessionWebhook, GROUP_NO_PERMISSION_NOTICE);
  });

  test('blocked non-mention -> no notice', async () => {
    const reply = jest.fn().mockResolvedValue({});
    const sent = await notifyGroupDenied(groupMsg({ isInAtList: false }), DENY_GROUP_NOT_ENABLED, reply);
    expect(sent).toBe(false);
    expect(reply).not.toHaveBeenCalled();
  });

  test('allowed message (no reason) -> no notice', async () => {
    const reply = jest.fn().mockResolvedValue({});
    expect(await notifyGroupDenied(groupMsg(), null, reply)).toBe(false);
    expect(reply).not.toHaveBeenCalled();
  });

  test('missing sessionWebhook -> no notice, no throw', async () => {
    const reply = jest.fn();
    expect(await notifyGroupDenied(groupMsg({ sessionWebhook: undefined }), DENY_GROUP_NOT_ENABLED, reply)).toBe(false);
    expect(reply).not.toHaveBeenCalled();
  });

  test('send error is swallowed and logged', async () => {
    const reply = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(notifyGroupDenied(groupMsg(), DENY_GROUP_NOT_ENABLED, reply)).resolves.toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('checkGroupAccess', () => {
  const notEnabled = { groupPolicy: 'allowlist', groups: {} };

  test('blocked group mention -> caller stops, exactly one notice', async () => {
    const reply = jest.fn().mockResolvedValue({});
    const res = checkGroupAccess({ config: notEnabled, msg: groupMsg(), reply });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe(DENY_GROUP_NOT_ENABLED);
    expect(await res.notice).toBe(true);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(groupMsg().sessionWebhook, GROUP_NOT_ENABLED_NOTICE);
  });

  test('blocked mention by non-allowed sender -> no-permission notice', async () => {
    const reply = jest.fn().mockResolvedValue({});
    const config = { groupPolicy: 'allowlist', groups: { cid1: { allowFrom: ['u2'] } } };
    const res = checkGroupAccess({ config, msg: groupMsg(), reply });
    expect(res.allowed).toBe(false);
    await res.notice;
    expect(reply).toHaveBeenCalledWith(groupMsg().sessionWebhook, GROUP_NO_PERMISSION_NOTICE);
  });

  test('blocked non-mention -> caller stops, no notice', () => {
    const reply = jest.fn();
    const res = checkGroupAccess({ config: notEnabled, msg: groupMsg({ isInAtList: false }), reply });
    expect(res.allowed).toBe(false);
    expect(res.notice).toBeNull();
    expect(reply).not.toHaveBeenCalled();
  });

  test('allowed mention -> caller continues, no notice', () => {
    const reply = jest.fn();
    const res = checkGroupAccess({ config: { groupPolicy: 'open' }, msg: groupMsg(), reply });
    expect(res).toEqual({ allowed: true, reason: null, notice: null });
    expect(reply).not.toHaveBeenCalled();
  });

  test('does not wait for the notice send (fire-and-forget)', () => {
    const reply = jest.fn(() => new Promise(() => {})); // never settles
    const res = checkGroupAccess({ config: notEnabled, msg: groupMsg(), reply });
    expect(res.allowed).toBe(false);
    expect(reply).toHaveBeenCalledTimes(1);
  });

  test('notice send failure is swallowed', async () => {
    const reply = jest.fn().mockRejectedValue(new Error('boom'));
    const res = checkGroupAccess({ config: notEnabled, msg: groupMsg(), reply });
    await expect(res.notice).resolves.toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('bindOwnerWithGuide', () => {
  function deps(overrides = {}) {
    return {
      save: jest.fn().mockReturnValue(true),
      reply: jest.fn().mockResolvedValue({}),
      sendDM: jest.fn().mockResolvedValue({}),
      ...overrides,
    };
  }

  test('first DM binds owner and sends the guide once; later DMs send nothing', async () => {
    const config = { owner: { bound: false, staff_id: '', name: '' } };
    const d = deps();

    const first = bindOwnerWithGuide({ config, staffId: 'owner1', name: 'Name', sessionWebhook: 'https://hook', ...d });
    expect(first.bound).toBe(true);
    expect(await first.guide).toBe(true);
    expect(config.owner).toEqual({ bound: true, staff_id: 'owner1', name: 'Name' });
    expect(d.save).toHaveBeenCalledTimes(1);
    expect(d.reply).toHaveBeenCalledTimes(1);
    expect(d.reply).toHaveBeenCalledWith('https://hook', OWNER_GUIDE_TEXT);

    const second = bindOwnerWithGuide({ config, staffId: 'owner1', name: 'Name', sessionWebhook: 'https://hook', ...d });
    const other = bindOwnerWithGuide({ config, staffId: 'u9', name: 'Other', sessionWebhook: 'https://hook', ...d });
    expect(second).toEqual({ bound: false, guide: null });
    expect(other).toEqual({ bound: false, guide: null });
    expect(config.owner.staff_id).toBe('owner1');
    expect(d.save).toHaveBeenCalledTimes(1);
    expect(d.reply).toHaveBeenCalledTimes(1);
    expect(d.sendDM).not.toHaveBeenCalled();
  });

  test('save failure -> not bound result, no guide', () => {
    const config = { owner: { bound: false } };
    const d = deps({ save: jest.fn().mockReturnValue(false) });
    const res = bindOwnerWithGuide({ config, staffId: 'owner1', name: 'N', sessionWebhook: 'https://hook', ...d });
    expect(res).toEqual({ bound: false, guide: null });
    expect(d.reply).not.toHaveBeenCalled();
    expect(d.sendDM).not.toHaveBeenCalled();
  });

  test('no sessionWebhook -> falls back to proactive DM', async () => {
    const config = { owner: { bound: false } };
    const d = deps();
    const res = bindOwnerWithGuide({ config, staffId: 'owner1', name: 'N', sessionWebhook: undefined, ...d });
    expect(await res.guide).toBe(true);
    expect(d.reply).not.toHaveBeenCalled();
    expect(d.sendDM).toHaveBeenCalledWith('owner1', OWNER_GUIDE_TEXT);
  });

  test('does not wait for the guide send (fire-and-forget)', () => {
    const config = { owner: { bound: false } };
    const d = deps({ reply: jest.fn(() => new Promise(() => {})) });
    const res = bindOwnerWithGuide({ config, staffId: 'owner1', name: 'N', sessionWebhook: 'h', ...d });
    expect(res.bound).toBe(true);
    expect(d.reply).toHaveBeenCalledTimes(1);
  });

  test('guide send failure is swallowed', async () => {
    const config = { owner: { bound: false } };
    const d = deps({ reply: jest.fn().mockRejectedValue(new Error('boom')) });
    const res = bindOwnerWithGuide({ config, staffId: 'owner1', name: 'N', sessionWebhook: 'h', ...d });
    await expect(res.guide).resolves.toBe(false);
  });

  test('bindOwner returns false when already bound', () => {
    const save = jest.fn();
    expect(bindOwner({ owner: OWNER }, 'u1', 'X', save)).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
});
