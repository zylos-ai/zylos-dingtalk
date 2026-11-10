/**
 * Outbound destination policy for scripts/send.js.
 *
 * A DM (`type:p2p`, or no type) may only go to a staffId the inbound DM policy
 * accepts (owner always; then dmPolicy / dmAllowFrom). A group (`type:group`)
 * must pass the group policy (open, or listed under `groups` for allowlist);
 * otherwise only a reply to an accepted inbound message written by the owner
 * is allowed, so owner conversations in non-enabled groups keep working.
 * groupPolicy=disabled blocks every group send, owner replies included. The proof is the sender recorded with
 * that message's sessionWebhook by the running component; once the webhook
 * expires or the component restarts, such a reply is denied, never wrongly
 * allowed.
 *
 * Kept free of side effects so it can be unit tested.
 */
import { checkDMPermission, isOwner } from './access.js';

/**
 * @param {object} config
 * @param {{id: string, type?: string}} ep - parsed endpoint
 * @param {{senderStaffId?: string}|null} [inbound] - sender recorded for the
 *   endpoint's inbound message, or null when unknown
 * @returns {string|null} denial reason, or null when allowed
 */
export function outboundDenialReason(config, ep, inbound = null) {
  if (!ep?.id) return 'missing destination id';
  if (ep.type === 'group') {
    if (config.groupPolicy === 'open') return null;
    if (config.groupPolicy === 'allowlist' && Object.hasOwn(config.groups || {}, ep.id)) return null;
    if (config.groupPolicy === 'disabled') return 'groupPolicy=disabled';
    if (inbound?.senderStaffId && isOwner(config, inbound.senderStaffId)) return null;
    return `group ${ep.id} is not enabled (groupPolicy=${config.groupPolicy}) and the message is not a reply to the owner`;
  }
  if (!checkDMPermission(config, ep.id)) {
    return `DM recipient ${ep.id} is not allowed by dmPolicy=${config.dmPolicy}`;
  }
  return null;
}
