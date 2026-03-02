# zylos-dingtalk Design

## Architecture

```
DingTalk Cloud
    |
    | WebSocket (Stream SDK)
    v
[DWClient - dingtalk-stream]
    |
    | TOPIC_ROBOT callback
    v
[src/index.js]
    |
    | Permission check + format
    | execFile c4-receive.js
    v
[C4 Bridge] --> Claude Agent
    |
    | execFile send.js
    v
[scripts/send.js]
    |
    | sessionWebhook (preferred) or REST API
    v
DingTalk Cloud --> User
```

## Key Design Decisions

### Stream Mode Only (No Webhook Server)
DingTalk Stream mode uses a persistent WebSocket connection initiated by the client.
No public HTTPS endpoint needed. The `dingtalk-stream` SDK handles connection,
reconnection, and keepalive automatically.

### Session Webhook for Replies
Each incoming message includes a `sessionWebhook` URL valid for ~10 minutes.
send.js tries this first (fastest path), then falls back to the proactive send API.

### No Encryption Module
Unlike WeCom (AES-256-CBC), DingTalk Stream handles all auth/encryption at the
SDK level. No crypto.js needed.

### Token Management
- AppKey + AppSecret -> access_token (7200s lifetime)
- Cached with 5-min refresh margin
- client.js handles token lifecycle; send.js has its own standalone cache

### Internal API
index.js exposes an HTTP server on 127.0.0.1:4460 for:
- `/internal/get-webhook` — send.js looks up sessionWebhook for an endpoint
- `/internal/record-outgoing` — send.js records sent messages to chat history
- Authenticated via random UUID token in `.internal-token` file

## Data Flow

### Inbound
1. DingTalk pushes message via Stream WebSocket
2. index.js receives via TOPIC_ROBOT callback
3. Dedup check (5-min TTL)
4. Permission check (owner/DM policy/group policy)
5. User name resolution (API + cache)
6. Store sessionWebhook for later reply use
7. Record to chat history
8. Format C4 message with context
9. Forward to C4 Bridge via c4-receive.js

### Outbound
1. C4 Bridge calls send.js with endpoint + message
2. Parse endpoint (staffId|type:p2p or conversationId|type:group)
3. Check for media prefix ([MEDIA:image] or [MEDIA:file])
4. Chunk long messages (2000 char limit, markdown-aware)
5. Try sessionWebhook first, fall back to REST API
6. Record outgoing to history via internal API

## Configuration

| Location | Content |
|----------|---------|
| `~/zylos/.env` | DINGTALK_APP_KEY, DINGTALK_APP_SECRET, DINGTALK_ROBOT_CODE |
| `~/zylos/components/dingtalk/config.json` | Runtime config (policies, groups, etc.) |

## Access Control

Same model as wecom:
- **Owner**: First DM sender auto-binds; always allowed
- **DM Policy**: open / allowlist / owner
- **Group Policy**: disabled / allowlist / open
- **Per-group**: allowFrom list, mode (mention/smart)
