#!/usr/bin/env bash
# 编译 macOS BlackHole 配置 helper（CoreAudio 多输出设备创建），产物输出到 build/blackhole-setup
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
# 目标 arm64 + macOS 12.0，匹配当前发布的 arm64 DMG，并兼容较老的 macOS 版本
swiftc -O -target arm64-apple-macos12.0 -o build/blackhole-setup electron/native/blackhole-setup.swift
echo "built build/blackhole-setup"
