/**
 * Tests for group-denied notices and the owner guide (OPENM-1149).
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

describe('owner binding + guide', () => {
  // Mirrors the DM flow in src/index.js: bind on first DM, guide only on bind.
  async function onDM(config, save, reply, staffId, sessionWebhook = 'https://hook') {
    if (!config.owner?.bound) {
      if (bindOwner(config, staffId, 'Name', save)) {
        await sendOwnerGuide({ staffId, sessionWebhook, reply, sendDM: jest.fn() });
      }
    }
  }

  test('first DM binds owner and sends the guide once; second DM sends nothing', async () => {
    const config = { owner: { bound: false, staff_id: '', name: '' } };
    const save = jest.fn().mockReturnValue(true);
    const reply = jest.fn().mockResolvedValue({});

    await onDM(config, save, reply, 'owner1');
    expect(config.owner).toEqual({ bound: true, staff_id: 'owner1', name: 'Name' });
    expect(save).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith('https://hook', OWNER_GUIDE_TEXT);

    await onDM(config, save, reply, 'owner1');
    await onDM(config, save, reply, 'someone-else');
    expect(save).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(1);
  });

  test('bindOwner returns false when already bound', () => {
    const save = jest.fn();
    expect(bindOwner({ owner: OWNER }, 'u1', 'X', save)).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  test('bindOwner returns false when save fails (no guide)', async () => {
    const config = { owner: { bound: false } };
    const save = jest.fn().mockReturnValue(false);
    const reply = jest.fn();
    await onDM(config, save, reply, 'owner1');
    expect(reply).not.toHaveBeenCalled();
  });

  test('sendOwnerGuide falls back to proactive DM without sessionWebhook', async () => {
    const reply = jest.fn();
    const sendDM = jest.fn().mockResolvedValue({});
    expect(await sendOwnerGuide({ staffId: 'owner1', sessionWebhook: undefined, reply, sendDM })).toBe(true);
    expect(reply).not.toHaveBeenCalled();
    expect(sendDM).toHaveBeenCalledWith('owner1', OWNER_GUIDE_TEXT);
  });

  test('sendOwnerGuide swallows send errors', async () => {
    const reply = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(sendOwnerGuide({ staffId: 'o', sessionWebhook: 'h', reply, sendDM: jest.fn() })).resolves.toBe(false);
  });
});
