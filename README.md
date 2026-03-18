# zylos-dingtalk

DingTalk (钉钉) communication component for [Zylos](https://github.com/zylos-ai).

## Features

- **Stream mode** — WebSocket connection via official `dingtalk-stream` SDK, no public URL needed
- **DM & group support** — receive and reply to both private and group messages
- **Access control** — owner auto-binding, DM policies, group allowlists
- **Rich messaging** — text, markdown, images, files
- **Smart replies** — session webhook for fast replies, REST API fallback
- **Message context** — group messages include recent chat history
- **Retry & queue** — exponential backoff for transient errors, file-based send queue with LLM-powered message merging for offline delivery
- **Private IP detection** — automatically retries when DingTalk gateway returns VPC-internal addresses
- **Admin CLI** — manage configuration without editing JSON

## Requirements

- Node.js 20+
- DingTalk Enterprise Internal Application with Robot capability
- Stream mode enabled in DingTalk Developer Console

## Installation

```bash
# Via zylos component manager
zylos add dingtalk
```

## Configuration

Add to `~/zylos/.env`:
```bash
DINGTALK_APP_KEY=your_app_key
DINGTALK_APP_SECRET=your_app_secret
DINGTALK_ROBOT_CODE=your_robot_code
```

## DingTalk Console Setup

1. Go to [DingTalk Open Platform](https://open-dev.dingtalk.com/)
2. Create an Enterprise Internal Application
3. Enable "Robot" capability
4. Set message receiving mode to **Stream**
5. Copy App Key, App Secret, and Robot Code

## Architecture

```
src/
├── index.js          # Main entry — Stream WebSocket receiver
├── admin.js          # Admin CLI
└── lib/
    ├── config.js     # Configuration management
    ├── client.js     # DingTalk API client (token, V1/V2 requests)
    ├── contact.js    # User info lookup
    ├── message.js    # Send functions (DM, group, media)
    └── retry.js      # Shared retry logic (isRetryable, withRetry)
scripts/
└── send.js           # C4 outbound message interface (CLI)
hooks/
├── post-install.js   # Setup data dirs, default config
├── pre-upgrade.js    # Backup before upgrade
└── post-upgrade.js   # Config migration
```

## Admin CLI

```bash
node src/admin.js help
node src/admin.js show
node src/admin.js set-dm-policy allowlist
node src/admin.js add-dm-allow <staff_id>
node src/admin.js add-group <conversation_id> "Group Name" mention
```

## Send Script

```bash
# Text message
node scripts/send.js "<endpoint>" "Hello"

# Media
node scripts/send.js "<endpoint>" "[MEDIA:image]/path/to/image.png"
node scripts/send.js "<endpoint>" "[MEDIA:file]/path/to/doc.pdf"
```

Endpoint format: `staffId|type:p2p|msg:msgId` (DM) or `conversationId|type:group|msg:msgId` (group).

## Testing

```bash
npm test
```

## License

MIT
