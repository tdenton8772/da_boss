#!/usr/bin/env bash
set -euo pipefail

PLIST_NAME="com.daboss.agent-manager"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"

echo "=== da_boss uninstaller ==="

if [ -f "$PLIST_PATH" ]; then
  echo "Stopping service..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm "$PLIST_PATH"
  echo "Service removed"
else
  echo "No service found"
fi

echo ""
echo "Note: project files, .env, and database are NOT deleted."
echo "Remove manually if needed: rm -rf $(cd "$(dirname "$0")/.." && pwd)"
