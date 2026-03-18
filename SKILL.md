---
name: dingtalk
version: 0.1.1
description: >
  DingTalk (钉钉) communication channel. Receives messages via Stream mode
  (WebSocket) and sends messages via DingTalk REST API. Use when:
  (1) replying to DingTalk messages (DM or group),
  (2) sending proactive messages or media (images, files) to DingTalk users,
  (3) managing DM access control (dmPolicy: open/allowlist/owner, dmAllowFrom list),
  (4) managing group access control (groupPolicy, per-group allowFrom),
  (5) configuring the bot (admin CLI, markdown settings),
  (6) troubleshooting DingTalk connection or message delivery issues.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-dingtalk
    entry: src/index.js
  data_dir: ~/zylos/components/dingtalk
  hooks:
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - user-cache.json
    - logs/
    - media/

upgrade:
  repo: zylos-ai/zylos-dingtalk
  branch: main

config:
  required:
    - name: DINGTALK_APP_KEY
      description: App Key from DingTalk developer console
      sensitive: false
    - name: DINGTALK_APP_SECRET
      description: App Secret from DingTalk developer console
      sensitive: true
    - name: DINGTALK_ROBOT_CODE
      description: Robot Code for proactive messaging
      sensitive: false
  optional: []

dependencies:
  - comm-bridge
---

# DingTalk Component

Connects DingTalk (钉钉) to the Zylos agent via C4 Communication Bridge.

## Features
- Stream mode (WebSocket) — no public URL needed
- DM and group message support
- Owner auto-binding on first DM
- Access control (DM policy + group allowlists)
- Media upload/download (images, files)
- Markdown card rendering
- Message context history for groups
- Exponential backoff retry for transient/throttle errors
- File-based send queue (max 10, 30min TTL, FIFO) for offline delivery
- LLM-powered message merging for queued messages
- Private IP detection for DingTalk gateway endpoint

## Admin CLI
```bash
node ~/zylos/.claude/skills/dingtalk/src/admin.js help
```

## Send Script
```bash
node ~/zylos/.claude/skills/dingtalk/scripts/send.js <endpoint> "message"
```
