#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME || '/home/owen';
const DATA_DIR = path.join(HOME, 'zylos/components/dingtalk');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

console.log('[dingtalk post-upgrade] Running config migrations...');

// Ensure directories exist
for (const dir of ['logs', 'media']) {
  fs.mkdirSync(path.join(DATA_DIR, dir), { recursive: true });
}

// Migrate config
if (fs.existsSync(CONFIG_PATH)) {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    let migrated = false;

    // Ensure all required fields exist
    if (config.owner === undefined) {
      config.owner = { bound: false, staff_id: '', name: '' };
      migrated = true;
    }
    if (config.dmPolicy === undefined) {
      config.dmPolicy = 'owner';
      migrated = true;
    }
    if (config.dmAllowFrom === undefined) {
      config.dmAllowFrom = [];
      migrated = true;
    }
    if (config.groupPolicy === undefined) {
      config.groupPolicy = 'allowlist';
      migrated = true;
    }
    if (config.groups === undefined) {
      config.groups = {};
      migrated = true;
    }
    if (config.message === undefined) {
      config.message = { context_messages: 10, useMarkdownCard: false };
      migrated = true;
    }
    if (config.message && config.message.context_messages === undefined) {
      config.message.context_messages = 10;
      migrated = true;
    }
    if (config.message && config.message.useMarkdownCard === undefined) {
      config.message.useMarkdownCard = false;
      migrated = true;
    }

    if (migrated) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log('[dingtalk post-upgrade] Config migrated with new fields');
    } else {
      console.log('[dingtalk post-upgrade] Config is up to date');
    }
  } catch (err) {
    console.error('[dingtalk post-upgrade] Config migration failed:', err.message);
  }
}

console.log('[dingtalk post-upgrade] Complete!');
