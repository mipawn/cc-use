#!/bin/bash
set -e

VERSION="$1"

if [ -z "$VERSION" ]; then
  echo "用法: ./release.sh <版本号>"
  echo "示例: ./release.sh 2.1.0"
  exit 1
fi

# Validate semver format
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "错误: 版本号必须符合语义化版本格式 (例如: 2.1.0)"
  exit 1
fi

echo "正在发布 v${VERSION}..."

# Ensure script is run from repo root
if [ ! -f "package.json" ] || [ ! -f "src-tauri/tauri.conf.json" ] || [ ! -f "src-tauri/Cargo.toml" ]; then
  echo "错误: 请在仓库根目录执行脚本 (package.json 所在目录)。"
  exit 1
fi

# Update package.json
sed -i '' "s/\"version\": \".*\"/\"version\": \"${VERSION}\"/" package.json

# Update tauri.conf.json
sed -i '' "s/\"version\": \".*\"/\"version\": \"${VERSION}\"/" src-tauri/tauri.conf.json

# Update Cargo.toml (only the version field under [package])
# NOTE: BSD sed (macOS) does not support the "0,/<regex>/" addressing mode reliably.
# Use a safe multi-line replacement scoped to the [package] section.
export VERSION
perl -0777 -i -pe 's/(^\[package\][\s\S]*?^version\s*=\s*")[^"]*(")/${1}$ENV{VERSION}${2}/m' src-tauri/Cargo.toml

# Update Cargo.lock
cd src-tauri && cargo generate-lockfile 2>/dev/null && cd ..

echo "已更新版本号:"
echo "  package.json:    $(grep '"version"' package.json | head -1 | xargs)"
echo "  tauri.conf.json: $(grep '"version"' src-tauri/tauri.conf.json | head -1 | xargs)"
echo "  Cargo.toml:      $(grep '^version' src-tauri/Cargo.toml | head -1 | xargs)"

# Git operations
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit --allow-empty -m "release(app): v${VERSION}"
git tag "v${VERSION}"
git push origin main
git push origin "v${VERSION}"

echo ""
echo "完成! 已推送 v${VERSION} tag，GitHub Actions 将自动构建并发布 Release。"
