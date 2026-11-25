# AI Studio MERN Backend Setup & Local Verification Guide

AI Studio is structured with a modular Node.js, Express, TypeScript, MongoDB, and Mongoose backend under `server/`.

When `MONGODB_URI` is not configured (such as in the AI Studio preview sandbox), the Express server remains operational in browser-session mode so the client timeline editor and Gemini AI editing assistant continue working without crashing. When `MONGODB_URI` and `JWT_SECRET` are provided, full MongoDB persistence and HTTP-only JWT cookie authentication become active.

## Architecture

- `server/config/env.ts` — Environment configuration loader (`MONGODB_URI`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `AUTH_COOKIE_NAME`, `GEMINI_API_KEY`).
- `server/config/database.ts` — Mongoose connection lifecycle (`connectDatabase`, `isDatabaseConnected`, `getDatabaseStatus`).
- `server/models/`
  - `User.ts` — Accounts, hashed passwords (`select: false`), workspace defaults.
  - `Project.ts` — Owner-scoped (`userId`) video projects with embedded `tracks` and `clips` (including `textStyle` overlays).
  - `MediaAsset.ts` — Owner-scoped (`userId`) media metadata records (`name`, `kind`, `mimeType`, `sizeBytes`, `duration`, `width`, `height`, `storageProvider`, `storageKey`).
  - `AiEditRequest.ts` — Audit trail of natural-language prompts, timeline snapshots, Zod-validated Gemini edit plans, and `proposed`/`applied`/`discarded` status.
  - `StoryboardDraft.ts` — Lightweight, owner-scoped (`userId`) AI Script & Storyboard drafts storing editable scene breakdowns, narration, captions, and settings JSON separately from timeline `Project` records.
  - `ExportJob.ts` — Owner-scoped export job specifications and render status tracking.
- `server/validators/` — Zod schemas validating request bodies for auth, projects/timelines, media metadata, AI edit requests, and export jobs.
- `server/middleware/`
  - `auth.middleware.ts` — Verifies JWT stored in secure `HttpOnly`, `SameSite=Lax` cookie (`requireAuth`, `optionalAuth`).
  - `validate.middleware.ts` — `validateBody(schema)` and `validateObjectId(paramName)`.
  - `database.middleware.ts` — `requireDatabase` returning `503` when MongoDB is not connected.
- `server/services/` & `server/controllers/` & `server/routes/` — Clean separation of business logic, HTTP controllers, and Express routers.

## API Endpoints

### Auth & User Profile
- `POST /api/auth/register` — Register account, hash password with `bcryptjs`, set HTTP-only JWT cookie.
- `POST /api/auth/login` — Authenticate credentials, set HTTP-only JWT cookie.
- `POST /api/auth/logout` — Clear auth cookie.
- `GET /api/auth/me` — Return authenticated user profile (`requireAuth`).
- `PATCH /api/auth/profile` — Update user display name, workspace name, default FPS, or default resolution (`requireAuth`).

### Projects & Timeline Persistence (Owner-Scoped)
- `GET /api/projects` — List projects belonging to authenticated user.
- `POST /api/projects` — Create new project.
- `GET /api/projects/:id` — Fetch single project owned by user.
- `PATCH /api/projects/:id` — Update project settings.
- `PUT /api/projects/:id/timeline` — Save full timeline (`aspectRatio`, `tracks`, `clips`).
- `DELETE /api/projects/:id` — Delete project owned by user.

### Media Metadata Management (Owner-Scoped)
- `GET /api/media` — List media asset metadata (optional `?projectId=` filter).
- `POST /api/media` — Save media file metadata.
- `GET /api/media/:id` — Fetch single media metadata document.
- `PATCH /api/media/:id` — Update media metadata.
- `DELETE /api/media/:id` — Delete media metadata document.

