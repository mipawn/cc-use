#!/bin/bash
set -e

VERSION="$1"

if [ -z "$VERSION" ]; then
  echo "Usage: ./release.sh <version>"
  echo "Example: ./release.sh 2.1.0"
  exit 1
fi

# Validate semver format
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: Version must be in semver format (e.g., 2.1.0)"
  exit 1
fi

echo "Releasing v${VERSION}..."

# Update package.json
sed -i '' "s/\"version\": \".*\"/\"version\": \"${VERSION}\"/" package.json

# Update tauri.conf.json
sed -i '' "s/\"version\": \".*\"/\"version\": \"${VERSION}\"/" src-tauri/tauri.conf.json

# Update Cargo.toml (only the first occurrence under [package])
sed -i '' "0,/^version = \".*\"/s//version = \"${VERSION}\"/" src-tauri/Cargo.toml

# Update Cargo.lock
cd src-tauri && cargo generate-lockfile 2>/dev/null && cd ..

echo "Updated versions:"
echo "  package.json:    $(grep '"version"' package.json | head -1 | xargs)"
echo "  tauri.conf.json: $(grep '"version"' src-tauri/tauri.conf.json | head -1 | xargs)"
echo "  Cargo.toml:      $(grep '^version' src-tauri/Cargo.toml | head -1 | xargs)"

# Git operations
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "release: v${VERSION}"
git tag "v${VERSION}"
git push origin main
git push origin "v${VERSION}"

echo ""
echo "Done! v${VERSION} tag pushed, GitHub Actions will build and publish the release."
