# ScamGuard

ScamGuard is a full-stack reporting platform for collecting scam reports, uploading evidence, and generating AI-assisted risk analysis.

## Features

- Public report submission workflow with evidence upload.
- AI analysis pipeline with queue worker and inline fallback mode.
- Search and review interface for submitted reports.
- Admin dashboard for users, reports, AI reruns, diagnostics, and security posture checks.

## Tech Stack

- Backend: Node.js, Express, Bull, Supabase
- Frontend: Static HTML/CSS/JS
- AI: Ollama (local) or Gemini (cloud)
- Infra: Render web + worker services

## Prerequisites

- Node.js 22+
- Redis (for queue mode)
- Supabase project with required tables/storage buckets

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy environment template and configure secrets:

```bash
cp .env.example .env
```

3. Start backend:

```bash
npm start
```

4. Start worker (optional but recommended for queue mode):

```bash
npm run worker
```

## Environment Variables

See .env.example for the full list. Core values:

- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- SUPABASE_ANON_KEY
- REDIS_HOST
- REDIS_PORT
- LLM_PROVIDER
- OLLAMA_URL / OLLAMA_MODEL
- CORS_ALLOWED_ORIGINS

## Tests

Run baseline server helper tests:

```bash
npm test
```

Current tests validate helper logic (UUID format checks, bearer token extraction, origin parsing). Expand coverage with integration tests for critical routes.
