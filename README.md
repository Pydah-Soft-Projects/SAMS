# SAMS — Smart Access Management System

Dynamic role-based registration with face verification and gate entry/exit tracking.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Frontend  │────▶│   Backend   │────▶│  MongoDB    │
│  (Next.js)  │     │  (Express)  │     │  (local)    │
└─────────────┘     └──────┬──────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  AI Server  │
                    │  (FastAPI)  │
                    └─────────────┘
```

## Features

- **Dynamic Roles** — Create roles with unique configurations
- **Dynamic Registration Forms** — Build custom forms per role (text, number, select, date, etc.)
- **3-Stage Registration** — Form filling → Photo capture → Review & verification
- **Face Embeddings** — AI server extracts and stores face embeddings during registration
- **Gate Entry/Exit** — Capture photo at gate, compare with stored embeddings, log entry/exit

## Tech Stack

| Layer     | Technology              |
|-----------|-------------------------|
| Frontend  | Next.js (App Router)    |
| Backend   | Node.js + Express       |
| AI Server | Python + FastAPI        |
| Database  | MongoDB (local)         |

## Project Structure

```
SMAS/
├── backend/          # Express API, MongoDB models, business logic
├── frontend/         # Next.js App Router
├── ai-server/        # Face embedding extraction & comparison
├── docker-compose.yml
└── package.json      # Root scripts to run all services
```

## Quick Start

### Prerequisites

- Node.js 18+
- Python 3.10+
- Docker (for MongoDB)

### 1. Install dependencies

```bash
npm run install:all
pip install -r ai-server/requirements.txt
```

### 2. Start MongoDB

```bash
npm run db:up
```

### 3. Configure environment

```bash
cp backend/.env.example backend/.env
cp ai-server/.env.example ai-server/.env
```

Set `MONGO_EMPLOYEE_URI` in `backend/.env` (and in the backend deployment environment) to enable HRMS employee search and live HRMS password verification for linked system users. Linked users sign in with their HRMS employee number and password; password changes must be made in HRMS. Keep this credential private; it is not needed for manual account creation.

### 4. Run all services

```bash
npm run dev
```

| Service   | URL                    |
|-----------|------------------------|
| Frontend  | http://localhost:3000  |
| Backend   | http://localhost:3001  |
| AI Server | http://localhost:8000  |
| MongoDB   | mongodb://localhost:27017/smas |

## Production Deployment (split platform)

See **[deploy/DEPLOY.md](deploy/DEPLOY.md)** for step-by-step instructions:

- **Vercel** — frontend
- **Render** — backend (`render.yaml`)
- **Fly.io** — AI server (`ai-server/fly.toml` + `Dockerfile`)
- **MongoDB Atlas** — database


### Roles & Forms
- `GET/POST /api/roles` — Manage dynamic roles
- `GET/POST /api/forms/:roleId` — Manage registration forms per role

### Registration (3 stages)
- `POST /api/registrations` — Start registration (stage 1: form data)
- `POST /api/registrations/:id/photo` — Upload photo, get embedding (stage 2)
- `POST /api/registrations/:id/verify` — Review & complete (stage 3)

### Gate
- `POST /api/gate/scan` — Capture photo, match face, log entry/exit
- `GET /api/gate/logs` — View entry/exit history

### AI Server
- `POST /embed` — Extract face embedding from image
- `POST /compare` — Compare two embeddings, return similarity score
