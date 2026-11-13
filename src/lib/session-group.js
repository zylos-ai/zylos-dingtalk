/**
 * Session-group mapping for zylos-core multi-session mode.
 *
 * The group name is derived only from the reply endpoint, so the inbound
 * `--session-group` value and `scripts/session-group.js <endpoint>` always
 * agree. Rules (fixed once live; changing them needs a migration):
 *   1:1 chat  `<staffId>|type:p2p|...`        -> dm-<staffId>
 *   group     `<conversationId>|type:group|...` -> group-<conversationId>
 * Core only accepts [A-Za-z0-9_.:-]. Conversation ids must be base64
 * ([A-Za-z0-9+/=]) and are mapped `+` -> `-`, `/` -> `_`, `=` -> `.`;
 * staffIds must already be in Core's alphabet and are not rewritten.
 * Non-conforming ids are rejected (never sent), keeping the mapping one-to-one.
 * The component never adds a namespace; Core does.
 */

/** Core's limits for the name a component passes (Core adds `<namespace>:`). */
export const SESSION_GROUP_MAX_LENGTH = 95;
export const SESSION_GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/**
 * Whether Core would accept this nonempty name.
 * @param {string} name
 * @returns {boolean}
 */
export function isValidSessionGroup(name) {
  return typeof name === 'string' && name.length <= SESSION_GROUP_MAX_LENGTH
    && SESSION_GROUP_PATTERN.test(name);
}

export function parseEndpoint(ep) {
  const parts = String(ep ?? '').split('|');
  const result = { id: parts[0] };
  for (const part of parts.slice(1)) {
    const idx = part.indexOf(':');
    if (idx > 0) result[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return result;
}

const BASE64_ID = /^[A-Za-z0-9+/=]+$/;
const PLAIN_ID = /^[A-Za-z0-9_.:-]+$/;

/**
 * Group conversation ids must be base64 and are mapped `+`->`-`, `/`->`_`,
 * `=`->`.`; staffIds are used as-is and must already be in Core's alphabet.
 * Anything else is rejected, so the mapping stays one-to-one for any input.
 */
function safeId(id, isGroup) {
  id = String(id);
  if (isGroup) {
    if (!BASE64_ID.test(id)) throw new Error(`conversation id is not base64: ${JSON.stringify(id.slice(0, 64))}`);
    return id.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '.');
  }
  if (!PLAIN_ID.test(id)) throw new Error(`staffId has characters outside [A-Za-z0-9_.:-]: ${JSON.stringify(id.slice(0, 64))}`);
  return id;
}

/**
 * @param {string} endpoint
 * @returns {string} group name
 * @throws {Error} when the endpoint has no usable id
 */
export function sessionGroupFromEndpoint(endpoint) {
  const ep = parseEndpoint(endpoint);
  if (!ep.id) throw new Error(`invalid DingTalk endpoint: ${JSON.stringify(String(endpoint ?? '').slice(0, 64))}`);
  const isGroup = ep.type === 'group';
  const name = `${isGroup ? 'group' : 'dm'}-${safeId(ep.id, isGroup)}`;
  if (!isValidSessionGroup(name)) {
    throw new Error(`cannot map endpoint id to a session group: ${JSON.stringify(ep.id.slice(0, 64))}`);
  }
  return name;
}
