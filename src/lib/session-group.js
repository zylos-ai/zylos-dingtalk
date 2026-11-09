/**
 * Session-group mapping for zylos-core multi-session mode.
 *
 * The group name is derived only from the reply endpoint, so the inbound
 * `--session-group` value and `scripts/session-group.js <endpoint>` always
 * agree. Rules (fixed once live; changing them needs a migration):
 *   1:1 chat  `<staffId>|type:p2p|...`        -> dm-<staffId>
 *   group     `<conversationId>|type:group|...` -> group-<conversationId>
 * Core only accepts [A-Za-z0-9_.:-], so the id is made base64url-safe:
 * `+` -> `-`, `/` -> `_`, trailing `=` padding dropped. DingTalk
 * conversation ids are base64 (no `-`/`_`), so the mapping stays unique.
 * The component never adds a namespace; Core does.
 */

export const MAX_GROUP_LENGTH = 95;
const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

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
  return String(id).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
  if (name.length > MAX_GROUP_LENGTH || !GROUP_NAME.test(name)) {
    throw new Error(`cannot map endpoint id to a session group: ${JSON.stringify(ep.id.slice(0, 64))}`);
  }
  return name;
}
