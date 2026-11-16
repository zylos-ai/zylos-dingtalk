/**
 * Component-held conversation records, written only by the running component
 * (src/index.js) from DingTalk inbound callbacks and read by scripts/send.js.
 *
 * - conversations[id].type: the real conversation type DingTalk reported
 *   (conversationType "1" -> 'p2p' keyed by senderStaffId, "2" -> 'group'
 *   keyed by conversationId). Outbound policy uses this, never the `type`
 *   written into an endpoint by the agent.
 * - inbound["<conversationId>|<msgId>"]: sender of an accepted group message
 *   written by the owner, the proof for the owner-reply exception (the
 *   component only writes owner messages, so other groups' traffic cannot
 *   evict it). Persisted, so it survives
 *   sessionWebhook expiry and component restarts (bounded by TTL and count).
 *
 * Writes are atomic (tmp + rename). An unreadable file reads as empty, so
 * every lookup falls back to "unknown", which the policy treats strictly.
 */
import fs from 'fs';
import path from 'path';

export const INBOUND_TTL_MS = 7 * 24 * 3600 * 1000;
export const MAX_INBOUND = 2000;
export const MAX_CONVERSATIONS = 5000;

export function conversationTypeFromCallback(conversationType) {
  if (conversationType === '1') return 'p2p';
  if (conversationType === '2') return 'group';
  return null;
}

export function readStore(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      conversations: data?.conversations && typeof data.conversations === 'object' ? data.conversations : {},
      inbound: data?.inbound && typeof data.inbound === 'object' ? data.inbound : {},
    };
  } catch {
    return { conversations: {}, inbound: {} };
  }
}

function writeStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function prune(store, now) {
  const inbound = Object.entries(store.inbound)
    .filter(([, v]) => v && now - v.at <= INBOUND_TTL_MS)
    .sort((a, b) => a[1].at - b[1].at)
    .slice(-MAX_INBOUND);
  store.inbound = Object.fromEntries(inbound);
  const convs = Object.entries(store.conversations);
  if (convs.length > MAX_CONVERSATIONS) {
    store.conversations = Object.fromEntries(
      convs.sort((a, b) => (a[1].seenAt || 0) - (b[1].seenAt || 0)).slice(-MAX_CONVERSATIONS));
  }
}

/**
 * Record what an inbound callback proves. Only writes when something changed.
 * @param {string} file
 * @param {{id: string, type: 'p2p'|'group', msgId?: string, senderStaffId?: string, accepted?: boolean}} rec
 */
export function recordInbound(file, { id, type, msgId, senderStaffId, accepted = false }, now = Date.now()) {
  if (!id || (type !== 'p2p' && type !== 'group')) return;
  const store = readStore(file);
  const prev = store.conversations[id];
  let changed = false;
  // A known type never flips: the first callback wins, later conflicts are ignored.
  if (!prev) {
    store.conversations[id] = { type, seenAt: now };
    changed = true;
  } else if (prev.type === type && now - (prev.seenAt || 0) > 3600 * 1000) {
    prev.seenAt = now;
    changed = true;
  }
  if (accepted && type === 'group' && msgId && senderStaffId) {
    store.inbound[`${id}|${msgId}`] = { senderStaffId: String(senderStaffId), at: now };
    changed = true;
  }
  if (!changed) return;
  prune(store, now);
  writeStore(file, store);
}

/** @returns {'p2p'|'group'|null} */
export function lookupConversationType(store, id) {
  const t = store?.conversations?.[id]?.type;
  return t === 'p2p' || t === 'group' ? t : null;
}

/** @returns {{senderStaffId: string}|null} */
export function lookupInbound(store, id, msgId, now = Date.now()) {
  if (!id || !msgId) return null;
  const rec = store?.inbound?.[`${id}|${msgId}`];
  if (!rec?.senderStaffId || !(now - rec.at <= INBOUND_TTL_MS)) return null; // missing/bad `at` = expired
  return { senderStaffId: rec.senderStaffId };
}
