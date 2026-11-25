# Storyboard Automatic Media Integration (Phase 5.5.2)

Phase 5.5.2 connects **Phase 5.5.1** AI-generated storyboards with real, locally stored visual media—keeping costs at **₹0**, keeping raw media binaries out of MongoDB, and preserving clean separation before Phase 5.5.3 timeline/FFmpeg composition (`compositionReady` remains `false`).

---

## Workflow Overview

After generating or loading a storyboard in **AI Video Generator**:

1. **Auto-Match Media**: Deterministically scores your existing IndexedDB Media Library against each scene using filenames, user tags, descriptions, media type, aspect ratio compatibility, and duration fit. No extra Gemini API calls are spent.
2. **Upload Scene Media / Batch Upload**: Upload local MP4, MOV, WebM, PNG, JPEG, or WebP files directly into IndexedDB. Duplicate files (matching filename and byte size) are reused automatically instead of duplicating IndexedDB storage.
3. **Choose from Library**: Browse existing project/library visuals (filtering out audio-only assets), pick stock assets, or inspect already-generated text slides.
4. **Search Free Stock Media (Optional)**: When `STOCK_MEDIA_PROVIDER=pexels` and `PEXELS_API_KEY` are configured on the server, search Pexels photos and HD videos via authenticated server proxy routes and import selected assets straight into local IndexedDB with creator attribution preserved.
5. **Generate Text Slide**: Render clean PNG title cards, educational point cards, section headings, or closing cards locally in the browser using HTML5 Canvas with English, Hindi (Devanagari), and Bengali Unicode font support.

---

## Deterministic Auto-Matching Scoring (₹0 Cost)

`scoreAssetForScene()` in `src/utils/storyboardMedia.ts` computes a transparent `0–100` score from four signals:

- **Metadata & Filename Overlap (0–55 pts)**: Splits camelCase (`sunriseDesk.mp4` → `sunrise`, `desk`), filenames, tags, descriptions, and generated-slide headings across English and Hindi/Bengali Unicode words, comparing against scene `mediaKeywords`, `title`, `visualDescription`, `onScreenText`, and `narration`.
- **Media Type Alignment (0–20 pts)**: Prefers videos for `video` scenes, still images for `image` scenes, and generated slides for `text_card` scenes. Excludes audio-only assets (`score: 0`).
- **Aspect Ratio Fit (0–15 pts)**: Checks `asset.width / asset.height` against the storyboard target (`16:9`, `9:16`, `1:1`).
- **Duration Fit (0–10 pts)**: Checks whether a video clip meets or exceeds `scene.duration`.
- **Duplicate Avoidance**: Penalizes already-used assets (or skips them when `avoidDuplicates: true`) so distinct scenes receive distinct visuals whenever possible.

Every assignment records an honest `matchExplanation` describing the exact tokens and signals matched.

---

## Optional Free Stock Media Provider (`Pexels`)

By default, stock media integration is **off** (`STOCK_MEDIA_PROVIDER=none`) so zero external stock calls occur unless opted in.

To enable free stock search:
1. Create a free Pexels API key at `https://www.pexels.com/api/`.
2. Set in root `.env`:
   ```env
   STOCK_MEDIA_PROVIDER="pexels"
   PEXELS_API_KEY="your-pexels-api-key"
   STOCK_MEDIA_MAX_RESULTS="15"
   STOCK_MEDIA_MAX_IMPORT_MB="80"
   ```
3. Restart the Express server (`npm run dev`).

### Attribution & Rate Limits
- Free Pexels accounts allow **200 requests/hour** and **20,000 requests/month**.
- Imported stock assets automatically store `creatorName`, `attributionUrl`, and `licenseInfo` on both the `MediaAsset` record and `StoryboardSceneMediaAssignment`, rendered as verified `https:` attribution links in scene cards.

---

## Storage Architecture, Missing Media, & Security

- **Local IndexedDB Storage**: Original binaries live in browser IndexedDB (`MediaStorage`). MongoDB stores lightweight `MediaAsset` metadata and `StoryboardDraft` JSON. Temporary `blob:` URLs are stripped and rejected by Zod validation before saving drafts or metadata.
- **Orphaned Media Protection**: `cleanupUnusedMediaAssets()` and non-forced deletions inspect both timeline `projects` and locally saved `StoryboardDraft` assignments (`findStoryboardsUsingAsset`) before removing assets.
- **Missing Media Re-Linking**: Opening a server-synced draft on another browser or after clearing browser storage flags missing assets cleanly once IndexedDB hydration finishes, with a direct **Re-link File** button per scene.
- **Server-Side SSRF & Import Hardening (`server/services/stockMedia.service.ts`)**:
  - Authenticated (`requireAuth`), CSRF-protected, and rate-limited (`POST /api/stock-media/search`, `POST /api/stock-media/import`).
  - Strict HTTPS + Pexels/CDN hostname allowlist + DNS IP validation blocking loopback, private RFC1918, CGNAT, link-local/cloud metadata, and ULA IPv6 targets across up to 3 checked redirect hops.
  - Bounded streaming download capped at `STOCK_MEDIA_MAX_IMPORT_MB` (`413` on overshoot) plus binary magic-byte signature verification (`422` on spoofed HTML/text payloads).

---

## Hindi & Bengali Text Slide Rendering

- `src/utils/generatedSlides.ts` renders PNG cards at native storyboard resolutions (`1280×720` for `16:9`, `720×1280` for `9:16`, `1080×1080` for `1:1`).
- `index.html` loads `Noto Sans Devanagari` and `Noto Sans Bengali` with Windows `Nirmala UI` fallback. When font verification detects missing glyphs, `SlideGeneratorModal` shows a non-blocking preview warning.
- Note: Canvas PNG blob rendering executes in a real browser DOM (`document.createElement("canvas")` + `canvas.toBlob`); Node automated tests verify schemas, dimensions, font selection, and text wrapping without pretending headless Canvas execution.

---

## Phase 5.5.3 Handoff Readiness

Once every scene has a valid visual assignment and timing invariants pass (`computeStoryboardMediaSummary(...).isMediaReady === true`), the storyboard is marked **Media-Ready** and persists `mediaReadinessSummary` alongside `scene.mediaAssignment` (`sourceStartTime`, `aspectRatioHandling`, `mediaAssetId`, dimensions). `compositionReady` remains `false` until **Phase 5.5.3** introduces automatic timeline composition and MP4 rendering.
