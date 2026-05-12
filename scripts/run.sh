#!/bin/bash
set -e
cd "$(dirname "$0")/.."

echo "▶ 开始抓取..."
node scripts/scrape.js

echo "▶ 开始分析..."
node scripts/analyze.js

echo "▶ 推送到 GitHub..."
bash scripts/push.sh

echo "✅ 完成"
