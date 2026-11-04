#!/usr/bin/env bash
# Render SiteMuster screens via React Native Web in headless Chromium for PR screenshots.
# Runs entirely in a scratch copy; never modifies the repository's app configuration.
set -Eeuo pipefail

scenario="${1:?scenario name (e.g. m01)}"
output_dir="${2:?output directory for PNGs}"
scratch="${3:?scratch directory outside the repository}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
output_abs="$(mkdir -p "$output_dir" && cd "$output_dir" && pwd)"

rm -rf "$scratch"
mkdir -p "$scratch"
# Copy the working tree (tracked + untracked, excluding ignored files) into the scratch copy.
(cd "$repo_root" && git ls-files -co --exclude-standard -z | xargs -0 -I{} cp --parents {} "$scratch")
# Hard-link copy of node_modules so the repository's installed tree is never modified.
cp -al "$repo_root/node_modules" "$scratch/node_modules"

# Web-only shims mirror repository paths (e.g. shims/src/auth/native-storage.web.ts).
cp -R "$repo_root/tools/ui-preview/shims/." "$scratch/"

# Enable the web platform in the scratch copy only.
node - "$scratch/app.config.ts" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
let text = fs.readFileSync(file, 'utf8');
text = text.replace("platforms: ['ios', 'android'],", "platforms: ['ios', 'android', 'web'],\n    web: { output: 'single', bundler: 'metro' },");
fs.writeFileSync(file, text);
NODE

# Install react-native-web (Expo SDK 58 pin) into an isolated prefix, then add only packages the
# scratch tree does not already have (never overwriting React or any app dependency).
mkdir -p "$scratch/.rnw"
npm install --prefix "$scratch/.rnw" --no-save --no-audit --no-fund --legacy-peer-deps \
  react-native-web@0.21.4 >/dev/null
for pkg_dir in "$scratch/.rnw/node_modules"/* "$scratch/.rnw/node_modules"/@*/*; do
  [[ -d "$pkg_dir" ]] || continue
  rel="${pkg_dir#"$scratch/.rnw/node_modules/"}"
  [[ "$rel" == @* && "$rel" != */* ]] && continue
  if [[ ! -e "$scratch/node_modules/$rel" ]]; then
    mkdir -p "$(dirname "$scratch/node_modules/$rel")"
    cp -a "$pkg_dir" "$scratch/node_modules/$rel"
  fi
done

# Point the web render at the LOCAL Supabase stack when one is exported (never a hosted project).
supabase_url="${API_URL:-}"
if [[ -n "$supabase_url" && "$supabase_url" != http://127.0.0.1* && "$supabase_url" != http://localhost* ]]; then
  echo "[ui-preview] refusing to render against a non-local API_URL" >&2
  exit 1
fi
(cd "$scratch" && EXPO_OFFLINE=1 CI=1 EXPO_PUBLIC_SUPABASE_URL="$supabase_url" \
  EXPO_PUBLIC_SUPABASE_ANON_KEY="${ANON_KEY:-}" npx expo export --platform web --output-dir dist >/dev/null)

port=8765
(cd "$scratch/dist" && python3 -m http.server "$port" >/dev/null 2>&1) &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
sleep 1

node "$repo_root/tools/ui-preview/scenarios/$scenario.cjs" "http://127.0.0.1:$port" "$output_abs"
echo "[ui-preview] screenshots written to $output_abs"
