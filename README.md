# zylos-dingtalk

DingTalk (钉钉) communication component for [Zylos](https://github.com/zylos-ai).

## Features

- **Stream mode** — WebSocket connection via official `dingtalk-stream` SDK, no public URL needed
- **DM & group support** — receive and reply to both private and group messages
- **Access control** — owner auto-binding, DM policies, group allowlists
- **Rich messaging** — text, markdown, images, files
- **Smart replies** — session webhook for fast replies, REST API fallback
- **Message context** — group messages include recent chat history
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

## Admin CLI

```bash
node src/admin.js help
node src/admin.js show
node src/admin.js set-dm-policy allowlist
node src/admin.js add-group <conversation_id> "Group Name" mention
```

## License

MIT
