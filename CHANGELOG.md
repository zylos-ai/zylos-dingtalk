# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-03-02

### Added
- Initial release
- Stream mode via dingtalk-stream SDK (WebSocket)
- DM and group message receiving
- Text, markdown, image, file sending
- Session webhook reply (preferred) + REST API fallback
- Owner auto-binding on first DM
- DM access control (open/allowlist/owner)
- Group access control (disabled/allowlist/open) with per-group config
- Admin CLI for configuration management
- Message chunking with markdown-aware splitting
- User name resolution with caching
- Chat history context for group messages
- Internal API for session webhook lookup and outgoing recording
- PM2 service management
- Config hot-reload
- Lifecycle hooks (post-install, pre-upgrade, post-upgrade)
