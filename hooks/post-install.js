#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = path.join(os.homedir(), 'zylos/components/dingtalk');

const DEFAULT_CONFIG = {
  enabled: true,
  owner: { bound: false, staff_id: '', name: '' },
  dmPolicy: 'owner',
  dmAllowFrom: [],
  groupPolicy: 'allowlist',
  groups: {},
  proxy: { enabled: false, host: '', port: 0 },
  message: {
    context_messages: 10,
    useMarkdownCard: false,
  },
};

console.log('[dingtalk post-install] Setting up data directories...');

// Create directories
for (const dir of ['logs', 'media']) {
  fs.mkdirSync(path.join(DATA_DIR, dir), { recursive: true });
}

// Create default config if not exists
const configPath = path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
  console.log('[dingtalk post-install] Default config created');
} else {
  console.log('[dingtalk post-install] Config exists, preserved');
}

// Check environment
const envPath = path.join(os.homedir(), 'zylos/.env');
if (fs.existsSync(envPath)) {
  const env = fs.readFileSync(envPath, 'utf8');
  const missing = [];
  if (!env.includes('DINGTALK_APP_KEY')) missing.push('DINGTALK_APP_KEY');
  if (!env.includes('DINGTALK_APP_SECRET')) missing.push('DINGTALK_APP_SECRET');
  if (!env.includes('DINGTALK_ROBOT_CODE')) missing.push('DINGTALK_ROBOT_CODE');

  if (missing.length > 0) {
    console.log(`\n[dingtalk post-install] Missing env vars in .env: ${missing.join(', ')}`);
    console.log('Add these to ~/zylos/.env before starting the service.');
  }
}

console.log(`
[dingtalk post-install] Complete!

Next steps:
1. Add credentials to ~/zylos/.env:
   DINGTALK_APP_KEY=<your app key>
   DINGTALK_APP_SECRET=<your app secret>
   DINGTALK_ROBOT_CODE=<your robot code>

2. In DingTalk Developer Console:
   - Create an Enterprise Internal App
   - Enable "Robot" capability
   - Set message receiving mode to "Stream"
   - Note your App Key, App Secret, and Robot Code

3. Start the service:
   pm2 start ~/zylos/.claude/skills/dingtalk/ecosystem.config.cjs
   pm2 save
`);
