/**
 * Session-group mapping for zylos-core multi-session mode.
 *
 * The group name is derived only from the reply endpoint, so the inbound
 * `--session-group` value and `scripts/session-group.js <endpoint>` always
 * agree. Rules (fixed once live; changing them needs a migration):
 *   1:1 chat  `<staffId>|type:p2p|...`        -> dm-<staffId>
 *   group     `<conversationId>|type:group|...` -> group-<conversationId>
 * Core only accepts [A-Za-z0-9_.:-], so the id is mapped reversibly:
 * `+` -> `-`, `/` -> `_`, `=` -> `.`. DingTalk conversation ids are base64
 * (no `-`, `_` or `.`), so the mapping stays one-to-one.
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

function safeId(id) {
  return String(id).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '.');
}

/**
 * @param {string} endpoint
 * @returns {string} group name
 * @throws {Error} when the endpoint has no usable id
 */
export function sessionGroupFromEndpoint(endpoint) {
  const ep = parseEndpoint(endpoint);
  if (!ep.id) throw new Error(`invalid DingTalk endpoint: ${JSON.stringify(String(endpoint ?? '').slice(0, 64))}`);
  const name = `${ep.type === 'group' ? 'group' : 'dm'}-${safeId(ep.id)}`;
  if (!isValidSessionGroup(name)) {
    throw new Error(`cannot map endpoint id to a session group: ${JSON.stringify(ep.id.slice(0, 64))}`);
  }
  return name;
}
