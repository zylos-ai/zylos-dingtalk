/**
 * Outbound destination policy for scripts/send.js.
 *
 * DM vs group comes from the conversation type the component recorded from
 * DingTalk callbacks (src/lib/conversations.js), never from the `type` the
 * agent wrote into the endpoint. Unknown ids are treated as groups (the
 * strictest case); the bound owner's staffId counts as a known 1:1 chat
 * (it was bound from a DM callback), staffIds listed under `dmAllowFrom`
 * (admin config) count as known 1:1 chats, and ids listed under `groups`
 * (admin config) count as known groups. When the endpoint's declared type disagrees
 * with the real type the send is blocked, so routing never follows a forged type.
 *
 * - DM: only staffIds the inbound DM policy accepts (owner always).
 * - Group: groupPolicy=open, or listed under `groups` for allowlist; otherwise
 *   only a reply to an accepted inbound group message written by the owner
 *   (proof: the component's persisted inbound record for conversationId+msgId).
 *   groupPolicy=disabled blocks every group send, owner replies included.
 *
 * Kept free of side effects so it can be unit tested.
 */
import { checkDMPermission, isInAllowList, isOwner } from './access.js';
import { lookupConversationType, lookupInbound } from './conversations.js';

/**
 * Real conversation type of an endpoint id, from component-held records.
 * @returns {'p2p'|'group'|null} null = unknown
 */
export function realConversationType(config, store, id) {
  const recorded = lookupConversationType(store, id);
  if (recorded) return recorded;
  if (config.owner?.bound && config.owner.staff_id && String(config.owner.staff_id) === id) return 'p2p';
  if (isInAllowList(config.dmAllowFrom, id)) return 'p2p';
  if (Object.hasOwn(config.groups || {}, id)) return 'group';
  return null;
}

/**
 * @param {object} config
 * @param {{id: string, type?: string, msg?: string}} ep - parsed endpoint
 * @param {object} [store] - conversations store (readStore result)
 * @returns {{reason: string|null, type: 'p2p'|'group'}} denial reason (null =
 *   allowed) and the real type to route by
 */
export function checkOutbound(config, ep, store = null, now = Date.now()) {
  if (!ep?.id) return { reason: 'missing destination id', type: 'group' };
  const known = realConversationType(config, store, ep.id);
  const type = known || 'group';
  const declared = ep.type === 'group' ? 'group' : 'p2p'; // no type = DM (legacy endpoint format)
  if (declared !== type) {
    return {
      reason: known
        ? `endpoint type ${declared} does not match the recorded conversation type ${known} for ${ep.id}`
        : `unknown conversation ${ep.id}: no inbound message recorded, treated as a group`,
      type,
    };
  }
  if (type === 'group') {
    if (config.groupPolicy === 'disabled') return { reason: 'groupPolicy=disabled', type };
    if (config.groupPolicy === 'open') return { reason: null, type };
    if (config.groupPolicy === 'allowlist' && Object.hasOwn(config.groups || {}, ep.id)) return { reason: null, type };
    const inbound = lookupInbound(store, ep.id, ep.msg, now);
    if (inbound && isOwner(config, inbound.senderStaffId)) return { reason: null, type };
    return {
      reason: `group ${ep.id} is not enabled (groupPolicy=${config.groupPolicy}) and the message is not a reply to the owner`,
      type,
    };
  }
  if (!checkDMPermission(config, ep.id)) {
    return { reason: `DM recipient ${ep.id} is not allowed by dmPolicy=${config.dmPolicy}`, type };
  }
  return { reason: null, type };
}
