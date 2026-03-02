import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME || '/home/owen';
export const DATA_DIR = path.join(HOME, 'zylos/components/dingtalk');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const DEFAULT_CONFIG = {
  enabled: true,
  owner: { bound: false, staff_id: '', name: '' },
  dmPolicy: 'owner',          // 'open' | 'allowlist' | 'owner'
  dmAllowFrom: [],             // staff_ids
  groupPolicy: 'allowlist',   // 'open' | 'allowlist' | 'disabled'
  groups: {},                  // { conversationId: { name, mode, allowFrom } }
  proxy: { enabled: false, host: '', port: 0 },
  message: {
    context_messages: 10,
    useMarkdownCard: false,
  },
};

let config = null;
let watcher = null;
let debounceTimer = null;

export function getConfig() {
  if (config) return config;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const loaded = JSON.parse(raw);
    config = { ...DEFAULT_CONFIG, ...loaded };
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
  return config;
}

export function saveConfig(newConfig) {
  try {
    const tmpPath = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(newConfig, null, 2));
    fs.renameSync(tmpPath, CONFIG_PATH);
    config = newConfig;
    return true;
  } catch (err) {
    console.error('[dingtalk] Failed to save config:', err.message);
    return false;
  }
}

export function watchConfig(callback) {
  if (watcher) return;
  try {
    watcher = fs.watch(path.dirname(CONFIG_PATH), (eventType, filename) => {
      if (filename !== 'config.json') return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        try {
          const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
          const loaded = JSON.parse(raw);
          config = { ...DEFAULT_CONFIG, ...loaded };
          console.log('[dingtalk] Config reloaded');
          if (callback) callback(config);
        } catch (err) {
          console.error('[dingtalk] Config reload error:', err.message);
        }
      }, 100);
    });
  } catch (err) {
    console.error('[dingtalk] Failed to watch config:', err.message);
  }
}

export function stopWatching() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

export function getCredentials() {
  return {
    app_key: process.env.DINGTALK_APP_KEY || '',
    app_secret: process.env.DINGTALK_APP_SECRET || '',
    robot_code: process.env.DINGTALK_ROBOT_CODE || '',
  };
}