### AI Editing & Export Job Tracking
- `POST /api/ai/assistant` — Translate natural-language instructions into Zod-validated JSON timeline operations using the configured Gemini model (default: `gemini-3.5-flash`); persists `AiEditRequest` when authenticated with MongoDB.
- `POST /api/ai/storyboard` — Generate a Zod-validated `VideoStoryboard` from a prompt or script using the configured Gemini model (default: `gemini-3.5-flash`) with optional transient fallback (`GEMINI_FALLBACK_MODELS`), per-user concurrency guard, and cancellation support (`requireAuth`).
- `GET /api/ai/storyboards` & `POST /api/ai/storyboards` — List or save editable `StoryboardDraft` records for the authenticated user (`requireAuth`).
- `GET /api/ai/storyboards/:id`, `PATCH /api/ai/storyboards/:id`, `DELETE /api/ai/storyboards/:id` — Fetch, update, or delete an owner-scoped `StoryboardDraft` (`requireAuth`).
- `GET /api/ai/requests` — List user's saved AI editing requests (`requireAuth`).
- `PATCH /api/ai/requests/:id` — Mark an AI edit proposal `applied` or `discarded` (`requireAuth`).
- `GET /api/exports` — List user's export jobs (`requireAuth`).
- `POST /api/exports` — Record structured export job specification in MongoDB (when authenticated with MongoDB) and report render worker readiness.
- `GET /api/exports/:id` & `PATCH /api/exports/:id` — Fetch or update export job status (`requireAuth`).

## Running Locally with MongoDB

1. Start MongoDB locally (or provision a MongoDB Atlas cluster):
   ```bash
   mongod --dbpath ./data/db
   ```
2. Copy `.env.example` to `.env` and populate credentials:
   ```env
   GEMINI_API_KEY="your_gemini_api_key"
   GEMINI_MODEL="gemini-3.5-flash"
   GEMINI_FALLBACK_MODELS=""
   MONGODB_URI="mongodb://127.0.0.1:27017/ai_studio"
   JWT_SECRET="replace-with-a-long-random-secret-key"
   JWT_EXPIRES_IN="7d"
   AUTH_COOKIE_NAME="ai_studio_token"
   ```
3. Install dependencies and start the development server:
   ```bash
   npm install
   npm run dev
   ```
4. Verify locally with `curl`:
   ```bash
   # 1. Register user (stores HTTP-only JWT cookie in cookies.txt)
   curl -i -c cookies.txt -X POST http://localhost:3000/api/auth/register \
     -H "Content-Type: application/json" \
     -d '{"fullName":"Elena Vance","email":"elena@studio.local","password":"StrongPassword123"}'

   # 2. Fetch authenticated profile
   curl -b cookies.txt http://localhost:3000/api/auth/me

   # 3. Create an owner-scoped project
   curl -b cookies.txt -X POST http://localhost:3000/api/projects \
     -H "Content-Type: application/json" \
     -d '{"name":"Launch Cut","aspectRatio":"16:9","resolution":"1080p","fps":24}'
   ```

---

## Production Hardening & Deployment Readiness

- **Required Production Secrets (`NODE_ENV=production`)**:
  - `JWT_SECRET`: must be at least 32 characters (startup fails closed in production otherwise).
  - `APP_URL` / `CORS_ALLOWED_ORIGINS`: explicit origin allowlist (never wildcard `*`) for CORS and CSRF protection.
  - `VIDEO_PROCESSOR_API_KEY`: required (>= 16 characters) whenever `VIDEO_PROCESSOR_URL` is configured in production.
- **Transport & Proxy Settings**:
  - Serve Express over HTTPS behind a TLS-terminating reverse proxy (`trust proxy` enabled when `TRUST_PROXY=true`). HTTP-only auth cookies automatically gain `Secure` over HTTPS.
  - Configure reverse-proxy request timeouts >= `360s` (`EXPORT_TIMEOUT_MS`) and `client_max_body_size` matching `VIDEO_UPLOAD_MAX_MB`.
- **Rate Limits & Concurrency Guards**:
  - Auth routes (`/api/auth/*`), AI routes (`/api/ai/*`), and video processing/export routes (`/api/video/*`) enforce bounded per-client rate limits returning `429` with `Retry-After`.
  - MP4 exports enforce global (`MAX_CONCURRENT_EXPORTS`) and per-user (`MAX_USER_ACTIVE_EXPORTS`) concurrency slots plus magic-byte file verification on uploaded media.
- **Health Probes, Shutdown & Backups**:
  - Liveness probe: `GET /api/health/live` (returns `200`).
  - Readiness probe: `GET /api/health/ready` (returns `503` when shutting down or when `MONGODB_URI` is set but disconnected).
  - On `SIGINT`/`SIGTERM`, Express stops accepting new connections, signals active video jobs, cleans stale temp files, and closes Mongoose cleanly.
  - Schedule automated `mongodump` / MongoDB Atlas snapshots for `users`, `projects`, `mediaassets`, `videojobs`, `exportjobs`, `aieditrequests`, and `storyboarddrafts`.

