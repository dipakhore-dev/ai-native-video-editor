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

# Optional Gemini key for the AI Timeline Assistant
GEMINI_API_KEY="your-gemini-api-key"

# Local Python FastAPI FFmpeg/FFprobe/faster-whisper service
VIDEO_PROCESSOR_URL="http://127.0.0.1:8001"
VIDEO_PROCESSOR_API_KEY="local-dev-processor-key"
VIDEO_UPLOAD_MAX_MB="500"

# Leave empty — Redis is not required for synchronous local processing
REDIS_URL=""

# Leave empty — Paid Text-to-Video stays disabled
VIDEO_GEN_PROVIDER_URL=""
```

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

## Bengali (বাংলা) Subtitles & Windows Font Setup

- **Multilingual Model**: Bengali (`bn`) requires a multilingual `faster-whisper` model (`small`, `medium`, or `base`—never `*.en`). The default `WHISPER_MODEL_SIZE="small"` runs on CPU (`int8`) at ₹0 cost.
- **Built-in Windows Font (`Nirmala UI`)**: Windows 10 and Windows 11 include **Nirmala UI** (`C:\Windows\Fonts\Nirmala.ttf`), which supports Bengali Unicode (`বাংলা`) glyphs. When Bengali text is present during MP4 subtitle burn-in, the Python processor automatically selects `Nirmala UI` (or `Noto Sans Bengali` if installed) instead of `Arial`.
- **Optional `Noto Sans Bengali` Font on Windows**: If you prefer Google's **Noto Sans Bengali** for both MP4 burn-in and local preview fallback, download the free TTF from Google Fonts (`Noto Sans Bengali`), right-click `NotoSansBengali-Regular.ttf` -> **Install for all users** (or copy it to `C:\Windows\Fonts`), or override via `SUBTITLE_BENGALI_FONT` in `video-processor\.env`.
