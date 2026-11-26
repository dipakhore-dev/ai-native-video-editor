# AI Studio — Phase 5.5.3: Free Local Text-to-Speech & Storyboard Voiceover Generation

Phase 5.5.3 adds **free (`₹0`), offline-capable speech synthesis** for each scene in a `VideoStoryboard` using local engines running inside the Python FastAPI microservice (`video-processor/`), with synthesized audio normalized by **FFmpeg/FFprobe** and persisted directly inside browser **IndexedDB** (`sourceOrigin: "generated_voiceover"`).

> **Honest Scope Boundary:** Phase 5.5.3 synthesizes, measures, previews, and persists scene voiceovers inside `StoryboardDraft` (`compositionReady: false` remains enforced). Automatic caption timing from synthesized voiceovers and automated multi-track FFmpeg storyboard MP4 composition are reserved for Phase 5.5.4+.

---

## 1. Local Speech Synthesis Architecture

1. **Python FastAPI Microservice (`video-processor/`)**:
   - **Priority Order (`TTS_PROVIDER=auto`)**:
     1. **Piper TTS** (`piper-tts` / `piper.exe` + local `.onnx` & `.onnx.json` voices inside `PIPER_MODELS_DIR` — highest natural neural voice quality on CPU, lightweight `~60–100 MB` RAM per voice).
     2. **eSpeak NG** (`espeak-ng` CLI — broad offline support across **English (`en`)**, **Hindi (`hi`)**, and **Bengali (`bn`)**, tiny RAM footprint).
     3. **Windows SAPI5 Fallback (`TTS_WINDOWS_SAPI_ENABLED=true`, Windows default when `pyttsx3` is installed)** — isolated subprocess using `pyttsx3`.
   - **FFmpeg & FFprobe Normalization (`app/services/tts_service.py`)**:
     - Raw engine output is normalized via FFmpeg (`-protocol_whitelist file,pipe`) to deterministic **WAV (`pcm_s16le`, mono, `22050 Hz`)** by default, or **MP3 (`128k`)** when requested and `libmp3lame` is compiled in.
     - Exact audio duration, sample rate, and channel count are measured directly from the synthesized file using **FFprobe** (`extract_audio_metadata`), never estimated from character counts.
   - **Process & Temp Isolation**:
     - Every engine spawns with `shell=False` via `subprocess.Popen`, UTF-8 stdin piping (preserving Devanagari `hi` and Bengali `bn` scripts cleanly without codepage corruption), active process tracking (`GET /api/v1/tts/jobs/{job_id}` & `POST /api/v1/tts/jobs/{job_id}/cancel`), strict request timeout, and immediate temp directory cleanup.

2. **Express Backend Proxy (`server/`)**:
   - Auth-protected, CSRF-checked, rate-limited (`RATE_LIMIT_TTS_MAX`), Zod-validated routes:
     - `GET /api/tts/status`
     - `GET /api/tts/voices`
     - `POST /api/tts/generate`
     - `GET /api/tts/jobs/:id`
     - `POST /api/tts/jobs/:id/cancel`
   - `GET /api/integrations/status` includes the `tts` entry alongside `aiAssistant`, `videoProcessor`, `stockMedia`, etc.
   - CORS exposes `X-TTS-Job-Id`, `X-TTS-Provider`, `X-TTS-Voice-Id`, `X-TTS-Voice-Label`, `X-TTS-Language`, `X-TTS-Duration`, `X-TTS-Sample-Rate`, `X-TTS-Channels`, and `X-TTS-Format`.

3. **Frontend & IndexedDB Persistence (`src/`)**:
   - Synthesized audio `File`s persist locally in IndexedDB via `MediaStorage` with `sourceOrigin: "generated_voiceover"`, protecting them during media library cleanup whenever referenced by `scene.voiceover.mediaAssetId` in any saved storyboard draft.
   - `generated_voiceover` assets are excluded from visual scene auto-matching (`scoreAssetForScene` & `autoMatchStoryboardScenes`).
   - `StoryboardDraft` persistence (`MongoDB` + `localStorage`) saves lightweight metadata (`mediaAssetId`, `voiceId`, `durationSeconds`, `narrationFingerprint`, `status`) while stripping temporary `blob:` URLs.
   - **Deterministic Stale Detection (`computeNarrationFingerprint`)**: Editing a scene's `narration`, `language`, `provider`, `voiceId`, `speakingRate`, or `pitch` marks the slot `stale`. Changing visual media, transitions, titles, order, or `volume` does **not** invalidate synthesized audio.
   - **Duration Overflow Handling**: If FFprobe duration exceeds `scene.duration + 0.15s`, the UI surfaces a clear warning with three explicit actions (**Edit Narration**, **Speed Up & Regenerate** up to `1.5x`, or **Extend Scene Duration** with inline confirmation) and never silently alters `scene.duration`.

---

## 2. Hindi (`hi`) & Bengali (`bn`) Language Policy

- Voices are filtered strictly by language code (`en`, `hi`, `bn`).
- If no voice is installed for `hi` or `bn` on a given machine/provider, the API and UI report the missing language voice transparently — **English voices are never silently substituted for Hindi or Bengali text**.
- All narration inputs remain UTF-8 (`--stdin` on eSpeak NG and UTF-8 stdin on Piper) to preserve Devanagari and Bengali Unicode characters cleanly on Windows PowerShell.

---

## 3. CPU & Memory Guidance (Intel Core i3-1115G4 / 8 GB RAM)

- Single-scene synthesis uses minimal memory (`<15 MB` for eSpeak NG + FFmpeg; `~80–120 MB` peak for a Piper ONNX voice).
- **Sequential Batch Queue (`concurrency = 1`, max `12` scenes)** prevents CPU saturation or out-of-memory thrashing during "Generate Missing / Stale" or "Regenerate All".
- Default `TTS_MAX_CONCURRENT_JOBS=1` caps backend synthesis concurrency with explicit `429` backpressure when busy.

---

## 4. Open-Source Engine Licensing Notes

- **eSpeak NG**: Licensed under **GPL-3.0-or-later**. Invoked as an isolated external CLI binary over standard pipes (`subprocess.Popen(..., shell=False)`), preserving clear binary separation.
- **Piper TTS**: Piper runtime is **MIT-licensed**; individual ONNX voice models carry their respective open model licenses (typically MIT / CC0 / CC-BY depending on speaker dataset — verify each downloaded `.onnx.json` model card before commercial redistribution).
- **pyttsx3 (optional Windows SAPI5)**: Licensed under **MPL-2.0**; connects to native OS Windows Speech APIs when explicitly enabled via `TTS_WINDOWS_SAPI_ENABLED=true`.
