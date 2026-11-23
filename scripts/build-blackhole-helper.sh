#!/usr/bin/env bash
# 编译 macOS 原生系统音频引擎（ScreenCaptureKit 音频内录 + CoreAudio 多输出与音量控制），产物输出到 build/blackhole-setup
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
# 目标 arm64 + macOS 13.0，支持 ScreenCaptureKit 原生音频捕获 (capturesAudio)
swiftc -O -target arm64-apple-macos13.0 -o build/blackhole-setup electron/native/blackhole-setup.swift
echo "built build/blackhole-setup"
