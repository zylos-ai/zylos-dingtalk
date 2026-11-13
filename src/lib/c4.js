/**
 * Inbound delivery to C4 (c4-receive), with session groups for
 * multi-session zylos-core.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sessionGroupFromEndpoint } from './session-group.js';

export function getC4ReceivePath() {
  return path.join(process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'),
    '.claude/skills/comm-bridge/scripts/c4-receive.js');
}

/**
 * Whether the installed Core's c4-receive accepts an option. Read from
 * c4-receive-options.json next to c4-receive.js on every call; a missing or
 * unreadable manifest means "not supported" (older Core), never a version check.
 */
export function c4ReceiveSupportsOption(name) {
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(path.dirname(getC4ReceivePath()), 'c4-receive-options.json'), 'utf8'));
    return manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
      && manifest.options !== null && typeof manifest.options === 'object'
      && !Array.isArray(manifest.options) && Object.hasOwn(manifest.options, name);
  } catch {
    return false;
  }
}

export function buildC4ReceiveArgs({ channel, endpoint, content, sessionGroup }) {
  const args = ['--channel', channel, '--endpoint', endpoint, '--json', '--content', content];
  if (sessionGroup != null && sessionGroup !== '' && c4ReceiveSupportsOption('--session-group')) {
    args.push('--session-group', sessionGroup);
  }
  return args;
}

// User-facing texts (Chinese only, by owner decision).
export const GENERIC_REJECT_REPLY = '抱歉，这条消息暂时没能处理，请稍后再试。';
export const UNCERTAIN_REPLY = '抱歉，这条消息可能没有送达。如果几分钟后还没收到回复，请重新发送。';

/**
 * Classify a structured c4-receive rejection by error.persisted:
 * non-empty array = Core committed the inbound row (send nothing, do not resend);
 * empty array = nothing stored; anything else = Core cannot tell.
 * @returns {'committed'|'not_stored'|'uncertain'}
 */
export function classifyC4Rejection(response) {
  const persisted = response?.error?.persisted;
  if (!Array.isArray(persisted)) return 'uncertain';
  return persisted.length > 0 ? 'committed' : 'not_stored';
}

/**
 * True when c4-receive never started (spawn itself failed), so Core cannot
 * have stored anything. Any other failure without a structured result has an
 * unknown commit state and is never retried (Core c4-receive contract).
 */
export function neverStarted(error) {
  return typeof error?.code === 'string'
    && typeof error.syscall === 'string' && error.syscall.startsWith('spawn');
}

export function parseC4Response(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(String(stdout).trim());
  } catch {
    return null;
  }
}

/**
 * Send an inbound message to the agent via C4.
 * The session group is derived from the endpoint and passed only when the
 * installed Core lists --session-group (rechecked on every call, including the
 * retry). A rejected group is never dropped and resent to the overall group,
 * and Core's error text (written for the agent) only goes to the log.
 * No component-side timeout kills c4-receive. Only a call that never started
 * (spawn failure) is retried once; a structured `ok:false` follows
 * error.persisted; any other failure is uncertain and never resent.
 * @param {string} channel
 * @param {string} endpoint
 * @param {string} content
 * @param {function} [onReject] - Called once when the agent will not answer:
 *   with a user-facing notice to send, or null when Core already committed
 *   the inbound row (send nothing)
 * @param {object} [opts]
 * @param {number} [opts.retryDelayMs=2000]
 * @param {function} [opts.onDone] - Test hook: called with the final outcome
 * @param {function} [opts.exec] - Test hook replacing child_process.execFile
 */
export function sendToC4(channel, endpoint, content, onReject, { retryDelayMs = 2000, onDone, exec = execFile } = {}) {
  const done = (outcome) => { if (onDone) onDone(outcome); };
  if (!content) {
    console.error('[dingtalk] sendToC4 called with empty content');
    onReject?.(GENERIC_REJECT_REPLY);
    return done('rejected');
  }
  let sessionGroup;
  try {
    sessionGroup = sessionGroupFromEndpoint(endpoint);
  } catch (err) {
    // Never fall back to the overall group.
    console.error(`[dingtalk] cannot derive session group, not sending: ${err.message}`);
    onReject?.(GENERIC_REJECT_REPLY);
    return done('rejected');
  }

  const run = (cb) => exec(process.execPath,
    [getC4ReceivePath(), ...buildC4ReceiveArgs({ channel, endpoint, content, sessionGroup })],
    { encoding: 'utf8' }, cb);

  const handleRejection = (response, label) => {
    const { code, message } = response.error;
    const kind = classifyC4Rejection(response);
    if (kind === 'committed') {
      console.warn(`[dingtalk] C4 ${label} after commit (${code}), not resending: ${message}`);
      onReject?.(null);
      return done('committed');
    }
    console.warn(`[dingtalk] C4 ${label} (${code}, ${kind}) [group=${sessionGroup}]: ${message}`);
    onReject?.(kind === 'not_stored' ? GENERIC_REJECT_REPLY : UNCERTAIN_REPLY);
    return done('rejected');
  };

  const handleUnknown = (error, label) => {
    // c4-receive ran: Core may have stored the message. Never resend.
    console.error(`[dingtalk] C4 ${label}, outcome unknown, not resending [group=${sessionGroup}]: ${error.message}`);
    onReject?.(UNCERTAIN_REPLY);
    return done('failed');
  };

  const handleResult = (error, stdout, label) => {
    const response = parseC4Response(stdout);
    if (!error || response?.ok === true) {
      if (error) console.warn(`[dingtalk] c4-receive reported ok but exited with an error, treating as delivered: ${error.message}`);
      return done('sent');
    }
    if (response?.ok === false && response.error?.message) return handleRejection(response, label);
    return null;
  };

  run((error, stdout) => {
    const handled = handleResult(error, stdout, 'rejected');
    if (handled !== null) return handled;
    if (!neverStarted(error)) return handleUnknown(error, 'send failed');
    console.warn(`[dingtalk] c4-receive did not start, retrying in ${retryDelayMs}ms: ${error.message}`);
    setTimeout(() => {
      run((retryError, retryStdout) => {
        const retried = handleResult(retryError, retryStdout, 'rejected after retry');
        if (retried !== null) return retried;
        if (neverStarted(retryError)) {
          console.error(`[dingtalk] c4-receive did not start after retry: ${retryError.message}`);
          onReject?.(GENERIC_REJECT_REPLY);
          return done('rejected');
        }
        return handleUnknown(retryError, 'send failed after retry');
      });
    }, retryDelayMs);
  });
}
