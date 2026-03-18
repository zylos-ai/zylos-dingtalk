#!/usr/bin/env node

/**
 * DingTalk component admin CLI.
 *
 * Usage:
 *   node admin.js <command> [args...]
 */

import os from 'os';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(os.homedir(), 'zylos/.env') });

import { getConfig, saveConfig } from './lib/config.js';

const [command, ...args] = process.argv.slice(2);

function showHelp() {
  console.log(`
DingTalk Admin CLI

Commands:
  show                           Show full config
  show-owner                     Show owner info
  help                           Show this help

  set-dm-policy <open|allowlist|owner>   Set DM access policy
  list-dm-allow                  Show DM allowlist
  add-dm-allow <staff_id>        Add user to DM allowlist
  remove-dm-allow <staff_id>     Remove user from DM allowlist

  list-groups                    List configured groups
  add-group <conv_id> <name> [mode]  Add group (mode: mention|smart, default: mention)
  remove-group <conv_id>         Remove group
  set-group-policy <disabled|allowlist|open>  Set group policy
  set-group-allowfrom <conv_id> <staff_id...>  Set group allowFrom

  set-markdown <on|off>          Toggle markdown card rendering
`.trim());
}

function main() {
  if (!command || command === 'help') {
    showHelp();
    return;
  }

  const config = getConfig();

  switch (command) {
    case 'show': {
      console.log(JSON.stringify(config, null, 2));
      break;
    }

    case 'show-owner': {
      if (config.owner?.bound) {
        console.log(`Owner: ${config.owner.name} (${config.owner.staff_id})`);
      } else {
        console.log('Owner: not bound (first DM sender will become owner)');
      }
      break;
    }

    case 'set-dm-policy': {
      const policy = args[0];
      if (!['open', 'allowlist', 'owner'].includes(policy)) {
        console.error('Invalid policy. Use: open, allowlist, or owner');
        process.exit(1);
      }
      config.dmPolicy = policy;
      if (saveConfig(config)) {
        console.log(`DM policy set to: ${policy}`);
        console.log('Run: pm2 restart zylos-dingtalk');
      }
      break;
    }

    case 'list-dm-allow': {
      console.log(`DM Policy: ${config.dmPolicy}`);
      console.log(`Allowlist: ${(config.dmAllowFrom || []).join(', ') || '(empty)'}`);
      break;
    }

    case 'add-dm-allow': {
      const staffId = args[0];
      if (!staffId) { console.error('Usage: add-dm-allow <staff_id>'); process.exit(1); }
      if (!config.dmAllowFrom) config.dmAllowFrom = [];
      if (!config.dmAllowFrom.includes(staffId)) {
        config.dmAllowFrom.push(staffId);
        if (saveConfig(config)) {
          console.log(`Added ${staffId} to DM allowlist`);
          console.log('Run: pm2 restart zylos-dingtalk');
        }
      } else {
        console.log(`${staffId} already in allowlist`);
      }
      break;
    }

    case 'remove-dm-allow': {
      const staffId = args[0];
      if (!staffId) { console.error('Usage: remove-dm-allow <staff_id>'); process.exit(1); }
      config.dmAllowFrom = (config.dmAllowFrom || []).filter(id => id !== staffId);
      if (saveConfig(config)) {
        console.log(`Removed ${staffId} from DM allowlist`);
        console.log('Run: pm2 restart zylos-dingtalk');
      }
      break;
    }

    case 'list-groups': {
      console.log(`Group Policy: ${config.groupPolicy}`);
      const groups = config.groups || {};
      if (Object.keys(groups).length === 0) {
        console.log('No groups configured');
      } else {
        for (const [id, g] of Object.entries(groups)) {
          console.log(`  ${id}: ${g.name} (mode: ${g.mode || 'mention'}, allowFrom: ${(g.allowFrom || []).join(',') || 'all'})`);
        }
      }
      break;
    }

    case 'add-group': {
      const [convId, name, mode] = args;
      if (!convId || !name) {
        console.error('Usage: add-group <conv_id> <name> [mode]');
        process.exit(1);
      }
      if (!config.groups) config.groups = {};
      config.groups[convId] = {
        name,
        mode: mode || 'mention',
        allowFrom: [],
        added_at: new Date().toISOString(),
      };
      if (saveConfig(config)) {
        console.log(`Added group: ${name} (${convId}, mode: ${mode || 'mention'})`);
        console.log('Run: pm2 restart zylos-dingtalk');
      }
      break;
    }

    case 'remove-group': {
      const convId = args[0];
      if (!convId) { console.error('Usage: remove-group <conv_id>'); process.exit(1); }
      if (config.groups?.[convId]) {
        delete config.groups[convId];
        if (saveConfig(config)) {
          console.log(`Removed group: ${convId}`);
          console.log('Run: pm2 restart zylos-dingtalk');
        }
      } else {
        console.log(`Group ${convId} not found`);
      }
      break;
    }

    case 'set-group-policy': {
      const policy = args[0];
      if (!['disabled', 'allowlist', 'open'].includes(policy)) {
        console.error('Invalid policy. Use: disabled, allowlist, or open');
        process.exit(1);
      }
      config.groupPolicy = policy;
      if (saveConfig(config)) {
        console.log(`Group policy set to: ${policy}`);
        console.log('Run: pm2 restart zylos-dingtalk');
      }
      break;
    }

    case 'set-group-allowfrom': {
      const [convId, ...staffIds] = args;
      if (!convId || staffIds.length === 0) {
        console.error('Usage: set-group-allowfrom <conv_id> <staff_id...>');
        process.exit(1);
      }
      if (!config.groups?.[convId]) {
        console.error(`Group ${convId} not found. Add it first.`);
        process.exit(1);
      }
      config.groups[convId].allowFrom = staffIds;
      if (saveConfig(config)) {
        console.log(`Set allowFrom for ${convId}: ${staffIds.join(', ')}`);
        console.log('Run: pm2 restart zylos-dingtalk');
      }
      break;
    }

    case 'set-markdown': {
      const val = args[0];
      if (!['on', 'off'].includes(val)) {
        console.error('Usage: set-markdown <on|off>');
        process.exit(1);
      }
      if (!config.message) config.message = {};
      config.message.useMarkdownCard = val === 'on';
      if (saveConfig(config)) {
        console.log(`Markdown card: ${val}`);
        console.log('Run: pm2 restart zylos-dingtalk');
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

main();
