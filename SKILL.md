---
name: dingtalk
version: 0.3.0
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
- File content extraction (PDF, docx, txt)
- Markdown card rendering
- Thinking emoji reaction with 3s minimum display
- Message context history for groups
- Resilient connection: 503 retry, null endpoint tolerance, auto-reconnect
- Connection health watchdog (30s interval, 3min timeout)
- WebSocket close/error event-driven reconnect
- Exponential backoff retry for transient/throttle errors
- File-based send queue (max 10, 30min TTL, FIFO) for offline delivery
- LLM-powered message merging for queued messages
- Private IP detection for DingTalk gateway endpoint
- Log sanitization (no user content in logs)

## Session Groups (multi-session Core)

With a zylos-core that supports multi-session, each inbound message carries a
session group, so every DingTalk conversation gets its own conversation thread.
Replies still go through the same `reply via` path.

| Conversation | Session group | Example |
|---|---|---|
| 1:1 chat | `dm-<staffId>` | `dm-manager4567` |
| Group | `group-<conversationId>` | `group-cidAbC-dE_f12..` |

- Conversation ids are base64; `+` becomes `-`, `/` becomes `_`, `=` becomes
  `.` (reversible, so names stay one-to-one) to make the name valid for Core.
- The group is passed only if the installed Core lists `--session-group` in
  `c4-receive-options.json`; older Cores behave exactly as before.

```bash
node ~/zylos/.claude/skills/dingtalk/scripts/session-group.js "<endpoint>"
```

## Outbound Policy

`send.js` checks the destination before sending (and again for queued
retries):
- **DM:** only to the owner or users the DM policy allows (`dmPolicy` /
  `dmAllowFrom`).
- **Group:** only enabled groups (`groupPolicy: open`, or listed under
  `groups`). In any other group, including `groupPolicy: disabled`, only a
  reply to a message the owner sent there is allowed, while its reply link is
  still valid (about 1-2 hours, lost on component restart).
- Blocked sends exit 1 with `outbound blocked` and are not queued.

## Admin CLI
```bash
node ~/zylos/.claude/skills/dingtalk/src/admin.js help
```

## Send Script
```bash
node ~/zylos/.claude/skills/dingtalk/scripts/send.js <endpoint> "message"
```

## Owner Requests: Enabling Groups and DMs

After the first DM binds the owner, the bot sends the owner a one-time guide
telling them which phrases to use. These are **owner-only** admin changes.
Group messages carry only the sender's nickname (no staffId), so the owner
cannot be reliably verified in an already-enabled group. Follow these rules
exactly:

**「开启本群」 (said in a group, @bot)**
1. Run `admin.js list-groups` first.
2. If the group (its conversationId) is **already listed**, do NOT run
   `add-group` again — re-adding resets its `allowFrom` to empty (open to
   everyone in the group). Make no change; reply that the group is already
   enabled, and that any group-admin change must be requested by the owner in
   a private chat.
3. Check `groupPolicy` (shown by `list-groups`). If it is `open`, every
   member's messages reach the Agent, so the sender cannot be verified as the
   owner: refuse group-admin changes in the group and ask the owner to do it
   in a private chat. Only when `groupPolicy` is `allowlist` or `disabled`
   **and** the group is not listed is the group not enabled; there only the
   owner's messages reach the Agent (owner bypass), so honor it: run
   `admin.js add-group <conversationId> "<group name>"` — the conversationId is the first segment of the group reply endpoint
   (`<conversationId>|type:group|msg:...`), the name comes from
   `[DingTalk GROUP:<name>]`. If `groupPolicy` is `disabled`, also run
   `admin.js set-group-policy allowlist`.
4. In an already-enabled group, refuse every other group-admin change
   (allowFrom, remove-group, policy) and ask the owner to do it in a private
   chat.

**DM-policy phrases — private chat with the owner only.** Honor them only in
a DM whose sender staffId (first segment of the DM endpoint
`<staff_id>|type:p2p|msg:...`) equals the owner's staff_id from
`admin.js show-owner`. Refuse them in groups or from anyone else.
- 「允许所有同事私聊你」 → `admin.js set-dm-policy open`
- 「允许某某私聊你」 → get that person's staffId (first segment of their DM
  endpoint, or ask the owner), then `admin.js add-dm-allow <staff_id>`; if
  `dmPolicy` is `owner`, also run `admin.js set-dm-policy allowlist`.

Config changes are hot-reloaded by the running service. Confirm the result to
the owner in the same chat.

## Blocked Group Messages

When a group message is blocked by access control and the bot was @-mentioned,
the bot replies once in the group (non-mentions are ignored silently):
- group not enabled (policy `disabled`, or `allowlist` and the group is not configured):
  「本群还没开通，请联系 Agent 管理者开启」
- group enabled but the sender is not in its `allowFrom`:
  「你在本群暂无权限使用我，请联系 Agent 管理者开通」
