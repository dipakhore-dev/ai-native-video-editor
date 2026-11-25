# AI Studio — ₹0 Free Local Windows PowerShell Setup Guide

This guide runs the entire **AI Studio** stack locally on **Windows 10 / 11** at **₹0 cost**—no credit card, no Google Cloud Run billing account, and **no Redis required** for basic synchronous video processing.

---

## Services That Run Locally

1. **MongoDB** (Free local MongoDB Community Server, or MongoDB Atlas M0 free tier—no card required) — stores users, projects, timelines, media metadata, and processing job records.
2. **Express + Vite App (`npm run dev`, Port `3000`)** — serves the React frontend, JWT cookie authentication, project/media APIs, Gemini editorial assistant, and forwards video uploads synchronously to the Python FastAPI service.
3. **Python FastAPI Video Processor (`uvicorn`, Port `8001`)** — runs **FFmpeg**, **FFprobe**, and **faster-whisper** locally on CPU for:
   - Video metadata extraction (`POST /api/v1/metadata`)
   - Thumbnail generation (`POST /api/v1/thumbnail`)
   - Video trimming (`POST /api/v1/trim`)
   - Resize, crop & 16:9 / 9:16 / 1:1 conversion (`POST /api/v1/aspect-ratio`)
   - Clip merging (`POST /api/v1/merge`)
   - MP4 export (`POST /api/v1/export-mp4`)
   - Local speech-to-subtitles via `faster-whisper` (`POST /api/v1/subtitles`)

*(Redis + BullMQ is strictly optional and **not required** for any of the synchronous short-video features above.)*

---

## Step 1: Install Free Tools on Windows (PowerShell)

Open **Windows PowerShell** and install Node.js LTS, Python 3.11, and FFmpeg (includes `ffmpeg` and `ffprobe`):

```powershell
winget install OpenJS.NodeJS.LTS
winget install Python.Python.3.11
winget install Gyan.FFmpeg
```

Restart PowerShell so `PATH` refreshes, then confirm every tool is available:

```powershell
node -v
python --version
ffmpeg -version
ffprobe -version
```

If using local MongoDB instead of MongoDB Atlas M0 free tier:
```powershell
winget install MongoDB.Server
```

---

## Step 2: Configure Root `.env` (Express + MongoDB)

In the project root (`ai-studio/`), create `.env` from `.env.example` in PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env` with your local values:

```env
PORT="3000"
NODE_ENV="development"
APP_URL="http://localhost:3000"

# Free local MongoDB or MongoDB Atlas M0 free tier
MONGODB_URI="mongodb://127.0.0.1:27017/ai_studio"

# Generate any random 32+ character string
JWT_SECRET="replace-with-your-own-random-32-char-secret"
JWT_EXPIRES_IN="7d"
AUTH_COOKIE_NAME="ai_studio_auth"

# Gemini key and configurable model for AI Assistant & Storyboard Generator
GEMINI_API_KEY="your-gemini-api-key"
GEMINI_MODEL="gemini-3.5-flash"
GEMINI_FALLBACK_MODELS=""

# Local Python FastAPI FFmpeg/FFprobe/faster-whisper service
VIDEO_PROCESSOR_URL="http://127.0.0.1:8001"
VIDEO_PROCESSOR_API_KEY="local-dev-processor-key"
VIDEO_UPLOAD_MAX_MB="500"

# Optional Free Stock Media Search (default: disabled / local uploads + slides)
STOCK_MEDIA_PROVIDER="none"
PEXELS_API_KEY=""
STOCK_MEDIA_MAX_RESULTS="15"
STOCK_MEDIA_MAX_IMPORT_MB="80"

# Leave empty — Redis is not required for synchronous local processing
REDIS_URL=""

# Leave empty — Paid Text-to-Video stays disabled
VIDEO_GEN_PROVIDER_URL=""
```

*(Note: Keep real API keys in `.env` only—`.env.example` contains safe placeholders and is tracked cleanly in Git while `.env` remains gitignored.)*

---

## Step 3: Start Terminal 1 — Express & React Frontend

In PowerShell at the project root:

```powershell
npm install
npm run dev
```

Express + Vite will start on `http://localhost:3000`.

---

## Step 4: Start Terminal 2 — Python FastAPI + FFmpeg + faster-whisper

Open a **second PowerShell window** inside `video-processor`:

```powershell
cd video-processor
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install --upgrade pip
pip install -r requirements.txt
Copy-Item .env.example .env
```

*(If PowerShell blocks `Activate.ps1`, run once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.)*

