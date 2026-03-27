#!/usr/bin/env bash
set -euo pipefail

# da_boss installer
# Builds the server, sets up .env, installs launchd service

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLIST_NAME="com.daboss.agent-manager"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_DIR="$HOME/Library/Logs/da_boss"

cd "$PROJECT_DIR"

echo "=== da_boss installer ==="
echo ""

# Check Node version
NODE_VERSION=$(node -v 2>/dev/null || echo "none")
NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  echo "Error: Node.js >= 18 required (found $NODE_VERSION)"
  echo "Run: nvm use 22"
  exit 1
fi
echo "Node: $NODE_VERSION"

# Install dependencies
echo "Installing dependencies..."
npm install --silent

# Build server
echo "Building server..."
npm run build -w server

# Build UI
echo "Building UI..."
npm run build -w ui

# Create .env if missing
if [ ! -f .env ]; then
  echo "Creating .env..."
  SESSION_SECRET=$(openssl rand -hex 16)
  AUTH_PASSWORD=$(openssl rand -base64 12)
  cat > .env << ENVEOF
AUTH_PASSWORD=${AUTH_PASSWORD}
SESSION_SECRET=${SESSION_SECRET}
NTFY_TOPIC=
PORT=3847
ANTHROPIC_ADMIN_API_KEY=
ENVEOF
  echo ""
  echo "  Generated password: ${AUTH_PASSWORD}"
  echo "  (saved in .env — change it if you want)"
  echo ""
else
  echo ".env already exists, skipping"
fi

# Create log directory
mkdir -p "$LOG_DIR"

# Install launchd plist
echo "Installing launchd service..."
NODE_PATH=$(which node)

cat > "$PLIST_PATH" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${PROJECT_DIR}/server/dist/index.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}/server</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>DB_PATH</key>
    <string>${PROJECT_DIR}/da_boss.db</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/stdout.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/stderr.log</string>

  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
PLISTEOF

echo ""
echo "=== Installation complete ==="
echo ""
echo "Commands:"
echo "  Start:   launchctl load ${PLIST_PATH}"
echo "  Stop:    launchctl unload ${PLIST_PATH}"
echo "  Status:  launchctl list | grep daboss"
echo "  Logs:    tail -f ${LOG_DIR}/stderr.log"
echo ""
echo "Dashboard: http://localhost:3847"
echo ""
echo "To start now:"
echo "  launchctl load ${PLIST_PATH}"
