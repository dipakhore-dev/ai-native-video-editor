# AI Studio — Phase 5.5.4: Automatic Caption Generation & Storyboard Caption Editor

Phase 5.5.4 adds **₹0 cost, offline-capable scene caption generation, interactive cue editing, style presets, synchronized preview, and `.srt` / `.vtt` subtitle export** for every `VideoStoryboard` scene.

> **Honest Scope Boundary:** Phase 5.5.4 prepares, aligns, previews, persists, and exports captions (`compositionReady: false` remains enforced). Standard `.srt` and `.vtt` files export timestamps and plain text only; live styled overlays preview inside `CaptionPreview` today, while final MP4 burn-in and full multi-track timeline assembly are reserved for **Phase 5.5.5**.

---

## 1. Dual Caption Generation Modes

### A. Script Timing Mode (`defaultMode: "script"` — Instant, 100% Local, ₹0)
- Implemented cleanly in pure TypeScript (`src/utils/storyboardCaptions.ts`) with zero network calls or Python dependencies.
- **Unicode & Indic Safety**:
  - Normalizes all text to Unicode **NFC** before segmentation and fingerprinting.
  - Uses `Intl.Segmenter` (`en-US`, `hi-IN`, `bn-IN`) with combining-mark-aware regex fallback (`\P{M}\p{M}*`) so Hindi Devanagari matras (e.g., `अंतिम`) and Bengali conjuncts/vowel signs (e.g., `ভবিষ্যতের`) are never split mid-grapheme.
  - Splits at sentence endings including Indic *purna viram* (`।`, `॥`), punctuation pauses, and clause boundaries tuned per aspect ratio (`16:9` ~42 chars/line, `1:1` ~34 chars/line, `9:16` ~26 chars/line).
- **Duration Budget Allocation**:
  - If a scene has a ready Phase 5.5.3 voiceover in IndexedDB, cues distribute proportionally across the measured FFprobe **voiceover audio duration** (plus punctuation pause & word/grapheme weights).
  - Otherwise, cues distribute cleanly across `scene.duration`.
  - If voiceover audio is longer than `scene.duration + 0.15s`, `overflowsSceneDuration` flags an explicit warning without silently truncating words or rewriting `scene.duration`.
  - Scenes with empty/whitespace narration produce `status: "skipped_empty"`.

### B. Local Audio Transcription Mode (`mode: "audio"` — `faster-whisper` on CPU, ₹0)
- Sends the scene's local voiceover audio file from browser IndexedDB (`Audio`) to Express `POST /api/captions/from-audio` -> Python FastAPI `POST /api/v1/captions/generate`.
- **Audio-Only Security Guard**: Both Express (`verifyUploadedFileMagic` checking `detectedKind === "audio"`) and FastAPI (`validate_uploaded_file_magic(..., allow_audio=True, allow_images=False)`) reject non-audio uploads such as `.mp4` or spoofed binaries.
- **Audio Normalization**: If input is already 16 kHz mono PCM WAV (`pcm_s16le`), `whisper_service.py` reuses it directly; otherwise FFmpeg (`-protocol_whitelist file,pipe`) transcodes to 16 kHz mono WAV.
- **Multilingual Model Enforcement**: English-only `*.en` models (such as `small.en` or `base.en`) are automatically mapped to multilingual models (`small`, `base`, `tiny`) so **English (`en`)**, **Hindi (`hi`)**, **Bengali (`bn`)**, and `auto` work cleanly with one cached CPU model (`int8`).
- **Word Timestamps**: Optional toggle (`wordTimestamps: true`) attaches word-level timestamps (`words[]`) when supported by the transcribed segment.
- **Bounded Concurrency & Cancellation**:
  - Single-slot semaphore (`CAPTIONS_MAX_CONCURRENT_JOBS=1`) returns HTTP `429` when busy and prevents CPU/RAM exhaustion on 8 GB RAM laptops.
  - Cooperative cancellation (`POST /api/captions/jobs/:id/cancel`) aborts the Express proxy stream, triggers `cancel_event` in FastAPI between Whisper segments, returns HTTP `499`, and cleans temp files immediately.