Make sure `video-processor\.env` has the matching shared key and `127.0.0.1:8001`:

```env
VIDEO_PROCESSOR_HOST="127.0.0.1"
PORT="8001"
VIDEO_PROCESSOR_API_KEY="local-dev-processor-key"
FFMPEG_BIN="ffmpeg"
FFPROBE_BIN="ffprobe"
WHISPER_MODEL_SIZE="small"
WHISPER_DEVICE="cpu"
WHISPER_COMPUTE_TYPE="int8"
```

Start the FastAPI service:

```powershell
uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload
```

---

## Step 5: Verify Locally in PowerShell (Terminal 3)

Check Python FastAPI health (`ffmpeg`, `ffprobe`, and `faster-whisper`):

```powershell
Invoke-RestMethod http://127.0.0.1:8001/health
```

Check Express integration status:

```powershell
Invoke-RestMethod http://localhost:3000/api/integrations/status | ConvertTo-Json -Depth 4
```

Run Python FFmpeg/FFprobe unit tests from project root:

```powershell
$env:PYTHONPATH = "video-processor"
python -m unittest discover -s video-processor/tests -t video-processor -v
```

*(First time you call `/api/video/subtitles`, `faster-whisper` downloads the open-source multilingual Whisper `small` model weights once to your local Hugging Face cache and runs completely offline/free afterward. English-only models such as `base.en` or `small.en` are not used for Bengali or auto-detect.)*

---

## Hindi, Bengali (বাংলা) Slides & Windows Font Setup

- **Multilingual Model**: Bengali (`bn`) and Hindi (`hi`) subtitles require a multilingual `faster-whisper` model (`small`, `medium`, or `base`—never `*.en`). The default `WHISPER_MODEL_SIZE="small"` runs on CPU (`int8`) at ₹0 cost.
- **Built-in Windows Font (`Nirmala UI`)**: Windows 10 and Windows 11 include **Nirmala UI** (`C:\Windows\Fonts\Nirmala.ttf`), which supports both **Devanagari (Hindi)** and **Bengali (`বাংলা`)** Unicode glyphs. Browser Canvas text slides (`src/utils/generatedSlides.ts`) and MP4 subtitle burn-in automatically include `Nirmala UI` as fallback alongside `Noto Sans Devanagari` / `Noto Sans Bengali`.
- **Optional `Noto Sans` Fonts on Windows**: For identical typography in offline browser slides and MP4 burn-in without internet access, download free Google Fonts TTFs (**Noto Sans Devanagari** / **Noto Sans Bengali**), right-click -> **Install for all users** (or copy into `C:\Windows\Fonts`), or override via `SUBTITLE_BENGALI_FONT` in `video-processor\.env`.

---

## Optional Free Pexels Stock Media Setup (₹0)

- Stock media search stays disabled by default (`STOCK_MEDIA_PROVIDER="none"`). You can always match existing library assets, upload local files, or generate local PNG text slides without any external stock account.
- If you want to search & import Pexels photos and videos directly into browser IndexedDB:
  1. Register a free API key at `https://www.pexels.com/api/` (200 requests/hour, 20,000/month, no credit card).
  2. Set `STOCK_MEDIA_PROVIDER="pexels"` and `PEXELS_API_KEY="your-key"` in root `.env`, then restart `npm run dev`.
  3. See `docs/STORYBOARD_MEDIA_INTEGRATION.md` for creator attribution and SSRF/import guard details.

---

## Deploying to Production (Linux / Docker / Reverse Proxy)

When promoting from local Windows development to production (`NODE_ENV=production` / `APP_ENV=production`):

1. **Secrets & Origins**: Set a 32+ character `JWT_SECRET`, a 16+ character `VIDEO_PROCESSOR_API_KEY` shared identically between `.env` and `video-processor/.env`, and explicit `APP_URL` / `CORS_ALLOWED_ORIGINS`.
2. **HTTPS & Timeouts**: Terminate TLS at Nginx/Caddy/Load Balancer, enable `TRUST_PROXY=true`, set `proxy_read_timeout 360s`, and set `client_max_body_size 512m`.
3. **Health Checks**: Use `GET /api/health/live` for liveness and `GET /api/health/ready` for readiness (fails `503` during graceful shutdown or MongoDB disconnect).
4. **Backups**: Enable MongoDB Atlas automated backups (or scheduled `mongodump`) — local browser IndexedDB media remains on each user's device, while MongoDB stores accounts, project timelines, and export job records.

