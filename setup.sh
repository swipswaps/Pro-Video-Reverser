#!/bin/bash
set -e

# PATH: setup.sh
# Pro Video Reverser — idempotent startup script.

APP_PORT=3000

# Environment checks
command -v python3 >/dev/null 2>&1 || { echo "Error: python3 required but not found in PATH."; exit 1; }
command -v npm    >/dev/null 2>&1 || { echo "Error: npm required but not found in PATH."; exit 1; }

echo "[SETUP] Initiating cold-start recovery..."

# ─── Step 0: Release ports ────────────────────────────────────────────────────
release_port() {
    local port="$1"
    # Use lsof or fuser if available
    if command -v fuser >/dev/null 2>&1; then
        if fuser "${port}/tcp" >/dev/null 2>&1; then
            echo "[SETUP] Port ${port} occupied — terminating occupant..."
            fuser -k "${port}/tcp" || true
            sleep 1
        fi
    elif command -v lsof >/dev/null 2>&1; then
        local pid=$(lsof -t -i:"${port}")
        if [ -n "$pid" ]; then
            echo "[SETUP] Port ${port} occupied by PID ${pid} — terminating..."
            kill -9 "$pid" || true
            sleep 1
        fi
    fi
}

release_port "${APP_PORT}"

# ─── Step 1: Update from GitHub (Simulated/Placeholder) ──────────────────────
# Since we are in a managed environment, we can't always git pull, 
# but we can check if .git exists.
if [ -d ".git" ]; then
    echo "[SETUP] Checking for updates from GitHub..."
    git pull origin main || echo "[WARNING] Git pull failed, proceeding with current version."
fi

# ─── Step 2: Install Node.js dependencies ─────────────────────────────────────
echo "[SETUP] Verifying Node.js dependencies..."
npm install --no-audit --no-fund

# ─── Step 3: Verify system forensic tools ────────────────────────────────────
if [ -f "forensic_latency_probe_v13.py" ]; then
    echo "[SETUP] Verifying system forensic tools..."
    python3 forensic_latency_probe_v13.py --module DEPS || echo "[WARNING] Forensic tools verification failed."
fi

# ─── Step 4: Start server ─────────────────────────────────────────────────────
echo "[SETUP] Initialization complete. Starting server..."
echo "[INFO] MISSION CONTROL TUI available via: npm run tui"
exec npx tsx server.ts