---

## 2. Offline Whisper Cache Policy (`WHISPER_LOCAL_FILES_ONLY=true`)

By default, `video-processor/.env.example` sets:

```env
WHISPER_MODEL_SIZE="small"
WHISPER_DEVICE="cpu"
WHISPER_COMPUTE_TYPE="int8"
WHISPER_LOCAL_FILES_ONLY="true"
```

When `WHISPER_LOCAL_FILES_ONLY="true"`:
- `/api/v1/captions/status` inspects your local Hugging Face cache and reports whether the multilingual model is already cached.
- **If not cached yet**, Audio Transcription fails fast and cleanly with a clear message instead of hanging a request on an unexpected multi-hundred-MB download—while **Script Timing Mode stays 100% ready**.
- To pre-cache once on Windows PowerShell inside `video-processor\.venv`:

```powershell
cd video-processor
.\.venv\Scripts\Activate.ps1
python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"
```

*(For even lower RAM/CPU usage on Intel Core i3-1115G4 / 8 GB RAM, you may set `WHISPER_MODEL_SIZE="base"` or `"tiny"`—remember `tiny` is faster but less accurate on Hindi and Bengali than `small`.)*

---

## 3. Stale Detection, Style Presets, Preview & Export

### Deterministic Stale Detection (`computeCaptionFingerprint`)
- **Marks captions `stale` when**:
  - Scene `narration` text changes (trimmed/CRLF/NFC normalized)
  - Caption `mode` changes (`script` vs `audio`)
  - Effective caption `language` changes
  - Linked voiceover audio (`mediaAssetId` / `narrationFingerprint`) changes
  - Unvoiced `scene.duration` changes (when no voiceover audio exists)
- **Does NOT invalidate captions when**:
  - Visual media, scene title, order, `startTime`, transitions, effects, camera motion, or caption style presets change.

### 6 Caption Style Presets & Proportional Preview
1. **Classic** (`classic`)
2. **Cinematic** (`cinematic`)
3. **Educational** (`educational`)
4. **Social Media** (`social_media`)
5. **Minimal** (`minimal`)
6. **Yellow Highlight** (`yellow_highlight`)

`CaptionPreview` measures its stage container height via `ResizeObserver` and applies `computeScaledCaptionPreviewStyle(...)` proportionally across `16:9`, `9:16`, and `1:1` frames. Preview renders strictly via safe React text nodes (never `dangerouslySetInnerHTML`), coordinates single-active audio playback across both voiceover and caption previews (`cap:${scene.id}`), and falls back to an explicit `"Silent Timer"` via `requestAnimationFrame` when no voiceover audio is attached.

### SRT & WebVTT Timeline Exports
- **Per-scene `.srt` / `.vtt`**: Scene-relative timestamps starting from `0.0s`.
- **Full-storyboard `.srt` / `.vtt`**: Accumulates `scene.duration` sequentially so empty/silent scenes preserve accurate timeline gaps (`collectTimelineCaptionCues`). All cue payloads pass `sanitizeCaptionCueText` (replaces `-->`, strips control chars, neutralizes embedded `WEBVTT` headers).

---

## 4. Security & Persistence Boundaries

- **Zero `blob:` URL persistence**: `StoryboardSceneCaptionsSchema` rejects `blob:` IDs, and `sanitizeStoryboardForPersistence` strips any transient `queued`/`generating` statuses or `blob:` errors before saving to MongoDB (`StoryboardDraft`) or `localStorage`.
- **No Raw Script Logging**: Express and FastAPI log only request IDs, statuses, timing metrics, and sanitized error text with local OS paths (`C:\...`, `/tmp/...`) and service endpoints redacted.
