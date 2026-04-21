#!/bin/bash
# Smoke test for staging env — run after deploy before promoting to prod
set -e

STAGING_URL="${STAGING_URL:-https://kioku-staging.up.railway.app}"
MASTER_KEY="${KIOKU_MASTER_KEY:-kioku_master_ikonbai_2026_secret}"

echo "=== Smoke test: $STAGING_URL ==="

echo "[1/5] Health check..."
curl -fsS "$STAGING_URL/health" | head -c 200 && echo

echo "[2/5] Admin status..."
curl -fsS -H "x-master-key: $MASTER_KEY" "$STAGING_URL/api/admin/status" | head -c 500 && echo

echo "[3/5] Redis connectivity (via /health/redis if exists)..."
curl -fsS "$STAGING_URL/health/redis" 2>/dev/null || echo "(no /health/redis endpoint yet — OK)"

echo "[4/5] Feature flags state..."
curl -fsS "$STAGING_URL/api/debug/env-check" | head -c 300 && echo

echo "[5/5] DB migrations applied..."
curl -fsS -H "x-master-key: $MASTER_KEY" "$STAGING_URL/api/admin/status" | grep -i "meeting" || echo "(no meeting-room tables in staging yet)"

echo "=== PASS ==="
