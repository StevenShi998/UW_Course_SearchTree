# Backend (Archived)

⚠️ **This backend is NO LONGER USED in production**

## Migration to Static

As of the latest deployment, this website uses **fully static data** loaded from `data/courses_data.json`.

The FastAPI backend has been **replaced with static JSON** for better performance:
- ✅ Zero cold starts
- ✅ 10-100x faster load times  
- ✅ Global CDN distribution
- ✅ No backend hosting costs

## What's Here

This directory contains the **archived FastAPI backend** that was previously used to serve course data from the Neon Postgres database.

Files:
- `server.py` - FastAPI server with database connection and API endpoints
- `__pycache__/` - Python bytecode cache

## If You Need to Use It

The backend can still be run locally for development/testing:

```bash
# Activate venv
source venv/bin/activate

# Start the backend
uvicorn backend.server:app --host 127.0.0.1 --port 8000 --reload
```

Then add `?api=:8000` to your local frontend URL to use the backend instead of static data.

## Current Architecture

```
User Request
    ↓
Static HTML/JS/CSS (Netlify CDN)
    ↓
data/courses_data.json (pre-loaded, instant)
    ↓
Renders trees locally in browser
```

## Previous Architecture (Archived)

```
User Request
    ↓
Frontend (Netlify)
    ↓
FastAPI Backend (Render.com)
    ↓
Neon Postgres Database
    ↓
Response (with latency & cold starts)
```

---

**For data updates**, use: `./scripts/update_data.sh`

