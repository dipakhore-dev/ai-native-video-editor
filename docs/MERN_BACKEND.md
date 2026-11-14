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
- `POST /api/ai/assistant` — Translate natural-language instructions into Zod-validated JSON timeline operations using Gemini (`gemini-4-hydrogen`); persists `AiEditRequest` when authenticated with MongoDB.
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
