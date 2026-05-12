#!/bin/bash
set -e
DATE=$(date +%Y-%m-%d)
cd "$(dirname "$0")/.."
git add data/
git commit -m "data: ${DATE} 前端岗位技能报告"
git push
