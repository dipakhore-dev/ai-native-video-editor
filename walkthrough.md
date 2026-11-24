# Security Summary

Phase 5.4 hardens the AI-Native Video Creation & Editing Platform across the Express/MongoDB backend, the Python FastAPI + FFmpeg media worker, and the React studio frontend while preserving local-first development (no Redis, paid object storage, or external database required).

### Backend & API Protections
- **Startup Secret & Origin Checks (`server/config/env.ts`, `server.ts`)**: Production mode blocks startup unless `JWT_SECRET` is at least 16 characters and any configured `VIDEO_PROCESSOR_URL` is paired with a 16+ character `VIDEO_PROCESSOR_API_KEY`. Local HTTP development remains functional out of the box.
- **CORS, CSRF & Security Headers (`server/middleware/security.middleware.ts`)**: Replaced permissive defaults with an explicit origin allowlist (never `*`), added CSRF validation on state-changing `/api` requests (`Sec-Fetch-Site: cross-site` and `Origin`/`Referer` verification), enabled iframe-compatible CSP (`frame-ancestors 'self' https://aistudio.google.com https://*.google.com https://*.googleusercontent.com`), `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, and disabled `X-Frame-Options: DENY` conflicts.
- **Input, Query & Auth Hardening (`server/middleware/auth.middleware.ts`, `server/services/*.ts`, `server/validators/*.ts`)**:
  - Pinned JWT signing and verification to `HS256` and validated `sub` as a MongoDB `ObjectId`.
  - Stripped `$`-prefixed operators and prototype pollution keys (`__proto__`, `constructor`, `prototype`) in-place from incoming `req.body` and `req.query`.
  - Added password complexity (`letters + digits`) on registration, strict `https:`/relative URL checks on `avatarUrl`, strict `ObjectId` checks on `projectId` filters (`400`), bounded query limits, and `2mb` JSON body limits.
- **Rate Limiting & Upload Validation (`server/middleware/rateLimit.middleware.ts`, `server/utils/fileMagic.ts`)**:
  - Added bounded in-memory rate limiters with `Retry-After` headers across auth, AI assistant, video processing, and MP4 export routes.
  - Added magic-byte container verification on Express uploads so disguised executables or invalid payloads named `.mp4` are rejected (`400`) and unlinked immediately.
- **Export Concurrency, Redaction & Lifecycle (`server/services/videoProcessor.service.ts`, `server/routes/index.ts`)**:
  - Enforced global and per-user active export slot limits (`MAX_CONCURRENT_EXPORTS`, `MAX_USER_ACTIVE_EXPORTS`) with `finally`-guaranteed release.
  - Redacted internal worker URLs (`VIDEO_PROCESSOR_URL`) and filesystem paths from `/api/integrations/status`, `/api/video/status`, and error responses, and sanitized `Content-Disposition` filenames.
  - Added `/api/health/live` and `/api/health/ready` endpoints, startup orphan job reconciliation, periodic stale temp-file cleanup (preserving active export files), and `SIGINT`/`SIGTERM` graceful shutdown.

### Python FastAPI & FFmpeg Protections
- **Fail-Closed Processor Auth & Validation (`video-processor/app/config.py`, `video-processor/app/main.py`)**: Enforces 16+ character `VIDEO_PROCESSOR_API_KEY` in production via constant-time `hmac.compare_digest` comparison and rejects invalid port/concurrency/storage configurations on startup.
- **Media, Path & Subtitle Safety (`video-processor/app/utils/file_cleanup.py`, `video-processor/app/services/ffmpeg_service.py`)**:
  - Enforced `resolve_within_base` path containment and magic-byte header verification (`validate_uploaded_file_magic`).
  - Added `-protocol_whitelist file,pipe` across FFmpeg, FFprobe, and Whisper extraction invocations.
  - Restricted ASS subtitle `fontFamily` values to safe alphanumeric/space/hyphen/underscore characters (max 64 chars) so style directives cannot be injected into `.ass` files.
- **Worker Concurrency, Disk Caps & Shutdown (`video-processor/app/main.py`, `video-processor/app/services/job_store.py`)**:
  - Added `BoundedSemaphore` export concurrency limiting (`429`), temp workspace storage quota checks (`503`), sanitized exception messages, periodic cleanup of stale `job_*` directories, and subprocess termination (`terminate_all_active`) on FastAPI shutdown.

### Frontend Resilience & User Safety
- **React Error Boundary & Session Recovery (`src/components/common/ErrorBoundary.tsx`, `src/App.tsx`, `src/services/api.ts`, `src/context/StudioContext.tsx`, `src/components/layout/StudioShell.tsx`)**:
  - Wrapped the workspace in `ErrorBoundary` with safe reload/recovery controls.
  - Sends `X-Requested-With: AIStudioClient` on API/XHR/FormData requests, detects unexpected `401` session expiration, preserves local IndexedDB/timeline work, and prompts re-authentication via a dismissible notice bar.
  - Warns via `beforeunload` when unsaved timeline changes or active exports are running, cleans up `EditorPage` timers on unmount, highlights destructive AI plan actions (`delete_clip`, `clear_clip_keyframes`) before confirmation, and adds safe `Escape` key handling to `CreateProjectModal` and idle `ExportModal`.

---

## PoC Verification

1. **Blocked Production Misconfiguration & Missing Processor Key**:
   - `validateStartupEnv({ NODE_ENV: "production", JWT_SECRET: "short" })` returned `ok: false` with a `JWT_SECRET` error.
   - `validateStartupEnv({ NODE_ENV: "production", JWT_SECRET: "...32chars...", VIDEO_PROCESSOR_URL: "https://processor.example.com", VIDEO_PROCESSOR_API_KEY: "short" })` returned `ok: false` blocking missing/weak processor keys.
   - Python `validate_runtime_settings` rejected empty, short, and placeholder `VIDEO_PROCESSOR_API_KEY` values when `APP_ENV=production`.
2. **CORS Allowlist, CSRF & Input Injection Defense (Real Local Express HTTP Server)**:
   - Sending `Origin: https://evil.attacker.test` or `Sec-Fetch-Site: cross-site` to `POST /api/echo` returned HTTP `403`.
   - Sending `{ "$gt": "", "nested": { "$where": "1==1", "constructor": { "bad": true }, "clean": 42 } }` stripped `$gt`, `$where`, and `constructor` before hitting the route handler while preserving `clean: 42`.
   - CSP allowed `https://aistudio.google.com` in `frame-ancestors` without setting `X-Frame-Options: DENY`.
3. **Spoofed Media Upload Rejection & Immediate Temp File Cleanup**:
   - Posting an `MZ\x90\x00#!/bin/sh` payload named `fake_video.mp4` (`Content-Type: video/mp4`) to a real Multer + `validateUploadedMediaMagicBytesMiddleware` HTTP endpoint returned HTTP `400` and left `0` files in the temporary upload directory.
   - Python `validate_uploaded_file_magic` accepted genuine `ftypisom` MP4 headers and rejected `MZ` / `ELF` headers with `FileValidationError(status_code=400)`.
4. **Rate Limiting & Export Concurrency Enforcement**:
   - Exceeding `createRateLimiter` (`maxRequests: 2`) returned HTTP `429` with `Retry-After` and `retryAfterSeconds`.
   - `acquireExportSlot` rejected a second concurrent export for the same user (`429`) and a third global export (`429`) when `MAX_CONCURRENT_EXPORTS=2`, then permitted new acquisitions once slots were released.
5. **FFmpeg Protocol Whitelist, Path Containment & ASS Font Sanitization**:
   - `inject_protocol_whitelist` inserted `-protocol_whitelist file,pipe` before `-i` inputs, and real `extract_video_metadata` + `trim_video` succeeded on a synthesized H.264/AAC clip.
   - `_resolve_ass_font_name` stripped newline, comma, and `Dialogue:` directive characters from untrusted `fontFamily` input, and `resolve_within_base` blocked `../etc/passwd` traversal with HTTP `400`.
6. **Clean Shutdown & Orphaned Temp Cleanup**:
   - Python `job_store.terminate_all_active()` killed a live subprocess (`sleep 30`), transitioned the job to `cancelled`, and cleared active job tracking.
   - `cleanupStaleExpressUploads` and `cleanup_stale_job_dirs` removed expired temporary files/folders while keeping active export files intact.
   - `GET /api/health/ready` returned `200` in dev mode and switched to `503` when `setVideoServerShuttingDown(true)` was set.
