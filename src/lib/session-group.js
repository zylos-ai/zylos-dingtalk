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
 * non-base64 conversation ids are rejected.
 * A staffId that starts with [A-Za-z0-9], uses only [A-Za-z0-9_.:-] and fits
 * the length limit is used as-is (`dm-<staffId>`). Any other staffId (`@`,
 * Chinese, spaces, leading `_`...) gets a local short id `dm-_<n>`, assigned
 * once and kept in `session-groups.json` in the component data dir. Plain
 * names always have an alphanumeric right after `dm-`, so `dm-_<n>` can never
 * equal one. Short ids are never reused: a corrupt or invalid store is an
 * error (never reset or overwritten), each write also writes a durable `.bak`,
 * a missing store is restored from `.bak`, and new numbers start at
 * max(stored next, highest stored id + 1, current time in ms).
 * The component never adds a namespace; Core does.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';

/** Core's limits for the name a component passes (Core adds `<namespace>:`). */
export const SESSION_GROUP_MAX_LENGTH = 95;
export const SESSION_GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
export const SESSION_GROUP_STORE = path.join(DATA_DIR, 'session-groups.json');

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
const PLAIN_STAFF_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const SHORT_ID = /^dm-_(\d+)$/;

function groupId(id) {
  if (!BASE64_ID.test(id)) throw new Error(`conversation id is not base64: ${JSON.stringify(id.slice(0, 64))}`);
  return id.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '.');
}

function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  try {
    const dfd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* directory fsync unsupported */ }
}

function validateStore(data, source) {
  const ok = data !== null && typeof data === 'object' && !Array.isArray(data)
    && data.ids !== null && typeof data.ids === 'object' && !Array.isArray(data.ids)
    && Number.isSafeInteger(data.next) && data.next >= 1
    && Object.values(data.ids).every(v => typeof v === 'string' && SHORT_ID.test(v));
  if (!ok) throw new Error(`session group store ${source} is invalid; refusing to use or overwrite it`);
  const values = Object.values(data.ids);
  if (new Set(values).size !== values.length) {
    throw new Error(`session group store ${source} maps two staffIds to one group; refusing to use it`);
  }
  return data;
}

function parseStoreFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`session group store ${file} is not valid JSON; refusing to use or overwrite it`);
  }
  return validateStore(data, file);
}

/**
 * Only a missing store (and missing backup) is empty; anything unreadable or
 * malformed throws and is left untouched.
 */
export function readGroupStore(storePath = SESSION_GROUP_STORE) {
  try {
    return parseStoreFile(storePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    const restored = parseStoreFile(`${storePath}.bak`);
    console.warn(`[dingtalk] ${storePath} missing; using backup ${storePath}.bak`);
    return restored;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { ids: {}, next: 1 };
}

/**
 * Cross-process lock (the component and scripts/session-group.js both assign),
 * so two processes never give one staffId two different short ids.
 */
function withLock(storePath, fn) {
  const lock = `${storePath}.lock`;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx', 0o600));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.unlinkSync(lock); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error(`session group store ${storePath} is locked`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  }
}

function shortDmGroup(staffId, storePath, now) {
  const cached = readGroupStore(storePath).ids[staffId];
  if (cached) return cached;
  return withLock(storePath, () => {
    const store = readGroupStore(storePath);
    if (store.ids[staffId]) return store.ids[staffId];
    let max = 0;
    for (const v of Object.values(store.ids)) max = Math.max(max, Number(SHORT_ID.exec(v)[1]));
    const n = Math.max(store.next, max + 1, now());
    const name = `dm-_${n}`;
    store.ids[staffId] = name;
    store.next = n + 1;
    // Backup first, both durable: if the main file is lost later, the backup
    // already holds every assigned id.
    writeJsonAtomic(`${storePath}.bak`, store);
    writeJsonAtomic(storePath, store);
    return name;
  });
}

/**
 * @param {string} endpoint
 * @param {object} [opts]
 * @param {string} [opts.storePath] - short-id store (tests)
 * @param {() => number} [opts.now] - clock for new short ids (tests)
 * @returns {string} group name
 * @throws {Error} invalid endpoint, non-base64 group id, or corrupt store
 */
export function sessionGroupFromEndpoint(endpoint, { storePath = SESSION_GROUP_STORE, now = Date.now } = {}) {
  const ep = parseEndpoint(endpoint);
  if (!ep.id) throw new Error(`invalid DingTalk endpoint: ${JSON.stringify(String(endpoint ?? '').slice(0, 64))}`);
  const id = String(ep.id);
  let name;
  if (ep.type === 'group') {
    name = `group-${groupId(id)}`;
  } else {
    name = `dm-${id}`;
    if (!PLAIN_STAFF_ID.test(id) || !isValidSessionGroup(name)) name = shortDmGroup(id, storePath, now);
  }
  if (!isValidSessionGroup(name)) {
    throw new Error(`cannot map endpoint id to a session group: ${JSON.stringify(id.slice(0, 64))}`);
  }
  return name;
}
