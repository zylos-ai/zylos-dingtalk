# Changelog

All notable changes to this project will be documented in this file.

## [0.1.1] - 2026-03-18

### Added
- Exponential backoff retry (1s→2s→4s, max 3 retries) for 429/throttle/transient network errors
- File-based send queue (`.send-queue.json`, max 10, FIFO, 30min TTL) for offline message delivery
- LLM-powered message merging for queued messages to same recipient (Claude Haiku, fallback to dedup)
- Delay notice sent to recipients after queued messages are delivered
- Concurrent-safe file lock (`O_EXCL` atomic create, 30s stale detection) for queue operations
- Lock file cleanup on process exit
- Private IP detection for DingTalk Stream gateway endpoint (RFC 1918, retry up to 3x)
- Send logging with response validation for all outbound messages
- Unit tests: 59 tests covering retry, validation, send queue, chunking, and client/message modules

### Changed
- Extracted shared retry logic (`isRetryable`, `withRetry`) to `src/lib/retry.js` — single source of truth
- Replaced hardcoded home directory fallbacks with `os.homedir()` across all files
- Pinned `dingtalk-stream` to exact version `2.1.4` (uses private `_connect()` method)
- `validateResponse` now handles string `"0"` code from V2 API responses correctly
- Replaced synchronous busy-wait in lock acquisition with async `setTimeout`
- `sendMedia` now refreshes access token on each retry attempt (prevents token expiry across retries)
- `sendMedia` validates `DINGTALK_ROBOT_CODE` before attempting upload

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
