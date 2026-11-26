# AI Studio — Step 7: External Deployment & Video Processing Guide

Step 7 provides a **Python FastAPI + FFmpeg/FFprobe** microservice (`video-processor/`) integrated with the **Express + MongoDB** backend and an optional **Redis + BullMQ** background queue (`server/queues/videoQueue.ts`).

---

## Runtime Capabilities inside Google AI Studio

- **Python 3 (`3.10.12`), `ffmpeg`, and `ffprobe` (`4.4.2`)** are present in the container, and the core FFprobe extraction & cleanup logic passes direct Python unit tests.
- **FastAPI / Uvicorn** (`pip`, `fastapi`, `uvicorn`) and **Redis** (`redis-server`) are **not** installed in the Google AI Studio sandbox. Therefore, Express cannot call FastAPI or BullMQ locally inside this runtime; both must be deployed externally and configured via Google AI Studio Secrets.

---

## Environment Variables (AI Studio Secrets)

| Variable | External Service Required? | Purpose |
| --- | --- | --- |
| `VIDEO_PROCESSOR_URL` | **Yes** (deployed FastAPI service URL, e.g. `https://...run.app`) | Base URL Express uses for `GET /health` and `POST /api/v1/metadata`. When unset, Express cleanly reports `integration_required` (`503`) without calling any localhost URL. |
| `VIDEO_PROCESSOR_API_KEY` | **No** (your own random secret) | Optional shared key sent by Express in `X-Processor-Key` and validated by FastAPI (`verify_processor_key`). Set the same value on both services. |
| `VIDEO_UPLOAD_MAX_MB` | **No** (numeric limit, default `500`) | Maximum upload size accepted by Express (`multer`). Note: Cloud Run standard HTTP/1.1 requests have a 32 MB request body limit unless using HTTP/2 or object storage signed URLs. |
| `REDIS_URL` | **Yes** (managed Redis URL, e.g. `rediss://...` from Upstash or Redis Cloud) | Optional. Only required for asynchronous BullMQ background jobs (`POST /api/video/metadata?async=true`). Synchronous metadata extraction works without Redis. |

---

## Deploying `video-processor/` Externally

### Option A: Google Cloud Run (Recommended)
Deploy directly from the `video-processor/` folder using the included `Dockerfile` (which installs Python 3.11, `ffmpeg`, `ffprobe`, `fastapi`, and `uvicorn` listening on `$PORT`):

```bash
gcloud run deploy ai-studio-video-processor \
  --source ./video-processor \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --memory 1Gi \
  --cpu 1 \
  --set-env-vars "VIDEO_PROCESSOR_API_KEY=<your-random-secret>"
```

1. Copy the deployed Cloud Run `https://...run.app` service URL.
2. Verify `GET https://<service-url>/health` returns `{"status":"ok","ffmpeg_available":true,"ffprobe_available":true}`.
3. In Google AI Studio **Settings → Secrets**, set:
   - `VIDEO_PROCESSOR_URL` = `https://<service-url>`
   - `VIDEO_PROCESSOR_API_KEY` = `<same-random-secret>`
   - `VIDEO_UPLOAD_MAX_MB` = `30` (recommended for Cloud Run HTTP/1.1 limit) or `500`
   - `REDIS_URL` = *(optional)* your Upstash / Redis Cloud `rediss://...` URL

### Option B: Railway / Render / Any Docker Host
Point the service root directory to `video-processor/` and deploy using `video-processor/Dockerfile`. It binds to `0.0.0.0:$PORT` automatically.

---

## Production Hardening & Deployment Checklist

- **Shared Authentication (`APP_ENV=production`)**: FastAPI fails startup if `VIDEO_PROCESSOR_API_KEY` is missing or shorter than 16 characters when `APP_ENV=production`. Set the exact same random secret on both Express and FastAPI; requests are compared using constant-time HMAC equality.
- **FFmpeg & Subtitle Safety**: FFmpeg and FFprobe invocations enforce `-protocol_whitelist file,pipe` to block unintended network/protocol access, and ASS subtitle font names are allowlisted to safe characters.
- **Concurrency & Temp Disk Caps**:
  - `MAX_CONCURRENT_EXPORTS` (default `2`) and `EXPORT_QUEUE_WAIT_SEC` (default `5`) prevent CPU/RAM exhaustion; excess concurrent export requests receive HTTP `429` with `Retry-After`.
  - `MAX_TEMP_STORAGE_MB` (default `2048`) and `TEMP_CLEANUP_MAX_AGE_SEC` (default `3600`) cap temporary job storage and purge stale temp directories while preserving active export jobs.
- **Reverse Proxy Configuration (Nginx / Caddy / Cloud LB)**:
  - Set request & proxy timeouts to at least `360s` (`proxy_read_timeout 360s; proxy_send_timeout 360s;`) so long 1080p MP4 renders do not terminate early.
  - Set `client_max_body_size 512m;` (or match `VIDEO_UPLOAD_MAX_MB`).
- **Health Checks & Graceful Shutdown**:
  - Point readiness probes to Express `GET /api/health/ready` and FastAPI `GET /health` (system paths are redacted).
  - On `SIGTERM` / `SIGINT`, FastAPI stops new work, terminates active FFmpeg child processes, and cleans temp job directories.

---

## Offline Local TTS Subsystem (Phase 5.5.3)

- **Endpoints (`video-processor/app/routes/tts.py`)**:
  - `GET /api/v1/tts/status`, `GET /api/v1/tts/voices`, `POST /api/v1/tts/generate`, `GET /api/v1/tts/jobs/{job_id}`, `POST /api/v1/tts/jobs/{job_id}/cancel` (protected by `verify_processor_key`).
- **Engines**: Piper ONNX (`piper`), eSpeak NG (`espeak-ng`), and optional isolated Windows SAPI5 (`pyttsx3`). All child processes launch with `shell=False` and UTF-8 stdin piping (`en`, `hi`, `bn`).
- **Audio Normalization**: Output is standardized via FFmpeg (`-protocol_whitelist file,pipe`) to mono PCM 16-bit WAV (`22050 Hz` default) or optional MP3 (`libmp3lame`), and real durations are verified via FFprobe before streaming `FileResponse` with automatic temp directory cleanup.


