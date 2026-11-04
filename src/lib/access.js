/**
 * Access-control helpers: group permission checks, the one-shot notice sent
 * when a blocked group message @-mentions the bot, and owner auto-binding
 * with the post-binding owner guide.
 *
 * Kept free of side effects (no config/network imports) so it can be unit
 * tested; callers inject config, persistence and send functions.
 */

// User-facing texts (Chinese only, by owner decision).
export const GROUP_NOT_ENABLED_NOTICE = '本群还没开通，请联系 Agent 管理者开启';
export const GROUP_NO_PERMISSION_NOTICE = '你在本群暂无权限使用我，请联系 Agent 管理者开通';
export const OWNER_GUIDE_TEXT = '你已成为这个 Agent 的管理者。\n'
  + '开启群聊：把我拉进群后，在群里 @我 说「开启本群」。\n'
  + '开放私聊：跟我说「允许所有同事私聊你」，或「允许某某私聊你」。';

export const DENY_GROUP_NOT_ENABLED = 'group_not_enabled';
export const DENY_SENDER_NOT_ALLOWED = 'sender_not_allowed';

export function isOwner(config, staffId) {
  return Boolean(config.owner?.bound && config.owner.staff_id === String(staffId));
}

/**
 * Whether `staffId` appears in an allowlist array. Entries are compared as
 * strings (so numeric 123 matches "123"); a non-array list matches nothing.
 */
export function isInAllowList(list, staffId) {
  if (!Array.isArray(list)) return false;
  return list.some(id => String(id) === String(staffId));
}

/**
 * DM access check. Owner is always allowed; otherwise by dmPolicy.
 */
export function checkDMPermission(config, staffId) {
  if (isOwner(config, staffId)) return true;
  switch (config.dmPolicy) {
    case 'open': return true;
    case 'allowlist': return isInAllowList(config.dmAllowFrom, staffId);
    case 'owner':
    default: return false;
  }
}

/**
 * Decide whether a group message is allowed.
 * Returns null when allowed, otherwise the deny reason:
 *   - DENY_GROUP_NOT_ENABLED: group policy disabled, or allowlist policy and
 *     the group is not configured
 *   - DENY_SENDER_NOT_ALLOWED: group is enabled but the sender is not in its
 *     allowFrom list
 */
export function getGroupDenyReason(config, staffId, conversationId) {
  if (isOwner(config, staffId)) return null;
  switch (config.groupPolicy) {
    case 'open':
      return null;
    case 'allowlist': {
      const groupConfig = config.groups?.[conversationId];
      if (!groupConfig) return DENY_GROUP_NOT_ENABLED;
      const { allowFrom } = groupConfig;
      // Missing allowFrom means everyone in the group may talk to the bot.
      if (allowFrom === undefined || allowFrom === null) return null;
      // Malformed (non-array) allowFrom fails closed instead of substring-matching.
      if (!Array.isArray(allowFrom)) return DENY_SENDER_NOT_ALLOWED;
      if (allowFrom.length === 0 || allowFrom.includes('*')) return null;
      return isInAllowList(allowFrom, staffId) ? null : DENY_SENDER_NOT_ALLOWED;
    }
    case 'disabled':
    default:
      return DENY_GROUP_NOT_ENABLED;
  }
}

/**
 * Whether the bot was @-mentioned in a DingTalk robot callback payload.
 * DingTalk sets `isInAtList` when the robot is in the message's @ list;
 * `atUsers[].dingtalkId` matching `chatbotUserId` is checked as a fallback.
 */
export function isBotMentioned(msg) {
  if (!msg) return false;
  if (msg.isInAtList === true || msg.isInAtList === 'true') return true;
  if (msg.chatbotUserId && Array.isArray(msg.atUsers)) {
    return msg.atUsers.some(u => u?.dingtalkId && u.dingtalkId === msg.chatbotUserId);
  }
  return false;
}

/**
 * Reply once to a blocked group message, only if the bot was @-mentioned.
 * Send errors are swallowed and logged. Returns true if a notice was sent.
 *
 * @param {object} msg     DingTalk robot callback payload
 * @param {string} reason  value returned by getGroupDenyReason()
 * @param {(webhook: string, text: string) => Promise<any>} reply
 */
export async function notifyGroupDenied(msg, reason, reply) {
  if (!reason || !isBotMentioned(msg)) return false;
  if (!msg.sessionWebhook) {
    console.warn('[dingtalk] Group denied notice skipped: no sessionWebhook');
    return false;
  }
  const text = reason === DENY_SENDER_NOT_ALLOWED
    ? GROUP_NO_PERMISSION_NOTICE
    : GROUP_NOT_ENABLED_NOTICE;
  try {
    await reply(msg.sessionWebhook, text);
    console.log(`[dingtalk] Group denied notice sent (${reason}) in ${msg.conversationId}`);
    return true;
  } catch (err) {
    console.error(`[dingtalk] Failed to send group denied notice: ${err?.message ?? String(err)}`);
    return false;
  }
}

/**
 * Group access gate used by the message handler.
 * Returns { allowed, reason, notice }. When denied, the caller must stop
 * processing the message. If the bot was @-mentioned, a one-time notice is
 * sent fire-and-forget; `notice` is that promise (never rejects), or null.
 */
export function checkGroupAccess({ config, msg, reply }) {
  const reason = getGroupDenyReason(config, msg.senderStaffId, msg.conversationId);
  if (!reason) return { allowed: true, reason: null, notice: null };
  const notice = isBotMentioned(msg) ? notifyGroupDenied(msg, reason, reply) : null;
  return { allowed: false, reason, notice };
}

/**
 * Bind the first DM sender as owner if no owner is bound yet.
 * Returns true only when this call actually bound the owner and the config
 * was persisted successfully.
 *
 * @param {object} config
 * @param {string} staffId
 * @param {string} name
 * @param {(config: object) => boolean} save  persists config, returns success
 */
export function bindOwner(config, staffId, name, save) {
  if (config.owner?.bound) return false;
  config.owner = { bound: true, staff_id: String(staffId), name };
  const saved = save(config) !== false;
  if (saved) {
    console.log(`[dingtalk] Owner bound: ${name} (${staffId})`);
  } else {
    console.error(`[dingtalk] Owner bound in memory but config save failed: ${name} (${staffId})`);
  }
  return saved;
}

/**
 * Send the post-binding guide to the new owner. Prefers the DM's
 * sessionWebhook; falls back to a proactive DM. Errors are swallowed.
 * Returns true if the guide was sent.
 */
export async function sendOwnerGuide({ staffId, sessionWebhook, reply, sendDM }) {
  try {
    if (sessionWebhook) {
      await reply(sessionWebhook, OWNER_GUIDE_TEXT);
    } else {
      await sendDM(staffId, OWNER_GUIDE_TEXT);
    }
    console.log(`[dingtalk] Owner guide sent to ${staffId}`);
    return true;
  } catch (err) {
    console.error(`[dingtalk] Failed to send owner guide: ${err?.message ?? String(err)}`);
    return false;
  }
}

/**
 * Owner auto-binding on DM. If no owner is bound, binds the sender and, only
 * when binding (and saving) succeeded, sends the owner guide fire-and-forget.
 * Returns { bound, guide } where `guide` is the send promise (never rejects)
 * or null. Message handling should continue regardless.
 */
export function bindOwnerWithGuide({ config, staffId, name, sessionWebhook, save, reply, sendDM }) {
  const bound = bindOwner(config, staffId, name, save);
  const guide = bound ? sendOwnerGuide({ staffId, sessionWebhook, reply, sendDM }) : null;
  return { bound, guide };
}
