#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_APP="/Applications/GlassPad.app"

if [ -d "$SCRIPT_DIR/GlassPad.app" ] && [ ! -d "$TARGET_APP" ]; then
  echo "正在将 GlassPad 安装到 /Applications ..."
  ditto "$SCRIPT_DIR/GlassPad.app" "$TARGET_APP"
fi

if [ -d "$TARGET_APP" ]; then
  echo "正在清除 macOS 隔离属性 (xattr -cr)..."
  xattr -cr "$TARGET_APP" 2>/dev/null || true
  codesign --force --deep --sign - "$TARGET_APP" 2>/dev/null || true
  echo "修复完成，正在启动 GlassPad..."
  open "$TARGET_APP"
elif [ -d "$SCRIPT_DIR/GlassPad.app" ]; then
  xattr -cr "$SCRIPT_DIR/GlassPad.app" 2>/dev/null || true
  open "$SCRIPT_DIR/GlassPad.app"
else
  echo "未找到 GlassPad.app，请先将 GlassPad 拖入 Applications 文件夹。"
  read -n 1 -s -r -p "按任意键退出..."
fi
