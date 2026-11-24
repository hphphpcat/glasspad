import React, { useState, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';

// 客户 App（Electron）只读；导师用网页版可编辑
const isClientApp = Boolean(window.electronAPI?.isDesktop);
const isWindows = window.electronAPI?.platform === 'win32' || /Win/i.test(navigator.platform || '');
const modKey = isWindows ? 'Ctrl+' : '⌘';
const uiFont = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif';
const codeFont = 'ui-monospace, SFMono-Regular, "Cascadia Code", Consolas, Menlo, "Microsoft YaHei UI", monospace';
const DEFAULT_RTC_ICE_SERVERS = [
  {
    urls: [
      'stun:stun.cloudflare.com:3478',
      'stun:stun.miwifi.com:3478',
      'stun:stun.qq.com:3478',
      'stun:stun.l.google.com:19302',
    ],
  },
];

let cachedRtcConfig = null; // { iceServers, hasTurn, provider, fetchedAt }

function getHttpApiBase(wsBaseOverride) {
  const defaultWs = window.location.protocol === 'file:'
    ? 'wss://glasspad.up.railway.app'
    : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
  const raw = wsBaseOverride || import.meta.env.VITE_WS_URL || defaultWs;
  return raw.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/+$/, '');
}

async function fetchRtcIceConfig(wsBaseOverride, forceRefresh = false) {
  const now = Date.now();
  // 只有当已拿到 TURN 凭证时才缓存 10 分钟；stun-only 只缓存 5 秒避免卡死在旧配置上
  const ttlMs = cachedRtcConfig?.hasTurn ? 10 * 60 * 1000 : 5 * 1000;
  if (!forceRefresh && cachedRtcConfig && now - cachedRtcConfig.fetchedAt < ttlMs) {
    return cachedRtcConfig;
  }
  try {
    const apiBase = getHttpApiBase(wsBaseOverride);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${apiBase}/api/rtc-config`, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.iceServers) && data.iceServers.length > 0) {
        cachedRtcConfig = {
          iceServers: data.iceServers,
          hasTurn: Boolean(data.hasTurn),
          provider: data.provider || 'unknown',
          fetchedAt: now,
        };
        return cachedRtcConfig;
      }
    }
  } catch {}
  return {
    iceServers: DEFAULT_RTC_ICE_SERVERS,
    hasTurn: false,
    provider: 'stun-only',
    fetchedAt: now,
  };
}

// macOS：枚举音频输入设备，识别 BlackHole（系统音环回）与物理麦克风（排除 BlackHole 及所有虚拟设备）
async function getMacAudioSources() {
  let probe = null;
  try {
    // 先请求一次权限，确保 enumerateDevices 返回带 label 的设备名（否则 label 为空无法识别 BlackHole）
    probe = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return { blackholeId: null, micId: null, error: '麦克风权限未开启' };
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    const blackhole = inputs.find((d) => /BlackHole/i.test(d.label || ''));
    // 物理麦克风：排除 default 占位项、BlackHole 本身、聚合设备（GlassPad 系统音）及 Zoom/Oray/ToDesk 等虚拟设备
    const mic = inputs.find((d) => {
      if (d.deviceId === 'default' || d.deviceId === blackhole?.deviceId) return false;
      const lab = d.label || '';
      return !/BlackHole|GlassPad|Aggregate|Virtual|ZoomAudio|Oray|ToDesk/i.test(lab);
    });
    return { blackholeId: blackhole?.deviceId || null, micId: mic?.deviceId || null, error: '' };
  } finally {
    probe?.getTracks().forEach((t) => t.stop());
  }
}

// ── 视频编码硬件加速优先（降低与腾讯会议同时共享时的 CPU/GPU 争抢） ──
// 优先把 H.264 硬件编码排到最前（Mac VideoToolbox / Win MediaFoundation 功耗仅为 VP9 软编的 1/4），VP8 次之
function preferHardwareVideoCodec(pc, sender) {
  try {
    if (typeof RTCRtpSender === 'undefined' || !RTCRtpSender.getCapabilities) return;
    const caps = RTCRtpSender.getCapabilities('video');
    if (!caps || !Array.isArray(caps.codecs)) return;
    const trans = pc.getTransceivers().find((t) => t.sender === sender);
    if (!trans || typeof trans.setCodecPreferences !== 'function') return;
    const h264 = [];
    const vp8 = [];
    const others = [];
    for (const c of caps.codecs) {
      const mime = String(c.mimeType || '').toLowerCase();
      if (mime === 'video/h264') h264.push(c);
      else if (mime === 'video/vp8') vp8.push(c);
      else others.push(c);
    }
    const ordered = [...h264, ...vp8, ...others];
    if (ordered.length > 0) trans.setCodecPreferences(ordered);
  } catch {}
}

// 音频编码抗丢包优化：强制在 SDP 中为 Opus 开启带内前向纠错 (useinbandfec=1) 与高码率语音/立体声参数，
// 显著提升跨国/台湾代理/弱网下的语音清晰度与抗丢包能力，减少吞字与机器人声
function enhanceOpusSdp(sdp, { stereo = false, maxAverageBitrate = 96000 } = {}) {
  if (!sdp || typeof sdp !== 'string') return sdp;
  const lines = sdp.split(/\r?\n/);
  let opusPayload = null;
  for (const line of lines) {
    const m = line.match(/^a=rtpmap:(\d+)\s+opus\/48000/i);
    if (m) {
      opusPayload = m[1];
      break;
    }
  }
  if (!opusPayload) return sdp;

  const desired = {
    minptime: '10',
    useinbandfec: '1',
    usedtx: '0',
    maxaveragebitrate: String(maxAverageBitrate),
  };
  if (stereo) {
    desired.stereo = '1';
    desired['sprop-stereo'] = '1';
  }

  let patched = false;
  const fmtpPrefix = `a=fmtp:${opusPayload} `;
  const out = lines.map((line) => {
    if (!line.startsWith(fmtpPrefix)) return line;
    patched = true;
    const rawParams = line.slice(fmtpPrefix.length).trim();
    const map = new Map();
    if (rawParams) {
      for (const part of rawParams.split(';')) {
        const idx = part.indexOf('=');
        if (idx > 0) {
          map.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
        } else if (part.trim()) {
          map.set(part.trim(), '');
        }
      }
    }
    for (const [k, v] of Object.entries(desired)) {
      map.set(k, v);
    }
    const merged = Array.from(map.entries())
      .map(([k, v]) => (v === '' ? k : `${k}=${v}`))
      .join(';');
    return `${fmtpPrefix}${merged}`;
  });

  if (!patched) {
    const rtpmapIdx = out.findIndex((l) => l.startsWith(`a=rtpmap:${opusPayload} `));
    if (rtpmapIdx >= 0) {
      const merged = Object.entries(desired).map(([k, v]) => `${k}=${v}`).join(';');
      out.splice(rtpmapIdx + 1, 0, `${fmtpPrefix}${merged}`);
    }
  }
  return out.join('\r\n');
}

// 腾讯会议同款：将主进程 ScreenCaptureKit 推送的 48kHz 双声道交错 Float32 PCM 实时合成 WebAudio MediaStream
// 升级为独立音频渲染线程 AudioWorklet + 水位漂移自动追新保护（彻底消除主线程卡顿爆音与长时延迟累积）
const SCK_WORKLET_CODE = `
class SCKPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 环形缓冲区：最多容纳 240ms 双声道交错 Float32（48000 * 0.24 * 2）
    this.capacity = 48000 * 2;
    this.ring = new Float32Array(this.capacity);
    this.readPos = 0;
    this.writePos = 0;
    this.available = 0;
    // 水位保护：超过 85ms 自动丢弃最旧样本追平至 25ms，永不累积延迟也不撞车产生电流声
    this.highWater = Math.floor(48000 * 0.085) * 2;
    this.targetWater = Math.floor(48000 * 0.025) * 2;
    this.lastL = 0;
    this.lastR = 0;

    this.port.onmessage = (ev) => {
      const floats = ev.data;
      if (!floats || !floats.length) return;
      const n = floats.length;
      if (n >= this.capacity) {
        const start = n - this.targetWater;
        this.readPos = 0;
        this.writePos = 0;
        this.available = 0;
        for (let i = Math.max(0, start); i < n; i++) {
          this.ring[this.writePos] = floats[i];
          this.writePos = (this.writePos + 1) % this.capacity;
          this.available++;
        }
        return;
      }
      // 溢出前先丢旧，保证 readPos/writePos 永不重叠
      if (this.available + n > this.capacity) {
        const drop = (this.available + n - this.targetWater) & ~1;
        this.readPos = (this.readPos + drop) % this.capacity;
        this.available = Math.max(0, this.available - drop);
      }
      for (let i = 0; i < n; i++) {
        this.ring[this.writePos] = floats[i];
        this.writePos = (this.writePos + 1) % this.capacity;
      }
      this.available += n;
      // 时钟漂移超过 85ms 时平滑跳到 25ms 处，防止几十分钟后音画脱节
      if (this.available > this.highWater) {
        const drop = (this.available - this.targetWater) & ~1;
        this.readPos = (this.readPos + drop) % this.capacity;
        this.available -= drop;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length < 2) return true;
    const outL = out[0];
    const outR = out[1];
    const frames = outL.length;
    const needed = frames * 2;
    if (this.available >= needed) {
      for (let i = 0; i < frames; i++) {
        const l = this.ring[this.readPos];
        const r = this.ring[(this.readPos + 1) % this.capacity];
        outL[i] = l;
        outR[i] = r;
        this.readPos = (this.readPos + 2) % this.capacity;
      }
      this.lastL = outL[frames - 1];
      this.lastR = outR[frames - 1];
      this.available -= needed;
    } else {
      // 欠载时做指数淡出归零，避免直接填 0 产生咔哒爆破音
      let l = this.lastL;
      let r = this.lastR;
      for (let i = 0; i < frames; i++) {
        l *= 0.88;
        r *= 0.88;
        outL[i] = l;
        outR[i] = r;
      }
      this.lastL = Math.abs(l) < 1e-5 ? 0 : l;
      this.lastR = Math.abs(r) < 1e-5 ? 0 : r;
    }
    return true;
  }
}
registerProcessor('sck-pcm-processor', SCKPcmProcessor);
`;

async function createNativeSCKAudioStream() {
  if (!window.electronAPI?.startNativeAudioStream || !window.electronAPI?.onNativeAudioPcm) return null;
  const res = await window.electronAPI.startNativeAudioStream();
  if (!res?.ok) return null;

  const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  await ctx.resume();
  const dest = ctx.createMediaStreamDestination();

  // 优先使用独立实时音频线程 AudioWorklet（零主线程卡顿爆音）
  if (ctx.audioWorklet) {
    let workletUrl = '';
    try {
      const blob = new Blob([SCK_WORKLET_CODE], { type: 'application/javascript' });
      workletUrl = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(workletUrl);
      const workletNode = new AudioWorkletNode(ctx, 'sck-pcm-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      workletNode.connect(dest);

      const offPcm = window.electronAPI.onNativeAudioPcm((rawBuf) => {
        if (!rawBuf) return;
        const bytes = rawBuf instanceof Uint8Array ? rawBuf : new Uint8Array(rawBuf);
        const floatLen = Math.floor(bytes.byteLength / 4);
        if (floatLen <= 0) return;
        // 拷贝为独立 Float32Array 后 Transferable 零拷贝转交音频线程
        const copy = new Float32Array(floatLen);
        copy.set(new Float32Array(bytes.buffer, bytes.byteOffset, floatLen));
        workletNode.port.postMessage(copy, [copy.buffer]);
      });

      return {
        stream: dest.stream,
        isNativeSck: true,
        cleanup: () => {
          try { offPcm?.(); } catch {}
          try { workletNode.port.onmessage = null; workletNode.disconnect(); } catch {}
          try { if (workletUrl) URL.revokeObjectURL(workletUrl); } catch {}
          try { ctx.close(); } catch {}
          window.electronAPI?.stopNativeAudioStream?.();
        },
      };
    } catch {
      if (workletUrl) {
        try { URL.revokeObjectURL(workletUrl); } catch {}
      }
    }
  }

  // 兜底：若环境不支持 AudioWorklet，退回带水位漂移保护的 ScriptProcessorNode
  const scriptNode = ctx.createScriptProcessor(512, 0, 2);
  const ringCapacity = 48000 * 2;
  const ring = new Float32Array(ringCapacity);
  const highWater = Math.floor(48000 * 0.085) * 2;
  const targetWater = Math.floor(48000 * 0.025) * 2;
  let writePos = 0;
  let readPos = 0;
  let available = 0;

  const offPcm = window.electronAPI.onNativeAudioPcm((rawBuf) => {
    if (!rawBuf) return;
    const bytes = rawBuf instanceof Uint8Array ? rawBuf : new Uint8Array(rawBuf);
    const floats = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    const n = floats.length;
    if (n <= 0) return;
    if (available + n > ringCapacity) {
      const drop = (available + n - targetWater) & ~1;
      readPos = (readPos + drop) % ringCapacity;
      available = Math.max(0, available - drop);
    }
    for (let i = 0; i < n; i++) {
      ring[writePos] = floats[i];
      writePos = (writePos + 1) % ringCapacity;
    }
    available += n;
    if (available > highWater) {
      const drop = (available - targetWater) & ~1;
      readPos = (readPos + drop) % ringCapacity;
      available -= drop;
    }
  });

  scriptNode.onaudioprocess = (ev) => {
    const outL = ev.outputBuffer.getChannelData(0);
    const outR = ev.outputBuffer.getChannelData(1);
    const frames = outL.length;
    const needed = frames * 2;
    if (available >= needed) {
      for (let i = 0; i < frames; i++) {
        outL[i] = ring[readPos];
        outR[i] = ring[(readPos + 1) % ringCapacity];
        readPos = (readPos + 2) % ringCapacity;
      }
      available -= needed;
    } else {
      outL.fill(0);
      outR.fill(0);
    }
  };

  scriptNode.connect(dest);
  return {
    stream: dest.stream,
    isNativeSck: true,
    cleanup: () => {
      try { offPcm?.(); } catch {}
      try { scriptNode.disconnect(); } catch {}
      try { ctx.close(); } catch {}
      window.electronAPI?.stopNativeAudioStream?.();
    },
  };
}

// 选中文字局部字号范围与默认值（支持 A- / A+ 按钮及 ⌘/Ctrl + +/-/0 快捷键仅对选中文字放大缩小）
const DEFAULT_FONT_SIZE = 15;
const MIN_FONT_SIZE = 11;
const MAX_FONT_SIZE = 28;
function clampFontSize(val) {
  const n = Math.round(Number(val));
  if (!Number.isFinite(n)) return DEFAULT_FONT_SIZE;
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, n));
}

// 动态注入局部字号 Monaco inlineClassName 样式，实现选中文字单独放大/缩小
const injectedInlineSizeClasses = new Set();
function getInlineSizeClassName(size) {
  const s = clampFontSize(size);
  if (s === DEFAULT_FONT_SIZE) return '';
  const className = `gp-inline-size-${s}`;
  if (!injectedInlineSizeClasses.has(className) && typeof document !== 'undefined') {
    let styleEl = document.getElementById('gp-inline-size-styles');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'gp-inline-size-styles';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent += `.monaco-editor .view-line span.${className}, .monaco-editor .view-line span.${className} span { font-size: ${s}px !important; line-height: 28px !important; }\n`;
    injectedInlineSizeClasses.add(className);
  }
  return className;
}

// 规范化局部字号区间：排序、剔除无效或等于默认字号的项、合并相邻同字号区间
function normalizeSizeMarks(marks) {
  if (!Array.isArray(marks)) return [];
  const valid = marks
    .filter((m) => m && Number.isInteger(m.start) && Number.isInteger(m.end) && m.start >= 0 && m.end > m.start && Number.isFinite(Number(m.size)))
    .map((m) => ({ start: m.start, end: m.end, size: clampFontSize(m.size) }))
    .filter((m) => m.size !== DEFAULT_FONT_SIZE)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const seg of valid) {
    const prev = merged[merged.length - 1];
    if (prev && prev.size === seg.size && prev.end >= seg.start) {
      prev.end = Math.max(prev.end, seg.end);
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

// 在给定文本区间集合 [start, end) 上按 delta 分段独立增减字号或重置为默认字号（delta === 0 重置）
// 选区内若包含多个不同字号的子片段，每个子片段在自身原有字号基础上独立 +delta / -delta，不会统一压成同一个字号
function applySizeDeltaToOffsets(marks, ranges, delta) {
  const validRanges = ranges
    .filter((r) => r && Number.isInteger(r.start) && Number.isInteger(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start);
  if (validRanges.length === 0) return normalizeSizeMarks(marks);

  let next = normalizeSizeMarks(marks);
  for (const r of validRanges) {
    if (delta === 0) {
      const carved = [];
      for (const m of next) {
        if (m.end <= r.start || m.start >= r.end) {
          carved.push(m);
        } else {
          if (m.start < r.start) carved.push({ start: m.start, end: r.start, size: m.size });
          if (m.end > r.end) carved.push({ start: r.end, end: m.end, size: m.size });
        }
      }
      next = normalizeSizeMarks(carved);
      continue;
    }

    const carved = [];
    const overlapping = [];
    for (const m of next) {
      if (m.end <= r.start || m.start >= r.end) {
        carved.push(m);
      } else {
        if (m.start < r.start) carved.push({ start: m.start, end: r.start, size: m.size });
        if (m.end > r.end) carved.push({ start: r.end, end: m.end, size: m.size });
        overlapping.push({
          start: Math.max(r.start, m.start),
          end: Math.min(r.end, m.end),
          size: m.size,
        });
      }
    }

    overlapping.sort((a, b) => a.start - b.start);
    let cursor = r.start;
    for (const ov of overlapping) {
      if (ov.start > cursor) {
        // 未标注过的默认字号空隙：在 DEFAULT_FONT_SIZE 基础上 +delta
        const gapSize = clampFontSize(DEFAULT_FONT_SIZE + delta);
        if (gapSize !== DEFAULT_FONT_SIZE) {
          carved.push({ start: cursor, end: ov.start, size: gapSize });
        }
      }
      // 已标注的子片段：在自身原有字号 ov.size 基础上 +delta
      const segSize = clampFontSize(ov.size + delta);
      if (segSize !== DEFAULT_FONT_SIZE) {
        carved.push({ start: ov.start, end: ov.end, size: segSize });
      }
      cursor = ov.end;
    }
    if (cursor < r.end) {
      const tailSize = clampFontSize(DEFAULT_FONT_SIZE + delta);
      if (tailSize !== DEFAULT_FONT_SIZE) {
        carved.push({ start: cursor, end: r.end, size: tailSize });
      }
    }

    next = normalizeSizeMarks(carved);
  }
  return next;
}

// 计算当前选区在顶栏显示的字号标签：单一字号显示数字，混合多种字号显示「min-max」
function getSelectionSizeLabel(marks, ranges) {
  const validRanges = (ranges || []).filter((r) => r && r.end > r.start);
  if (validRanges.length === 0) return String(DEFAULT_FONT_SIZE);
  const sizes = new Set();
  for (const r of validRanges) {
    let covered = 0;
    for (const m of marks || []) {
      if (m.end <= r.start || m.start >= r.end) continue;
      const s = Math.max(r.start, m.start);
      const e = Math.min(r.end, m.end);
      if (e > s) {
        sizes.add(m.size);
        covered += e - s;
      }
    }
    if (covered < r.end - r.start) {
      sizes.add(DEFAULT_FONT_SIZE);
    }
  }
  if (sizes.size === 0) return String(DEFAULT_FONT_SIZE);
  if (sizes.size === 1) return String([...sizes][0]);
  const arr = [...sizes].sort((a, b) => a - b);
  return `${arr[0]}-${arr[arr.length - 1]}`;
}

// 文本变更时按 Monaco contentChanges 增量偏移更新局部字号区间
function shiftSizeMarksByChanges(marks, changes) {
  if (!Array.isArray(marks) || marks.length === 0 || !Array.isArray(changes) || changes.length === 0) {
    return marks || [];
  }
  let current = marks.map((m) => ({ ...m }));
  const sortedChanges = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
  for (const ch of sortedChanges) {
    const editStart = ch.rangeOffset;
    const editOldEnd = ch.rangeOffset + ch.rangeLength;
    const insertedLen = (ch.text || '').length;
    const delta = insertedLen - ch.rangeLength;
    const updated = [];
    for (const m of current) {
      if (m.end <= editStart) {
        updated.push(m);
      } else if (m.start >= editOldEnd) {
        updated.push({ start: m.start + delta, end: m.end + delta, size: m.size });
      } else if (m.start >= editStart && m.end <= editOldEnd) {
        // 整段被替换/删除
      } else if (m.start < editStart && m.end > editOldEnd) {
        const newEnd = m.end + delta;
        if (newEnd > m.start) updated.push({ start: m.start, end: newEnd, size: m.size });
      } else if (m.start < editStart) {
        if (editStart > m.start) updated.push({ start: m.start, end: editStart, size: m.size });
      } else {
        const newStart = editStart + insertedLen;
        const newEnd = m.end + delta;
        if (newEnd > newStart) updated.push({ start: newStart, end: newEnd, size: m.size });
      }
    }
    current = updated;
  }
  return normalizeSizeMarks(current);
}

// 字体颜色快捷预设：空字符串 '' 代表清除选中文本的自定义颜色（恢复 Monaco 默认语法高亮）
const FONT_COLOR_PRESETS = [
  { label: '清除选中色', value: '', swatch: 'linear-gradient(135deg, #38bdf8 0%, #34d399 50%, #f59e0b 100%)' },
  { label: '纯白', value: '#f8fafc', swatch: '#f8fafc' },
  { label: '荧光绿', value: '#34d399', swatch: '#34d399' },
  { label: '冰蓝', value: '#38bdf8', swatch: '#38bdf8' },
  { label: '明黄', value: '#facc15', swatch: '#facc15' },
  { label: '亮红', value: '#f87171', swatch: '#f87171' },
];

// 动态注入远端成员选区背景色（按每个人的代表色半透明高亮）
const injectedRemoteSelClasses = new Set();
function getRemoteSelectionClassName(hex) {
  const clean = String(hex || '').trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(clean)) return 'remote-selection';
  const className = `gp-remote-sel-${clean.slice(1)}`;
  if (!injectedRemoteSelClasses.has(className) && typeof document !== 'undefined') {
    let styleEl = document.getElementById('gp-remote-sel-styles');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'gp-remote-sel-styles';
      document.head.appendChild(styleEl);
    }
    const r = parseInt(clean.slice(1, 3), 16);
    const g = parseInt(clean.slice(3, 5), 16);
    const b = parseInt(clean.slice(5, 7), 16);
    styleEl.textContent += `.monaco-editor .${className} { background-color: rgba(${r}, ${g}, ${b}, 0.35); border-radius: 2px; }\n`;
    injectedRemoteSelClasses.add(className);
  }
  return className;
}

// 过滤掉旧版默认角色名（Client / Mentor / Candidate），要求用户输入真实称呼
function normalizeCustomName(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^(client|mentor|candidate|guest)$/i.test(s)) return '';
  return s.slice(0, 24);
}

// 动态注入单色 Monaco inlineClassName 样式，实现任意 Hex 颜色的局部选中着色
const injectedInlineColorClasses = new Set();
function getInlineColorClassName(hex) {
  const clean = String(hex || '').trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(clean)) return '';
  const className = `gp-inline-color-${clean.slice(1)}`;
  if (!injectedInlineColorClasses.has(className) && typeof document !== 'undefined') {
    let styleEl = document.getElementById('gp-inline-color-styles');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'gp-inline-color-styles';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent += `.monaco-editor .view-line span.${className}, .monaco-editor .view-line span.${className} span { color: ${clean} !important; }\n`;
    injectedInlineColorClasses.add(className);
  }
  return className;
}

// 规范化局部颜色区间：排序、剔除无效项、合并相邻同色区间
function normalizeColorMarks(marks) {
  if (!Array.isArray(marks)) return [];
  const valid = marks
    .filter((m) => m && Number.isInteger(m.start) && Number.isInteger(m.end) && m.start >= 0 && m.end > m.start && /^#[0-9a-fA-F]{6}$/.test(m.color || ''))
    .map((m) => ({ start: m.start, end: m.end, color: m.color.toLowerCase() }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const seg of valid) {
    const prev = merged[merged.length - 1];
    if (prev && prev.color === seg.color && prev.end >= seg.start) {
      prev.end = Math.max(prev.end, seg.end);
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

// 在给定文本区间集合 [start, end) 上应用或清除局部颜色（color 为空串则清除该区间颜色）
function applyColorToOffsets(marks, ranges, color) {
  const validRanges = ranges
    .filter((r) => r && Number.isInteger(r.start) && Number.isInteger(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start);
  if (validRanges.length === 0) return normalizeColorMarks(marks);

  let next = normalizeColorMarks(marks);
  for (const r of validRanges) {
    const carved = [];
    for (const m of next) {
      if (m.end <= r.start || m.start >= r.end) {
        carved.push(m);
      } else {
        if (m.start < r.start) carved.push({ start: m.start, end: r.start, color: m.color });
        if (m.end > r.end) carved.push({ start: r.end, end: m.end, color: m.color });
      }
    }
    if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {
      carved.push({ start: r.start, end: r.end, color: color.toLowerCase() });
    }
    next = normalizeColorMarks(carved);
  }
  return next;
}

// 文本变更时按 Monaco contentChanges 增量偏移更新局部颜色区间
function shiftColorMarksByChanges(marks, changes) {
  if (!Array.isArray(marks) || marks.length === 0 || !Array.isArray(changes) || changes.length === 0) {
    return marks || [];
  }
  let current = marks.map((m) => ({ ...m }));
  // Monaco 的 changes 按文档后到前或顺序给出，逐条以 offset 调整
  const sortedChanges = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
  for (const ch of sortedChanges) {
    const editStart = ch.rangeOffset;
    const editOldEnd = ch.rangeOffset + ch.rangeLength;
    const insertedLen = (ch.text || '').length;
    const delta = insertedLen - ch.rangeLength;
    const updated = [];
    for (const m of current) {
      if (m.end <= editStart) {
        updated.push(m);
      } else if (m.start >= editOldEnd) {
        updated.push({ start: m.start + delta, end: m.end + delta, color: m.color });
      } else if (m.start >= editStart && m.end <= editOldEnd) {
        // 整段被替换/删除，移除该着色
      } else if (m.start < editStart && m.end > editOldEnd) {
        const newEnd = m.end + delta;
        if (newEnd > m.start) updated.push({ start: m.start, end: newEnd, color: m.color });
      } else if (m.start < editStart) {
        if (editStart > m.start) updated.push({ start: m.start, end: editStart, color: m.color });
      } else {
        const newStart = editStart + insertedLen;
        const newEnd = m.end + delta;
        if (newEnd > newStart) updated.push({ start: newStart, end: newEnd, color: m.color });
      }
    }
    current = updated;
  }
  return normalizeColorMarks(current);
}

// 加粗区间复用上面的区间算法：内部用固定占位色 BOLD_SENTINEL 表示「已加粗」，收发时只保留 { start, end }
const BOLD_SENTINEL = '#000000';
const boldToInternal = (marks) => (Array.isArray(marks) ? marks : [])
  .map((m) => ({ start: m?.start, end: m?.end, color: BOLD_SENTINEL }));
const boldToWire = (marks) => marks.map((m) => ({ start: m.start, end: m.end }));

// 选区是否已全部加粗：全部加粗则本次操作为取消加粗，否则为加粗
function isRangesFullyCovered(marks, ranges) {
  return ranges.every((r) => {
    let cursor = r.start;
    for (const m of marks) {
      if (m.end <= cursor) continue;
      if (m.start > cursor) return false;
      cursor = m.end;
      if (cursor >= r.end) return true;
    }
    return cursor >= r.end;
  });
}

const normalizeLF = (s) => (s || '').replace(/\r\n/g, '\n');

const DEFAULT_SERVER_HTTP = 'https://glasspad.up.railway.app';

// 语义化版本对比（纯前端兜底，当 electronAPI.checkForUpdates 不可用时使用）
function compareSemverClient(remoteVer, localVer) {
  const clean = (v) => String(v || '').trim().replace(/^v/i, '').split('-')[0];
  const rParts = clean(remoteVer).split('.').map((n) => parseInt(n, 10) || 0);
  const lParts = clean(localVer).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(rParts.length, lParts.length, 3);
  for (let i = 0; i < len; i++) {
    const r = rParts[i] || 0;
    const l = lParts[i] || 0;
    if (r > l) return 1;
    if (r < l) return -1;
  }
  return 0;
}

// 统一的客户端更新检测函数：优先走 Electron 主进程 IPC，支持传入当前房间的 wsBase 或自定义 JSON 地址
async function performUpdateCheck(customBase) {
  const savedEndpoint = localStorage.getItem('pad_update_endpoint') || '';
  const targetBase = (customBase || savedEndpoint || '').trim();
  if (window.electronAPI?.checkForUpdates) {
    return window.electronAPI.checkForUpdates(targetBase);
  }
  // 浏览器环境或远端热加载模式：若当前已在 https://glasspad.up.railway.app 上运行，前端代码本身已是最新，优先以线上版本作为基准
  let currentVersion = '1.0.26';
  if (window.electronAPI?.getAppVersion) {
    try {
      const info = await window.electronAPI.getAppVersion();
      if (info?.version) currentVersion = info.version;
    } catch {}
  }
  const hotVer = localStorage.getItem('pad_hot_version') || '';
  if (hotVer && compareSemverClient(hotVer, currentVersion) > 0) {
    currentVersion = hotVer;
  }
  let checkUrl = `${DEFAULT_SERVER_HTTP}/api/version`;
  if (targetBase) {
    try {
      const u = new URL(targetBase);
      if (u.protocol === 'ws:') u.protocol = 'http:';
      if (u.protocol === 'wss:') u.protocol = 'https:';
      if (!u.pathname || u.pathname === '/') u.pathname = '/api/version';
      checkUrl = u.toString();
    } catch {}
  } else if (window.location.protocol.startsWith('http')) {
    checkUrl = `${window.location.origin}/api/version`;
  }
  try {
    const res = await fetch(`${checkUrl}${checkUrl.includes('?') ? '&' : '?'}_t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const latestVersion = String(data.version || currentVersion).trim().replace(/^v/i, '');
    const hasUpdate = compareSemverClient(latestVersion, currentVersion) > 0;
    const downloadUrl = isWindows
      ? (data.winUrl || data.downloadUrl || '')
      : (data.macUrl || data.downloadUrl || '');
    return {
      ok: true,
      hasUpdate,
      currentVersion,
      latestVersion,
      downloadUrl,
      macUrl: data.macUrl || '',
      winUrl: data.winUrl || '',
      notes: data.notes || '',
      forceUpdate: Boolean(data.forceUpdate),
    };
  } catch (e) {
    return {
      ok: false,
      hasUpdate: false,
      currentVersion,
      latestVersion: currentVersion,
      error: e.message || '检查更新失败',
    };
  }
}

function openDownloadUrl(url) {
  const s = String(url || '').trim();
  if (!s) return;
  if (window.electronAPI?.openExternalUrl) {
    window.electronAPI.openExternalUrl(s);
  } else {
    window.open(s, '_blank', 'noopener,noreferrer');
  }
}

const btn = {
  background: 'rgba(31, 31, 31, 0.7)', color: '#9ca3af', border: '1px solid #333',
  borderRadius: '6px', padding: '4px 10px', fontSize: '12px', cursor: 'pointer',
};

// GlassPad 品牌矢量 Logo（双层翡翠透视毛玻璃板 + 终端提词流光）
export function BrandLogo({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" style={{ flexShrink: 0, display: 'block' }}>
      <defs>
        <linearGradient id="gp-bg" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#141b24" />
          <stop offset="100%" stopColor="#071512" />
        </linearGradient>
        <linearGradient id="gp-back" x1="16" y1="10" x2="54" y2="42" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#10b981" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0.22" />
        </linearGradient>
        <linearGradient id="gp-front" x1="10" y1="18" x2="50" y2="52" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#10b981" stopOpacity="0.2" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#gp-bg)" stroke="#ffffff" strokeOpacity="0.14" strokeWidth="1.5" />
      <g transform="rotate(-7 34 30)">
        <rect x="17" y="12" width="34" height="28" rx="6" fill="url(#gp-back)" stroke="#34d399" strokeOpacity="0.55" strokeWidth="1.4" />
      </g>
      <rect x="11" y="18" width="38" height="31" rx="6.5" fill="#0f1722" fillOpacity="0.82" />
      <rect x="11" y="18" width="38" height="31" rx="6.5" fill="url(#gp-front)" stroke="#34d399" strokeOpacity="0.65" strokeWidth="1.5" />
      <path d="M17 29.5 L21.5 33 L17 36.5" stroke="#34d399" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="25" y="29" width="18" height="3" rx="1.5" fill="#10b981" />
      <rect x="25" y="34" width="13" height="2.8" rx="1.4" fill="#e2e8f0" />
      <rect x="17" y="40.5" width="22" height="2.4" rx="1.2" fill="#94a3b8" fillOpacity="0.55" />
    </svg>
  );
}

export default function App() {
  const params = new URLSearchParams(window.location.search);

  const [roomId, setRoomId] = useState(() => params.get('room') || '');
  const [token, setToken] = useState(() => params.get('token') || '');
  const [wsBase, setWsBase] = useState(() => params.get('ws') || '');
  const [userName, setUserName] = useState(
    () => normalizeCustomName(params.get('user')) || normalizeCustomName(localStorage.getItem('pad_user_name')) || ''
  );
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  // 桌面端外观：透明度（调低可透视下方浏览器）/ 毛玻璃（默认关闭）
  const [opacity, setOpacity] = useState(() => Number(localStorage.getItem('pad_opacity')) || 0.78);
  const [supportsFrost, setSupportsFrost] = useState(false);
  const [frostedGlass, setFrostedGlass] = useState(() => localStorage.getItem('pad_frost_v2') === 'true');
  // 导师端局部文字样式工具条状态（字号/加粗/颜色均仅作用于选中文本，客户端无修改入口）
  const [selectionFontSize, setSelectionFontSize] = useState(String(DEFAULT_FONT_SIZE));
  const [pickerColor, setPickerColor] = useState('#34d399');
  const [hasSelection, setHasSelection] = useState(false);
  const [colorTip, setColorTip] = useState('');

  const [text, setText] = useState('');
  const [language, setLanguage] = useState('python');
  const [wsConnected, setWsConnected] = useState(false);
  const [authFail, setAuthFail] = useState(false);
  const [destroyedMsg, setDestroyedMsg] = useState('');
  const [participants, setParticipants] = useState([]);

  // ── 屏幕共享状态（客户端推流 / 导师端观看）──
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [shareMicOn, setShareMicOn] = useState(false);
  const [shareHasMic, setShareHasMic] = useState(false); // 是否真正拿到了麦克风音轨
  const [shareSystemAudio, setShareSystemAudio] = useState(false); // 是否真正拿到了系统声音轨
  const [shareMicError, setShareMicError] = useState(''); // 麦克风不可用时的提示
  const [speakerTipDismissed, setSpeakerTipDismissed] = useState(false); // 是否已关闭「请开外放」提醒横幅
  const [audioSetup, setAudioSetup] = useState({ supported: false, blackholeInstalled: false, configured: false }); // macOS BlackHole 状态
  const [audioSetupBusy, setAudioSetupBusy] = useState(false);
  const [audioSetupMsg, setAudioSetupMsg] = useState('');
  const [showAudioGuide, setShowAudioGuide] = useState(false);
  const [speakerVolume, setSpeakerVolume] = useState(60); // 物理扬声器目标音量（0–100），仅 macOS BlackHole 系统音模式可用
  const [shareError, setShareError] = useState('');
  const [remoteShareState, setRemoteShareState] = useState({ active: false, sharerId: null, micOn: false, systemAudio: false });
  const [showViewerPane, setShowViewerPane] = useState(true);
  const [viewerConnected, setViewerConnected] = useState(false);
  const [viewerConnMode, setViewerConnMode] = useState(''); // '' | 'P2P 直连' | 'TURN 中继' | '连接中…' | ...
  const [viewerForceRelay, setViewerForceRelay] = useState(false); // 跨区/代理黑屏时一键或自动切换强制 TURN 中继
  const [viewerMuted, setViewerMuted] = useState(false);

  // ── 导师端开麦语音通话状态（独立 WebRTC 音频通道，支持全房间听见导师声音） ──
  const [mentorMicOn, setMentorMicOn] = useState(false);
  const [mentorMicError, setMentorMicError] = useState('');
  const [activeVoiceSpeakers, setActiveVoiceSpeakers] = useState([]); // [{ id, name }]
  const [mentorVoiceMuted, setMentorVoiceMuted] = useState(false); // 收听端是否静音导师语音

  // ── 客户端版本与检查更新状态 ──
  const [appVersion, setAppVersion] = useState('1.0.0');
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null); // { ok, hasUpdate, currentVersion, latestVersion, downloadUrl, notes, forceUpdate, error }
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [updateBannerText, setUpdateBannerText] = useState('');

  const wsRef = useRef(null);
  const myClientIdRef = useRef('');
  const editorRef = useRef(null);
  const isRemote = useRef(false);
  const remoteSelDecorations = useRef(null); // 对方选区的高亮装饰集合
  const remoteCursorsRef = useRef(new Map()); // Map<clientId, { name, color, selections, showFlag }>
  const cursorWidgetsRef = useRef(new Map()); // Map<clientId, Monaco IContentWidget>
  const cursorFlagTimersRef = useRef(new Map()); // Map<clientId, TimeoutId> 控制名字标签在几秒后自动淡出消失
  const colorMarksDecorations = useRef(null); // 选中文本局部字色装饰集合
  const colorMarksRef = useRef([]); // 当前文档的局部字色区间 [{ start, end, color }]
  const boldMarksDecorations = useRef(null); // 选中文本加粗装饰集合
  const boldMarksRef = useRef([]); // 当前文档的加粗区间（内部格式 { start, end, color: BOLD_SENTINEL }）
  const sizeMarksDecorations = useRef(null); // 选中文本局部字号装饰集合
  const sizeMarksRef = useRef([]); // 当前文档的局部字号区间 [{ start, end, size }]
  const lastNonEmptySelectionsRef = useRef([]); // 缓存最近一次非空选区，防止点击顶栏控件或系统取色器时选区丢失
  const latestText = useRef(''); // 最近收到的远端文字（编辑器挂载前到达时用于补写）

  // 客户端共享屏幕用到的 WebRTC / Media 引用
  const shareSessionRef = useRef(null); // { displayStream, micStream, audioCtx, micTrack, sysAudioTrack, videoTrack, audioTrack, peers: Map<viewerId, { pc, pendingIce: [] }> }
  const speakerDuckedRef = useRef(false); // 开麦时是否已压低扬声器音量（避免外放被麦克风拾取产生重音）
  // 导师端观看屏幕用到的 WebRTC / Video 引用
  const viewerPcRef = useRef(null); // { pc, sharerId, pendingIce: [], stream: MediaStream, reconnectTimer, frameWatchTimer, forceRelay }
  const earlyViewerIceRef = useRef(new Map()); // Map<sharerId, RTCIceCandidateInit[]> 缓存 offer await 期间提前到达的 ICE 候选，彻底消灭竞态丢包
  const remoteVideoRef = useRef(null);

  // 导师开麦独立语音通道 WebRTC 引用
  const mentorVoiceSessionRef = useRef(null); // { stream, audioTrack, peers: Map<listenerId, { pc, pendingIce: [] }> }
  const voiceListenerPcsRef = useRef(new Map()); // Map<speakerId, { pc, audioEl, stream, pendingIce: [], reconnectTimer, meterCtx, analyser, pcm }>
  const earlyVoiceIceRef = useRef(new Map()); // Map<speakerId, RTCIceCandidateInit[]>
  const mentorVoiceMutedRef = useRef(false);
  const mentorVoiceRmsRef = useRef(0); // 客户端当前正在播放的导师语音实时电平（供 Windows/BlackHole 防回环门控使用）

  // 桌面端：检测系统是否支持毛玻璃 + 启动时获取版本号并静默检查更新
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    api.getFrostSupport?.().then((res) => {
      const ok = Boolean(res?.supportsFrostedGlass);
      setSupportsFrost(ok);
      api.setFrostedGlass(ok && frostedGlass);
    });
    api.getAppVersion?.().then((info) => {
      if (info?.version) setAppVersion(info.version);
    });
    // macOS：启动即读取 BlackHole 安装状态与本机物理扬声器当前音量，确保未开屏幕共享时顶栏也能随时调节音量
    if (api.platform === 'darwin' && api.getAudioSetupStatus) {
      api.getAudioSetupStatus().then((st) => {
        const installed = Boolean(st?.blackholeInstalled);
        setAudioSetup({ supported: Boolean(st?.supported), blackholeInstalled: installed, configured: false });
        if (installed && api.getSpeakerVolume) {
          api.getSpeakerVolume().then((vol) => {
            if (typeof vol?.volume === 'number') setSpeakerVolume(vol.volume);
          }).catch(() => {});
        }
      }).catch(() => {});
    }
    // 启动后自动检查更新：若发现新版本，直接弹出更新提示卡片并高亮顶栏按钮
    performUpdateCheck(wsBase).then((res) => {
      if (res?.currentVersion) setAppVersion(res.currentVersion);
      if (res?.ok && res.hasUpdate) {
        setUpdateInfo(res);
        setShowUpdateModal(true);
      }
    });

    // 隐身安全加固：桌面客户端下彻底剥离一切 DOM 节点的原生 title 属性（含 Monaco 内部动态生成的节点），
    // 防止鼠标悬停时操作系统创建独立的原生 Tooltip 子窗口（该子窗口不受主窗口 setContentProtection 保护，会在全屏共享中暴露）
    const stripNativeTitles = (root = document.body) => {
      if (!root) return;
      if (root.nodeType === 1 && root.hasAttribute?.('title')) {
        root.removeAttribute('title');
      }
      root.querySelectorAll?.('[title]').forEach((el) => el.removeAttribute('title'));
    };
    stripNativeTitles();
    const titleObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.target?.hasAttribute?.('title')) {
          m.target.removeAttribute('title');
        } else if (m.addedNodes?.length) {
          m.addedNodes.forEach((n) => stripNativeTitles(n));
        }
      }
    });
    if (document.body) {
      titleObserver.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['title'],
      });
    }
    return () => titleObserver.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 手动点击「检查更新」
  const handleManualCheckUpdate = async () => {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    setUpdateBannerText('');
    try {
      const res = await performUpdateCheck(wsBase);
      if (res?.currentVersion) setAppVersion(res.currentVersion);
      setUpdateInfo(res);
      if (!res?.ok) {
        setUpdateBannerText(`检查失败: ${res?.error || '网络不可达'}`);
        setTimeout(() => setUpdateBannerText(''), 3500);
      } else if (res.hasUpdate) {
        setShowUpdateModal(true);
      } else {
        setUpdateBannerText(`当前已是最新版本 (v${res.currentVersion})`);
        setTimeout(() => setUpdateBannerText(''), 3000);
      }
    } finally {
      setCheckingUpdate(false);
    }
  };

  // 桌面端：透明度记忆 + ⌘[ / ⌘] 调节；导师端：⌘/Ctrl + +/-/0 对选中文字放大/缩小/重置
  useEffect(() => {
    localStorage.setItem('pad_opacity', String(opacity));
  }, [opacity]);

  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (isClientApp && e.key === '[') {
        e.preventDefault();
        setOpacity((p) => Math.max(0.08, Number((p - 0.08).toFixed(2))));
      } else if (isClientApp && e.key === ']') {
        e.preventDefault();
        setOpacity((p) => Math.min(1, Number((p + 0.08).toFixed(2))));
      } else if (!isClientApp && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        handleAdjustSelectionSize(2);
      } else if (!isClientApp && (e.key === '-' || e.key === '_')) {
        e.preventDefault();
        handleAdjustSelectionSize(-2);
      } else if (!isClientApp && e.key === '0') {
        e.preventDefault();
        handleAdjustSelectionSize(0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleFrostedGlass = (enabled) => {
    setFrostedGlass(enabled);
    localStorage.setItem('pad_frost_v2', String(enabled));
    window.electronAPI?.setFrostedGlass?.(enabled);
  };

  // ── 屏幕共享：清理观看端 WebRTC 连接 ──
  const closeViewerConnection = () => {
    const cur = viewerPcRef.current;
    if (cur) {
      if (cur.reconnectTimer) clearTimeout(cur.reconnectTimer);
      if (cur.frameWatchTimer) clearTimeout(cur.frameWatchTimer);
      if (cur.disconnectTimer) clearTimeout(cur.disconnectTimer);
      if (cur.stallTimer) clearInterval(cur.stallTimer);
      cur.pc.onicecandidate = null;
      cur.pc.ontrack = null;
      cur.pc.onconnectionstatechange = null;
      cur.pc.oniceconnectionstatechange = null;
      try { cur.pc.close(); } catch {}
      viewerPcRef.current = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    setViewerConnected(false);
    setViewerConnMode('');
  };

  // 按当前在线观看者人数动态调整每路视频码率与帧率，避免多导师同时看 + 腾讯会议并行时上行带宽与 CPU 被挤爆
  const rebalanceSharePeersBitrate = (session) => {
    if (!session || session.stopped) return;
    const peerCount = Math.max(1, session.peers.size);
    const maxBitrate = peerCount === 1 ? 1_800_000 : peerCount === 2 ? 1_200_000 : 850_000;
    const maxFramerate = peerCount === 1 ? 24 : peerCount === 2 ? 18 : 15;
    session.peers.forEach((entry) => {
      if (!entry.videoSender) return;
      try {
        const params = entry.videoSender.getParameters() || {};
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        params.encodings[0].maxBitrate = maxBitrate;
        params.encodings[0].maxFramerate = maxFramerate;
        params.encodings[0].priority = 'high';
        params.encodings[0].networkPriority = 'high';
        params.degradationPreference = 'maintain-resolution';
        entry.videoSender.setParameters(params).catch(() => {});
      } catch {}
    });
  };

  // ── 屏幕共享：关闭单个观看者的 PeerConnection（共享端） ──
  const removeViewerPeer = (viewerId) => {
    const session = shareSessionRef.current;
    if (!session) return;
    const entry = session.peers.get(viewerId);
    if (entry) {
      if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
      entry.pc.onicecandidate = null;
      entry.pc.onconnectionstatechange = null;
      entry.pc.oniceconnectionstatechange = null;
      try { entry.pc.close(); } catch {}
      session.peers.delete(viewerId);
      rebalanceSharePeersBitrate(session);
    }
  };

  // ── 屏幕共享：为指定观看者创建 WebRTC Offer 并推流（共享端） ──
  const createOfferForViewer = async (viewerId, forceRelay = false) => {
    const session = shareSessionRef.current;
    if (!session || !viewerId) return;
    removeViewerPeer(viewerId);

    const rtcCfg = await fetchRtcIceConfig(wsBase, forceRelay);
    if (shareSessionRef.current !== session || session.stopped) return;

    const useRelayOnly = Boolean(forceRelay && rtcCfg.hasTurn);
    const pc = new RTCPeerConnection({
      iceServers: rtcCfg.iceServers,
      iceTransportPolicy: useRelayOnly ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
      iceCandidatePoolSize: 2,
    });
    const entry = { pc, pendingIce: [], videoSender: null, disconnectTimer: null };
    session.peers.set(viewerId, entry);

    const sharedStream = session.outboundStream || session.displayStream;

    if (session.videoTrack) {
      const videoSender = pc.addTrack(session.videoTrack, sharedStream);
      entry.videoSender = videoSender;
      // 优先使用硬件 H.264 编码，降低与腾讯会议并行全屏共享时的 CPU/GPU 争抢
      preferHardwareVideoCodec(pc, videoSender);
      rebalanceSharePeersBitrate(session);
    }
    if (session.audioTrack) {
      const audioSender = pc.addTrack(session.audioTrack, sharedStream);
      try {
        const params = audioSender.getParameters() || {};
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = 96_000;
        params.encodings[0].priority = 'high';
        params.encodings[0].networkPriority = 'high';
        audioSender.setParameters(params).catch(() => {});
      } catch {}
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate && wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({
          type: 'RTC_SIGNAL',
          payload: { to: viewerId, candidate: ev.candidate.toJSON() },
        }));
      }
    };

    const schedulePeerDisconnectCleanup = () => {
      if (entry.disconnectTimer) return;
      // 遇到网络瞬断(disconnected)不再秒杀连接！给予 6 秒自愈宽限期，若未自动恢复则清理释放资源（观看端会拉起重连）
      entry.disconnectTimer = setTimeout(() => {
        entry.disconnectTimer = null;
        if (session.peers.get(viewerId) !== entry) return;
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
          removeViewerPeer(viewerId);
        }
      }, 6000);
    };

    const clearPeerDisconnectCleanup = () => {
      if (entry.disconnectTimer) {
        clearTimeout(entry.disconnectTimer);
        entry.disconnectTimer = null;
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        clearPeerDisconnectCleanup();
      } else if (pc.iceConnectionState === 'disconnected') {
        schedulePeerDisconnectCleanup();
      } else if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
        removeViewerPeer(viewerId);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        clearPeerDisconnectCleanup();
      } else if (pc.connectionState === 'disconnected') {
        schedulePeerDisconnectCleanup();
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        removeViewerPeer(viewerId);
      }
    };

    try {
      const offer = await pc.createOffer();
      const tunedOffer = {
        type: offer.type,
        sdp: enhanceOpusSdp(offer.sdp, { stereo: Boolean(session.sysAudioTrack), maxAverageBitrate: 96000 }),
      };
      await pc.setLocalDescription(tunedOffer);
      if (wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({
          type: 'RTC_SIGNAL',
          payload: { to: viewerId, sdp: pc.localDescription },
        }));
      }
    } catch (err) {
      console.error('[screenshare] createOffer error:', err);
      removeViewerPeer(viewerId);
    }
  };

  // ── 屏幕共享：停止本地共享（客户端） ──
  const stopScreenShare = (notifyServer = true) => {
    const session = shareSessionRef.current;
    if (session) {
      session.stopped = true;
      if (session.duckTimer) {
        clearInterval(session.duckTimer);
        session.duckTimer = null;
      }
      session.peers.forEach((entry) => {
        if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
        entry.pc.onicecandidate = null;
        entry.pc.onconnectionstatechange = null;
        entry.pc.oniceconnectionstatechange = null;
        try { entry.pc.close(); } catch {}
      });
      session.peers.clear();
      session.displayStream?.getTracks().forEach((t) => t.stop());
      session.micStream?.getTracks().forEach((t) => t.stop());
      session.sysAudioStream?.getTracks().forEach((t) => t.stop());
      session.nativeSckCleanup?.();
      session.audioCtx?.close().catch(() => {});
      shareSessionRef.current = null;
    }
    setIsSharingScreen(false);
    setShareMicOn(false);
    setShareHasMic(false);
    setShareSystemAudio(false);
    setShareMicError('');
    setSpeakerTipDismissed(false);
    setAudioSetupMsg('');
    setShowAudioGuide(false);
    // 停止共享时恢复物理扬声器为系统默认输出设备（让 Mac 键盘音量加减键立即恢复正常控制）并释放系统防休眠锁
    speakerDuckedRef.current = false;
    window.electronAPI?.setPowerKeepAwake?.(false).catch?.(() => {});
    window.electronAPI?.restoreAudioOutput?.().catch?.(() => {});
    if (notifyServer && wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: 'SCREEN_SHARE_STOP' }));
    }
  };

  // ── 屏幕共享：启动本地静默共享（主屏画面 + 系统声音 + 麦克风） ──
  const startScreenShare = async () => {
    if (shareSessionRef.current) return;
    setShareError('');
    setShareMicError('');

    try {
      // 0. 读取平台能力：Electron 的 loopback 系统内录目前仅 Windows 支持，macOS 只有麦克风可选
      let caps = { platform: 'web', systemAudioSupported: false, screen: 'granted', microphone: 'granted' };
      if (window.electronAPI?.getScreenShareCaps) {
        caps = await window.electronAPI.getScreenShareCaps();
      }

      // 1. 直接调用 getDisplayMedia 触发系统底层 desktopCapturer.getSources：
      //    限制最大 1920x1080 @ 24fps，与腾讯会议全屏共享并行时显著降低 GPU/CPU 抢占与排队延迟；
      //    Windows 请求系统内录（关闭回声消除/降噪/自动增益），macOS 不请求音频（loopback 不支持）
      let displayStream;
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: 1920, max: 1920 },
            height: { ideal: 1080, max: 1080 },
            frameRate: { ideal: 24, max: 24 },
          },
          audio: caps.systemAudioSupported
            ? {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: 2,
                sampleRate: 48000,
              }
            : false,
        });
      } catch (captureErr) {
        if (caps.screen && caps.screen !== 'granted') {
          setShareError('请在系统「屏幕与系统音频」中勾选 GlassPad（或点左下角 + 号添加）后重试');
          window.electronAPI.openPrivacySettings?.('screen');
          return;
        }
        throw captureErr;
      }

      // 0.5 macOS 优先尝试腾讯会议同款 ScreenCaptureKit 原生系统音频内录（零驱动、不改系统输出设备、键盘音量键正常、自动排除自身进程声音）
      let blackholeInstalled = false;
      let nativeSckCleanup = null;
      let isNativeSckAudio = false;
      let sysAudioStream = null;
      let micStream = null;
      let micError = '';

      if (caps.platform === 'darwin') {
        try {
          const sckHandle = await createNativeSCKAudioStream();
          if (sckHandle?.stream) {
            sysAudioStream = sckHandle.stream;
            nativeSckCleanup = sckHandle.cleanup;
            isNativeSckAudio = Boolean(sckHandle.isNativeSck);
          }
        } catch {}

        if (window.electronAPI?.getAudioSetupStatus) {
          try {
            const st = await window.electronAPI.getAudioSetupStatus();
            blackholeInstalled = Boolean(st?.blackholeInstalled);
            setAudioSetup({ supported: Boolean(st?.supported), blackholeInstalled: blackholeInstalled || Boolean(sysAudioStream), configured: Boolean(sysAudioStream) });
            // 仅当 ScreenCaptureKit 原生流未就绪且装了 BlackHole 时，才挂载 BlackHole 多输出设备
            if (!sysAudioStream && blackholeInstalled && window.electronAPI?.runAudioSetup) {
              try {
                const setupRes = await window.electronAPI.runAudioSetup();
                if (typeof setupRes?.volume === 'number') setSpeakerVolume(setupRes.volume);
              } catch {}
            } else if (window.electronAPI?.getSpeakerVolume) {
              try {
                const vol = await window.electronAPI.getSpeakerVolume();
                if (typeof vol?.volume === 'number') setSpeakerVolume(vol.volume);
              } catch {}
            }
          } catch {}
        }
      }

      // 2. 采集音频：系统音（Windows loopback / macOS ScreenCaptureKit 或 BlackHole）+ 物理麦克风
      if (caps.platform === 'darwin' && (sysAudioStream || blackholeInstalled)) {
        const srcs = await getMacAudioSources();
        if (!sysAudioStream && srcs.blackholeId) {
          try {
            sysAudioStream = await navigator.mediaDevices.getUserMedia({
              audio: {
                deviceId: { exact: srcs.blackholeId },
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: 2,
                sampleRate: 48000,
              },
            });
          } catch {}
        }
        if (srcs.micId) {
          try {
            micStream = await navigator.mediaDevices.getUserMedia({
              audio: {
                deviceId: { exact: srcs.micId },
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 48000,
                latency: 0.01,
              },
            });
          } catch {}
        }
        if (!sysAudioStream && !micStream) {
          micError = '未检测到可用音频设备（系统音或麦克风）';
        }
      } else if (caps.microphone === 'denied' || caps.microphone === 'restricted') {
        micError = '麦克风权限未开启，点此到系统设置允许 GlassPad 使用麦克风';
      } else {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              // Windows：系统音走 loopback，麦克风只负责清晰人声，开 AEC/降噪避免拾到扬声器外放造成重复与回声
              // macOS 未装 BlackHole：关掉 AEC/降噪，让麦克风忠实拾取「扬声器外放的系统音 + 人声」（开外放即可被导师听到）
              echoCancellation: caps.systemAudioSupported,
              noiseSuppression: caps.systemAudioSupported,
              autoGainControl: true,
              sampleRate: 48000,
              latency: 0.01,
            },
          });
        } catch {
          micError = '未检测到可用麦克风（无设备或未授权），导师将听不到你的声音';
        }
      }

      const videoTrack = displayStream.getVideoTracks()[0] || null;
      if (videoTrack) {
        // 明确告知编码器当前是代码/文字屏幕内容，优先保证文字清晰锐利
        try {
          if ('contentHint' in videoTrack) videoTrack.contentHint = 'detail';
        } catch {}
      }
      // 系统音：Windows 来自 displayStream 的 loopback；macOS 来自 BlackHole 独立流
      const sysAudioTrack = (caps.platform === 'darwin'
        ? sysAudioStream?.getAudioTracks()[0]
        : displayStream.getAudioTracks()[0]) || null;
      const micAudioTrack = micStream?.getAudioTracks()[0] || null;
      const hasSystemAudio = Boolean(sysAudioTrack);

      // 初始麦克风状态：有系统音时默认关麦（隐私）；没有系统音（macOS）时默认开麦，保证导师至少能听到声音
      const initialMicOn = !hasSystemAudio && Boolean(micAudioTrack);
      if (micAudioTrack) {
        micAudioTrack.enabled = initialMicOn;
      }

      // 3. WebAudio 专业混音管线：
      //    - 防导师开麦回环（Windows loopback / Mac BlackHole）：实时监听导师语音播放电平，导师讲话时立即压低系统音回传(0.03)并保持物理麦克风可用，彻底消除导师听到自己回声/啸叫；
      //    - 自适应双讲检测 (DTD) + 双向动态增益：纯系统音时抑制外放重音，边放音乐边说话时立即放开麦克风并适度压低系统音；
      //    - 麦克风 85Hz 高通滤波器：切掉风扇/空调/桌面低频嗡嗡底噪；
      //    - 混音总输出串联 DynamicsCompressorNode 软限幅器：双讲叠加峰值绝不硬削波破音。
      let audioCtx = null;
      let mixedAudioTrack = null;
      let micGainNode = null;
      let duckTimer = null;
      if (sysAudioTrack || micAudioTrack) {
        try {
          // 强制 interactive 极低延迟缓冲 + 48000Hz 对齐 WebRTC Opus 原生采样率，消除重采样延迟
          audioCtx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
          await audioCtx.resume();
          const dest = audioCtx.createMediaStreamDestination();

          // 总输出软限幅器：防止系统音与人声双讲叠加超过 0dBFS 硬削波破音
          const limiter = audioCtx.createDynamicsCompressor();
          limiter.threshold.value = -3;
          limiter.knee.value = 6;
          limiter.ratio.value = 12;
          limiter.attack.value = 0.003;
          limiter.release.value = 0.08;
          limiter.connect(dest);

          let sysAnalyser = null;
          let sysGainNode = null;
          if (sysAudioTrack) {
            const sysSource = audioCtx.createMediaStreamSource(new MediaStream([sysAudioTrack]));
            sysAnalyser = audioCtx.createAnalyser();
            sysAnalyser.fftSize = 512;
            sysGainNode = audioCtx.createGain();
            sysGainNode.gain.value = 1.0;
            sysSource.connect(sysAnalyser);
            sysSource.connect(sysGainNode);
            sysGainNode.connect(limiter);
          }

          let micAnalyser = null;
          if (micAudioTrack) {
            const micSource = audioCtx.createMediaStreamSource(new MediaStream([micAudioTrack]));
            // 85Hz 高通滤波器：过滤电脑风扇、空调与桌面共振低频嗡嗡底噪，保留清晰人声频段
            const micHighPass = audioCtx.createBiquadFilter();
            micHighPass.type = 'highpass';
            micHighPass.frequency.value = 85;
            micHighPass.Q.value = 0.7;

            micAnalyser = audioCtx.createAnalyser();
            micAnalyser.fftSize = 512;
            micGainNode = audioCtx.createGain();
            micGainNode.gain.value = initialMicOn ? 1.0 : 0.0;
            micSource.connect(micHighPass);
            micHighPass.connect(micAnalyser);
            micHighPass.connect(micGainNode);
            micGainNode.connect(limiter);
          }

          const sysPcm = sysAnalyser ? new Uint8Array(sysAnalyser.fftSize) : null;
          const micPcm = micAnalyser ? new Uint8Array(micAnalyser.fftSize) : null;
          const calcRms = (arr) => {
            let s = 0;
            for (let i = 0; i < arr.length; i++) {
              const v = (arr[i] - 128) / 128;
              s += v * v;
            }
            return Math.sqrt(s / arr.length);
          };

          // Windows WASAPI loopback 与 Mac BlackHole 会把客户端自己播放的导师声音录回去，需要软件防回环门控；
          // Mac ScreenCaptureKit 已设 excludesCurrentProcessAudio=true，硬件级排除自身进程，无需压低系统音
          const needsMentorLoopbackGuard = Boolean(sysGainNode && !isNativeSckAudio);

          let sysHoldFrames = 0;
          let speechHoldFrames = 0;
          let mentorHoldFrames = 0;
          let leakRatio = 0.16; // 扬声器到麦克风的声学漏音比例估计值

          duckTimer = setInterval(() => {
            if (!audioCtx || audioCtx.state === 'closed') return;

            // 统计客户端当前正在播放的导师语音实时电平（任一正在收听的导师音频轨道）
            let mentorRms = 0;
            if (!mentorVoiceMutedRef.current && voiceListenerPcsRef.current.size > 0) {
              voiceListenerPcsRef.current.forEach((entry) => {
                if (entry.analyser && entry.pcm) {
                  entry.analyser.getByteTimeDomainData(entry.pcm);
                  const r = calcRms(entry.pcm);
                  if (r > mentorRms) mentorRms = r;
                }
              });
            }
            mentorVoiceRmsRef.current = mentorRms;
            if (mentorRms > 0.008) {
              mentorHoldFrames = 8; // 240ms 防回环拖尾窗口，覆盖 BlackHole/WASAPI 缓冲延迟
            } else if (mentorHoldFrames > 0) {
              mentorHoldFrames -= 1;
            }
            const mentorSpeakingNow = mentorHoldFrames > 0;

            let sysRms = 0;
            if (sysAnalyser && sysPcm) {
              sysAnalyser.getByteTimeDomainData(sysPcm);
              sysRms = calcRms(sysPcm);
            }
            let micRms = 0;
            if (micAnalyser && micPcm) {
              micAnalyser.getByteTimeDomainData(micPcm);
              micRms = calcRms(micPcm);
            }

            if (sysRms > 0.008) {
              sysHoldFrames = 4; // 120ms 系统音活跃窗口
            } else if (sysHoldFrames > 0) {
              sysHoldFrames -= 1;
            }

            let targetMicGain = micAudioTrack?.enabled ? 1.0 : 0.0;
            let targetSysGain = 1.0;

            if (sysGainNode && micGainNode && micAudioTrack?.enabled) {
              // 双讲判定：候选人近讲人声能量明显超过扬声器外放漏音（绝对门限 0.016 + 相对漏音比 1.85 倍）
              const echoCeiling = sysRms * Math.max(0.28, leakRatio * 1.85);
              const isUserSpeaking = micRms > 0.016 && micRms > echoCeiling;

              if (isUserSpeaking) {
                speechHoldFrames = 9; // 保持约 270ms 人声拖尾，防止句尾被截断
              } else if (speechHoldFrames > 0) {
                speechHoldFrames -= 1;
              } else if (sysRms > 0.015 && micRms > 0.001 && !mentorSpeakingNow) {
                // 未说话且系统音稳定时，慢速自适应更新扬声器外放漏音比（限制在 0.05 ~ 0.35 之间）
                const instRatio = Math.min(0.35, Math.max(0.05, micRms / sysRms));
                leakRatio = leakRatio * 0.9 + instRatio * 0.1;
              }

              if (sysHoldFrames > 0) {
                if (speechHoldFrames > 0) {
                  // 边放声音边说话（Double-Talk）：全开麦克风，并适度压低系统背景音使人声清晰可辨
                  targetMicGain = 1.0;
                  targetSysGain = 0.55;
                } else {
                  // 仅系统音播放、候选人未说话：抑制麦克风回拾，消除双重重音
                  targetMicGain = 0.06;
                  targetSysGain = 1.0;
                }
              }
            }

            // Windows / BlackHole 模式下：导师正在开麦讲话时，立即将系统音回传增益压至 0.02（约 -34dB），
            // 防止导师声音经由 loopback / BlackHole 倒灌回传形成大回声或啸叫；若候选人开着麦且没说话，也压低麦克风防外放回拾
            if (needsMentorLoopbackGuard && mentorSpeakingNow) {
              targetSysGain = 0.02;
              if (micGainNode && micAudioTrack?.enabled && speechHoldFrames === 0) {
                targetMicGain = 0.04;
              }
            }

            if (micGainNode) {
              micGainNode.gain.setTargetAtTime(targetMicGain, audioCtx.currentTime, targetMicGain >= 1.0 ? 0.008 : 0.02);
            }
            if (sysGainNode) {
              sysGainNode.gain.setTargetAtTime(targetSysGain, audioCtx.currentTime, targetSysGain < 0.1 ? 0.008 : 0.035);
            }
          }, 30);

          mixedAudioTrack = dest.stream.getAudioTracks()[0] || null;
        } catch {
          // 混音失败时退化为单轨直出
          mixedAudioTrack = sysAudioTrack || micAudioTrack || null;
        }
      } else {
        mixedAudioTrack = null;
      }
      // 只有纯麦克风时设 speech；带系统音时保留默认全频带（不强降成窄带语音，让音乐/视频与人声都饱满）
      if (mixedAudioTrack && !sysAudioTrack && 'contentHint' in mixedAudioTrack) {
        try { mixedAudioTrack.contentHint = 'speech'; } catch {}
      }

      const outboundStream = new MediaStream();
      if (videoTrack) outboundStream.addTrack(videoTrack);
      if (mixedAudioTrack) outboundStream.addTrack(mixedAudioTrack);

      const session = {
        stopped: false,
        displayStream,
        micStream,
        sysAudioStream,
        nativeSckCleanup,
        outboundStream,
        audioCtx,
        micGainNode,
        duckTimer,
        micTrack: micAudioTrack,
        sysAudioTrack,
        videoTrack,
        audioTrack: mixedAudioTrack,
        peers: new Map(),
      };
      shareSessionRef.current = session;
      // 共享期间请求主进程锁定防系统休眠/防进程挂起，避免窗口隐身或后台切走后音画被 OS 节流
      window.electronAPI?.setPowerKeepAwake?.(true).catch?.(() => {});

      if (videoTrack) {
        videoTrack.addEventListener('ended', () => {
          if (!session.stopped) stopScreenShare(true);
        });
      }

      setIsSharingScreen(true);
      setShareMicOn(initialMicOn);
      setShareHasMic(Boolean(micAudioTrack));
      setShareSystemAudio(hasSystemAudio);
      setShareMicError(micError);

      if (wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({
          type: 'SCREEN_SHARE_START',
          payload: { micOn: initialMicOn, systemAudio: hasSystemAudio },
        }));
      }
    } catch (err) {
      console.error('[screenshare] start failed:', err);
      setShareError('共享屏幕启动失败');
      stopScreenShare(false);
    }
  };

  // ── 屏幕共享：切换候选人麦克风开关 ──
  const toggleShareMic = () => {
    const session = shareSessionRef.current;
    if (!session?.micTrack) return;
    const next = !shareMicOn;
    session.micTrack.enabled = next;
    if (session.micGainNode && session.audioCtx && session.audioCtx.state !== 'closed') {
      session.micGainNode.gain.setTargetAtTime(next ? 1.0 : 0.0, session.audioCtx.currentTime, 0.015);
    }
    setShareMicOn(next);
    // 开麦时若用户设定的本机音量偏大（>28%），自动限制在 28% 降低声学回拾；若用户已手动调得更低（<=28%）则尊重用户设定
    if (shareSystemAudio && audioSetup.blackholeInstalled && window.electronAPI?.setSpeakerVolume) {
      if (next) {
        speakerDuckedRef.current = true;
        window.electronAPI.setSpeakerVolume(Math.min(speakerVolume, 28));
      } else {
        speakerDuckedRef.current = false;
        window.electronAPI.setSpeakerVolume(speakerVolume);
      }
    }
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({
        type: 'SCREEN_SHARE_MIC',
        payload: { micOn: next },
      }));
    }
  };

  // ── 屏幕共享：macOS BlackHole 系统音配置 ──
  const handleRecheckAudioSetup = async () => {
    setAudioSetupBusy(true);
    setAudioSetupMsg('');
    try {
      const st = await window.electronAPI.getAudioSetupStatus();
      const installed = Boolean(st?.blackholeInstalled);
      setAudioSetup({ supported: Boolean(st?.supported), blackholeInstalled: installed, configured: false });
      setAudioSetupMsg(installed ? '' : '仍未检测到 BlackHole，请确认安装完成后重试');
    } catch {
      setAudioSetupMsg('检测失败，请重试');
    } finally {
      setAudioSetupBusy(false);
    }
  };

  const handleRunAudioSetup = async () => {
    setAudioSetupBusy(true);
    setAudioSetupMsg('');
    try {
      const res = await window.electronAPI.runAudioSetup();
      if (res?.ok) {
        if (typeof res.volume === 'number') setSpeakerVolume(res.volume);
        setAudioSetupMsg('系统音已配置，电脑播放的声音将无损传给导师');
      } else {
        setAudioSetupMsg(res?.error || '配置失败，请重试');
      }
    } catch {
      setAudioSetupMsg('配置失败，请重试');
    } finally {
      setAudioSetupBusy(false);
    }
  };

  // ── 屏幕共享：处理收到的 WebRTC 信令（Offer / Answer / ICE） ──
  const handleRtcSignal = async ({ from, sdp, candidate }) => {
    if (!from) return;

    // A. 如果本地是共享端：收到观看端的 Answer 或 ICE
    if (shareSessionRef.current) {
      const entry = shareSessionRef.current.peers.get(from);
      if (!entry) return;
      try {
        if (sdp && sdp.type === 'answer') {
          await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
          while (entry.pendingIce.length > 0) {
            const c = entry.pendingIce.shift();
            await entry.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
          }
        } else if (candidate) {
          if (entry.pc.remoteDescription) {
            await entry.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
          } else {
            entry.pendingIce.push(candidate);
          }
        }
      } catch (err) {
        console.error('[screenshare] sharer signal error:', err);
      }
      return;
    }

    // B. 如果本地是观看端（导师端）：收到共享端的 Offer 或 ICE
    try {
      if (sdp && sdp.type === 'offer') {
        closeViewerConnection();
        // 先占位 earlyViewerIceRef，避免 await fetchRtcIceConfig 期间到达的 ICE 候选全部被丢弃！
        if (!earlyViewerIceRef.current.has(from)) {
          earlyViewerIceRef.current.set(from, []);
        }
        const wantRelay = Boolean(viewerForceRelay);
        setViewerConnMode(wantRelay ? 'TURN 强制中继连接中…' : '正在穿透网络…');

        const rtcCfg = await fetchRtcIceConfig(wsBase, wantRelay);
        const useRelayOnly = Boolean(wantRelay && rtcCfg.hasTurn);
        const pc = new RTCPeerConnection({
          iceServers: rtcCfg.iceServers,
          iceTransportPolicy: useRelayOnly ? 'relay' : 'all',
          bundlePolicy: 'max-bundle',
          iceCandidatePoolSize: 2,
        });
        const remoteStream = new MediaStream();
        const earlyQueued = earlyViewerIceRef.current.get(from) || [];
        earlyViewerIceRef.current.delete(from);
        const viewerState = {
          pc,
          sharerId: from,
          pendingIce: [...earlyQueued],
          stream: remoteStream,
          reconnectTimer: null,
          frameWatchTimer: null,
          disconnectTimer: null,
          stallTimer: null,
          lastBytesReceived: -1,
          stallStrikes: 0,
          forceRelay: useRelayOnly,
        };
        viewerPcRef.current = viewerState;

        const detectConnMode = async () => {
          try {
            const stats = await pc.getStats();
            let selectedPair = null;
            stats.forEach((r) => {
              if (r.type === 'transport' && r.selectedCandidatePairId) {
                selectedPair = stats.get(r.selectedCandidatePairId);
              }
            });
            if (!selectedPair) {
              stats.forEach((r) => {
                if (r.type === 'candidate-pair' && (r.nominated || r.state === 'succeeded')) {
                  selectedPair = r;
                }
              });
            }
            if (selectedPair) {
              const local = stats.get(selectedPair.localCandidateId);
              const remote = stats.get(selectedPair.remoteCandidateId);
              const isRelay = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
              setViewerConnMode(isRelay ? 'TURN 中继' : 'P2P 直连');
            }
          } catch {}
        };

        const requestJoinWithRelay = (relayFlag) => {
          if (wsRef.current?.readyState === 1) {
            wsRef.current.send(JSON.stringify({
              type: 'SCREEN_VIEWER_JOIN',
              payload: { forceRelay: Boolean(relayFlag) },
            }));
          }
        };

        // 看门狗：8 秒内如果还没真正解码出视频帧（videoWidth === 0），自动升级为「强制 TURN 中继 (TLS 443)」重连！
        // 彻底解决跨区/台湾代理节点下 ICE 卡在 checking 或 P2P 假连通但黑屏的问题
        viewerState.frameWatchTimer = setTimeout(() => {
          if (viewerPcRef.current !== viewerState) return;
          const v = remoteVideoRef.current;
          const hasDecodedFrame = Boolean(v && v.videoWidth > 0 && v.videoHeight > 0);
          if (hasDecodedFrame) return;
          if (!viewerState.forceRelay && rtcCfg.hasTurn) {
            setViewerForceRelay(true);
            setViewerConnMode('P2P 超时，自动切换 TURN 中继…');
            requestJoinWithRelay(true);
          } else {
            setViewerConnMode('未收到画面，正在重试 TURN 中继…');
            requestJoinWithRelay(true);
          }
        }, 8000);

        const tryPlayVideo = () => {
          const v = remoteVideoRef.current;
          if (!v) return;
          v.srcObject = remoteStream;
          v.play().catch(() => {
            // 浏览器阻止带声音自动播放时，先自动静音确保画面能秒出（用户可点顶栏取消静音）
            v.muted = true;
            setViewerMuted(true);
            v.play().catch(() => {});
          });
        };

        pc.ontrack = (ev) => {
          // 观看端压低 WebRTC JitterBuffer 延迟（目标 50ms），保持音画实时紧跟
          try {
            if (ev.receiver && 'playoutDelayHint' in ev.receiver) {
              ev.receiver.playoutDelayHint = 0.05;
            }
          } catch {}
          if (ev.streams && ev.streams[0]) {
            ev.streams[0].getTracks().forEach((t) => {
              if (!remoteStream.getTrackById(t.id)) remoteStream.addTrack(t);
            });
          } else if (ev.track && !remoteStream.getTrackById(ev.track.id)) {
            remoteStream.addTrack(ev.track);
          }
          // 注意：不再在 ontrack 时立刻把 viewerConnected 设为 true（ontrack 只是 SDP 解析出轨道，此时 ICE 还没连上，画出来是黑屏！）
          // 真正等到 ICE connected/completed 或 <video> onloadeddata 解码出首帧时才亮绿灯
          tryPlayVideo();
        };

        pc.onicecandidate = (ev) => {
          if (ev.candidate && wsRef.current?.readyState === 1) {
            wsRef.current.send(JSON.stringify({
              type: 'RTC_SIGNAL',
              payload: { to: from, candidate: ev.candidate.toJSON() },
            }));
          }
        };

        const scheduleViewerReconnect = (escalateToRelay = false) => {
          if (viewerPcRef.current !== viewerState) return;
          if (viewerState.reconnectTimer) return;
          viewerState.reconnectTimer = setTimeout(() => {
            viewerState.reconnectTimer = null;
            if (viewerPcRef.current === viewerState) {
              const nextRelay = Boolean(escalateToRelay || viewerState.forceRelay);
              if (nextRelay) setViewerForceRelay(true);
              requestJoinWithRelay(nextRelay);
            }
          }, 2200);
        };

        const clearViewerDisconnectTimer = () => {
          if (viewerState.disconnectTimer) {
            clearTimeout(viewerState.disconnectTimer);
            viewerState.disconnectTimer = null;
          }
        };

        const scheduleViewerDisconnectRecovery = () => {
          if (viewerPcRef.current !== viewerState || viewerState.disconnectTimer) return;
          setViewerConnMode('网络波动，等待自动恢复…');
          // 给予 3.5 秒自然恢复宽限期，若未回连则自动重建（有 TURN 时直接升中继，避免反复卡 P2P）
          viewerState.disconnectTimer = setTimeout(() => {
            viewerState.disconnectTimer = null;
            if (viewerPcRef.current !== viewerState) return;
            if (pc.connectionState !== 'connected' && pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') {
              setViewerConnected(false);
              setViewerConnMode(rtcCfg.hasTurn ? '网络瞬断，自动切换 TURN 中继恢复中…' : '网络瞬断，自动重连中…');
              scheduleViewerReconnect(rtcCfg.hasTurn);
            }
          }, 3500);
        };

        // 运行时防「假连通定格」看门狗：每 6 秒检查入站总字节（音+视）是否持续增长，
        // 连续 3 次（18 秒）零字节新增说明底层 UDP 路径已僵死（跨区代理长时间挂机常见），自动静默切换 TURN 重建
        viewerState.stallTimer = setInterval(async () => {
          if (viewerPcRef.current !== viewerState) return;
          if (pc.connectionState !== 'connected' && pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') return;
          try {
            const stats = await pc.getStats();
            let totalBytes = 0;
            stats.forEach((r) => {
              if (r.type === 'inbound-rtp' && typeof r.bytesReceived === 'number') {
                totalBytes += r.bytesReceived;
              }
            });
            if (viewerState.lastBytesReceived >= 0 && totalBytes <= viewerState.lastBytesReceived) {
              viewerState.stallStrikes += 1;
              if (viewerState.stallStrikes >= 3) {
                viewerState.stallStrikes = 0;
                setViewerConnMode('检测到画面流停滞，正在自动重建连接…');
                requestJoinWithRelay(rtcCfg.hasTurn ? true : viewerState.forceRelay);
              }
            } else {
              viewerState.stallStrikes = 0;
            }
            viewerState.lastBytesReceived = totalBytes;
          } catch {}
        }, 6000);

        pc.oniceconnectionstatechange = () => {
          if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            clearViewerDisconnectTimer();
            setViewerConnected(true);
            detectConnMode();
            tryPlayVideo();
          } else if (pc.iceConnectionState === 'checking') {
            setViewerConnMode(useRelayOnly ? 'TURN 中继握手中…' : '正在穿透网络…');
          } else if (pc.iceConnectionState === 'disconnected') {
            scheduleViewerDisconnectRecovery();
          } else if (pc.iceConnectionState === 'failed') {
            clearViewerDisconnectTimer();
            setViewerConnected(false);
            setViewerConnMode(rtcCfg.hasTurn ? '切换 TURN 中继重连中…' : 'NAT 穿透失败（需配置 TURN 中继）');
            scheduleViewerReconnect(rtcCfg.hasTurn);
          }
        };

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'connected') {
            clearViewerDisconnectTimer();
            setViewerConnected(true);
            detectConnMode();
            tryPlayVideo();
          } else if (pc.connectionState === 'disconnected') {
            scheduleViewerDisconnectRecovery();
          } else if (pc.connectionState === 'failed') {
            clearViewerDisconnectTimer();
            setViewerConnected(false);
            setViewerConnMode(rtcCfg.hasTurn ? '切换 TURN 中继重连中…' : 'NAT 穿透失败（需配置 TURN 中继）');
            scheduleViewerReconnect(rtcCfg.hasTurn);
          } else if (pc.connectionState === 'closed') {
            clearViewerDisconnectTimer();
            setViewerConnected(false);
          }
        };

        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        // 把 offer 期间以及 await 期间提前到达的所有 ICE 候选一次性补进去
        const extraEarly = earlyViewerIceRef.current.get(from) || [];
        earlyViewerIceRef.current.delete(from);
        const allPending = [...viewerState.pendingIce, ...extraEarly];
        viewerState.pendingIce = [];
        for (const c of allPending) {
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        }
        const answer = await pc.createAnswer();
        const tunedAnswer = {
          type: answer.type,
          sdp: enhanceOpusSdp(answer.sdp, { stereo: true, maxAverageBitrate: 96000 }),
        };
        await pc.setLocalDescription(tunedAnswer);
        if (wsRef.current?.readyState === 1) {
          wsRef.current.send(JSON.stringify({
            type: 'RTC_SIGNAL',
            payload: { to: from, sdp: pc.localDescription },
          }));
        }
      } else if (candidate) {
        const vState = viewerPcRef.current;
        if (vState && vState.sharerId === from) {
          if (vState.pc.remoteDescription) {
            await vState.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
          } else {
            vState.pendingIce.push(candidate);
          }
        } else {
          // viewerPcRef 还在 await fetchRtcIceConfig 尚未创建完成：先暂存，绝不丢弃！
          const q = earlyViewerIceRef.current.get(from) || [];
          q.push(candidate);
          earlyViewerIceRef.current.set(from, q);
        }
      }
    } catch (err) {
      console.error('[screenshare] viewer signal error:', err);
    }
  };

  // ── 导师开麦独立语音通道（WebRTC，走同一 Cloudflare TURN 中继，支持跨区/代理穿透） ──
  const removeVoiceListenerPeer = (listenerId) => {
    const sess = mentorVoiceSessionRef.current;
    if (!sess) return;
    const entry = sess.peers.get(listenerId);
    if (entry) {
      if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
      entry.pc.onicecandidate = null;
      entry.pc.onconnectionstatechange = null;
      entry.pc.oniceconnectionstatechange = null;
      try { entry.pc.close(); } catch {}
      sess.peers.delete(listenerId);
    }
  };

  const stopMentorMic = (notifyServer = true) => {
    const sess = mentorVoiceSessionRef.current;
    if (sess) {
      sess.stopped = true;
      sess.peers.forEach((entry) => {
        if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
        entry.pc.onicecandidate = null;
        entry.pc.onconnectionstatechange = null;
        entry.pc.oniceconnectionstatechange = null;
        try { entry.pc.close(); } catch {}
      });
      sess.peers.clear();
      try { sess.stream?.getTracks?.().forEach((t) => t.stop()); } catch {}
      mentorVoiceSessionRef.current = null;
    }
    setMentorMicOn(false);
    setMentorMicError('');
    if (notifyServer && wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: 'VOICE_STOP' }));
    }
  };

  const createVoiceOfferForListener = async (listenerId, forceRelay = false) => {
    const sess = mentorVoiceSessionRef.current;
    if (!sess || sess.stopped || !listenerId) return;
    removeVoiceListenerPeer(listenerId);

    const rtcCfg = await fetchRtcIceConfig(wsBase, forceRelay);
    if (mentorVoiceSessionRef.current !== sess || sess.stopped) return;

    const useRelayOnly = Boolean(forceRelay && rtcCfg.hasTurn);
    const pc = new RTCPeerConnection({
      iceServers: rtcCfg.iceServers,
      iceTransportPolicy: useRelayOnly ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
      iceCandidatePoolSize: 2,
    });
    const entry = { pc, pendingIce: [], disconnectTimer: null };
    sess.peers.set(listenerId, entry);

    if (sess.audioTrack) {
      const sender = pc.addTrack(sess.audioTrack, sess.stream);
      try {
        const params = sender.getParameters() || {};
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        params.encodings[0].maxBitrate = 64_000;
        params.encodings[0].priority = 'high';
        params.encodings[0].networkPriority = 'high';
        sender.setParameters(params).catch(() => {});
      } catch {}
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate && wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({
          type: 'VOICE_SIGNAL',
          payload: { to: listenerId, candidate: ev.candidate.toJSON() },
        }));
      }
    };

    const scheduleVoicePeerCleanup = () => {
      if (entry.disconnectTimer) return;
      entry.disconnectTimer = setTimeout(() => {
        entry.disconnectTimer = null;
        if (sess.peers.get(listenerId) !== entry) return;
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          removeVoiceListenerPeer(listenerId);
        }
      }, 6000);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        if (entry.disconnectTimer) {
          clearTimeout(entry.disconnectTimer);
          entry.disconnectTimer = null;
        }
      } else if (pc.connectionState === 'disconnected') {
        scheduleVoicePeerCleanup();
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        removeVoiceListenerPeer(listenerId);
      }
    };

    try {
      const offer = await pc.createOffer();
      const tunedOffer = {
        type: offer.type,
        sdp: enhanceOpusSdp(offer.sdp, { stereo: false, maxAverageBitrate: 64000 }),
      };
      await pc.setLocalDescription(tunedOffer);
      if (wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({
          type: 'VOICE_SIGNAL',
          payload: { to: listenerId, sdp: pc.localDescription },
        }));
      }
    } catch {
      removeVoiceListenerPeer(listenerId);
    }
  };

  const startMentorMic = async () => {
    if (mentorVoiceSessionRef.current) return;
    setMentorMicError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
        },
      });
      const audioTrack = stream.getAudioTracks()[0] || null;
      if (!audioTrack) {
        stream.getTracks().forEach((t) => t.stop());
        setMentorMicError('未检测到可用麦克风');
        return;
      }
      if ('contentHint' in audioTrack) {
        try { audioTrack.contentHint = 'speech'; } catch {}
      }
      const sess = { stopped: false, stream, audioTrack, peers: new Map() };
      mentorVoiceSessionRef.current = sess;
      audioTrack.addEventListener('ended', () => {
        if (!sess.stopped) stopMentorMic(true);
      });
      setMentorMicOn(true);
      if (wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({ type: 'VOICE_START' }));
      }
    } catch (err) {
      setMentorMicError(err?.name === 'NotAllowedError' ? '请允许浏览器使用麦克风权限' : '开启麦克风失败');
    }
  };

  const toggleMentorMic = () => {
    if (mentorMicOn) stopMentorMic(true);
    else startMentorMic();
  };

  const closeVoiceListener = (speakerId) => {
    const cur = voiceListenerPcsRef.current.get(speakerId);
    if (!cur) return;
    if (cur.reconnectTimer) clearTimeout(cur.reconnectTimer);
    cur.pc.onicecandidate = null;
    cur.pc.ontrack = null;
    cur.pc.oniceconnectionstatechange = null;
    cur.pc.onconnectionstatechange = null;
    try { cur.pc.close(); } catch {}
    try { cur.meterCtx?.close?.(); } catch {}
    if (cur.audioEl) {
      try {
        cur.audioEl.pause();
        cur.audioEl.srcObject = null;
        cur.audioEl.remove();
      } catch {}
    }
    voiceListenerPcsRef.current.delete(speakerId);
    earlyVoiceIceRef.current.delete(speakerId);
  };

  const closeAllVoiceListeners = () => {
    Array.from(voiceListenerPcsRef.current.keys()).forEach((id) => closeVoiceListener(id));
  };

  const handleVoiceSignal = async ({ from, sdp, candidate }) => {
    if (!from) return;

    // A. 如果本地是开麦发言方（导师端）：接收收听端的 Answer 或 ICE
    if (mentorVoiceSessionRef.current && mentorVoiceSessionRef.current.peers.has(from)) {
      const entry = mentorVoiceSessionRef.current.peers.get(from);
      try {
        if (sdp && sdp.type === 'answer') {
          await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
          while (entry.pendingIce.length > 0) {
            const c = entry.pendingIce.shift();
            await entry.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
          }
        } else if (candidate) {
          if (entry.pc.remoteDescription) {
            await entry.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
          } else {
            entry.pendingIce.push(candidate);
          }
        }
      } catch {}
      return;
    }

    // B. 收听方（客户端 / 同房其他成员）：接收导师发来的语音 Offer 或 ICE
    try {
      if (sdp && sdp.type === 'offer') {
        closeVoiceListener(from);
        if (!earlyVoiceIceRef.current.has(from)) {
          earlyVoiceIceRef.current.set(from, []);
        }
        const rtcCfg = await fetchRtcIceConfig(wsBase);
        const pc = new RTCPeerConnection({
          iceServers: rtcCfg.iceServers,
          bundlePolicy: 'max-bundle',
          iceCandidatePoolSize: 2,
        });
        const remoteStream = new MediaStream();
        const audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        audioEl.muted = Boolean(mentorVoiceMutedRef.current);
        audioEl.style.display = 'none';
        document.body.appendChild(audioEl);

        const earlyQueued = earlyVoiceIceRef.current.get(from) || [];
        earlyVoiceIceRef.current.delete(from);
        const lState = {
          pc,
          audioEl,
          stream: remoteStream,
          pendingIce: [...earlyQueued],
          reconnectTimer: null,
          meterCtx: null,
          analyser: null,
          pcm: null,
        };
        voiceListenerPcsRef.current.set(from, lState);

        pc.ontrack = (ev) => {
          try {
            if (ev.receiver && 'playoutDelayHint' in ev.receiver) ev.receiver.playoutDelayHint = 0.04;
          } catch {}
          if (ev.streams && ev.streams[0]) {
            ev.streams[0].getTracks().forEach((t) => {
              if (!remoteStream.getTrackById(t.id)) remoteStream.addTrack(t);
            });
          } else if (ev.track && !remoteStream.getTrackById(ev.track.id)) {
            remoteStream.addTrack(ev.track);
          }
          audioEl.srcObject = remoteStream;
          audioEl.muted = Boolean(mentorVoiceMutedRef.current);
          audioEl.play().catch(() => {});

          // 为导师语音流挂载实时电平分析器（不接 destination 避免双重播放），供客户端 Windows/BlackHole 防回环门控实时检测
          if (!lState.analyser && remoteStream.getAudioTracks().length > 0) {
            try {
              const mCtx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
              mCtx.resume().catch(() => {});
              const src = mCtx.createMediaStreamSource(remoteStream);
              const an = mCtx.createAnalyser();
              an.fftSize = 512;
              src.connect(an);
              lState.meterCtx = mCtx;
              lState.analyser = an;
              lState.pcm = new Uint8Array(an.fftSize);
            } catch {}
          }
        };

        pc.onicecandidate = (ev) => {
          if (ev.candidate && wsRef.current?.readyState === 1) {
            wsRef.current.send(JSON.stringify({
              type: 'VOICE_SIGNAL',
              payload: { to: from, candidate: ev.candidate.toJSON() },
            }));
          }
        };

        const scheduleVoiceRetry = () => {
          if (voiceListenerPcsRef.current.get(from) !== lState || lState.reconnectTimer) return;
          lState.reconnectTimer = setTimeout(() => {
            lState.reconnectTimer = null;
            if (voiceListenerPcsRef.current.get(from) === lState && wsRef.current?.readyState === 1) {
              wsRef.current.send(JSON.stringify({
                type: 'VOICE_LISTENER_JOIN',
                payload: { speakerId: from, forceRelay: rtcCfg.hasTurn },
              }));
            }
          }, 2500);
        };

        pc.oniceconnectionstatechange = () => {
          if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') scheduleVoiceRetry();
        };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') scheduleVoiceRetry();
        };

        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const extraEarly = earlyVoiceIceRef.current.get(from) || [];
        earlyVoiceIceRef.current.delete(from);
        const allPending = [...lState.pendingIce, ...extraEarly];
        lState.pendingIce = [];
        for (const c of allPending) {
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        }
        const answer = await pc.createAnswer();
        const tunedAnswer = {
          type: answer.type,
          sdp: enhanceOpusSdp(answer.sdp, { stereo: false, maxAverageBitrate: 64000 }),
        };
        await pc.setLocalDescription(tunedAnswer);
        if (wsRef.current?.readyState === 1) {
          wsRef.current.send(JSON.stringify({
            type: 'VOICE_SIGNAL',
            payload: { to: from, sdp: pc.localDescription },
          }));
        }
      } else if (candidate) {
        const lState = voiceListenerPcsRef.current.get(from);
        if (lState) {
          if (lState.pc.remoteDescription) {
            await lState.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
          } else {
            lState.pendingIce.push(candidate);
          }
        } else {
          const q = earlyVoiceIceRef.current.get(from) || [];
          q.push(candidate);
          earlyVoiceIceRef.current.set(from, q);
        }
      }
    } catch (err) {
      console.error('[voice] signal error:', err);
    }
  };

  // 组件卸载时释放共享与语音资源
  useEffect(() => {
    return () => {
      stopScreenShare(false);
      closeViewerConnection();
      stopMentorMic(false);
      closeAllVoiceListeners();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 同步静音开关到所有正在播放的导师语音 <audio> 元素
  useEffect(() => {
    mentorVoiceMutedRef.current = mentorVoiceMuted;
    voiceListenerPcsRef.current.forEach((entry) => {
      if (entry.audioEl) {
        entry.audioEl.muted = mentorVoiceMuted;
        if (!mentorVoiceMuted) entry.audioEl.play().catch(() => {});
      }
    });
  }, [mentorVoiceMuted]);

  // 自动订阅房间内正在开麦的导师语音（排除自己）
  useEffect(() => {
    if (!wsConnected) {
      closeAllVoiceListeners();
      return;
    }
    const activeIds = new Set(
      (activeVoiceSpeakers || [])
        .map((s) => s?.id)
        .filter((id) => id && id !== myClientIdRef.current)
    );
    // 清理已闭麦的导师连接
    Array.from(voiceListenerPcsRef.current.keys()).forEach((id) => {
      if (!activeIds.has(id)) closeVoiceListener(id);
    });
    // 订阅新开麦的导师
    activeIds.forEach((speakerId) => {
      if (!voiceListenerPcsRef.current.has(speakerId)) {
        wsRef.current?.send(JSON.stringify({
          type: 'VOICE_LISTENER_JOIN',
          payload: { speakerId, forceRelay: false },
        }));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVoiceSpeakers, wsConnected]);

  // 导师端：当房间有活跃屏幕共享且打开了预览面板时，自动发起观看请求
  useEffect(() => {
    if (isClientApp) return;
    if (remoteShareState.active && showViewerPane && wsConnected) {
      wsRef.current?.send(JSON.stringify({
        type: 'SCREEN_VIEWER_JOIN',
        payload: { forceRelay: viewerForceRelay },
      }));
    } else {
      closeViewerConnection();
      if (remoteShareState.active && !showViewerPane && wsConnected) {
        wsRef.current?.send(JSON.stringify({ type: 'SCREEN_VIEWER_LEAVE' }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteShareState.active, remoteShareState.sharerId, showViewerPane, wsConnected]);

  // 当 remoteVideoRef 挂载时绑定已有的视频流
  useEffect(() => {
    if (remoteVideoRef.current && viewerPcRef.current?.stream) {
      remoteVideoRef.current.srcObject = viewerPcRef.current.stream;
      remoteVideoRef.current.play().catch(() => {});
    }
  }, [viewerConnected, showViewerPane]);

  // WebSocket 实时同步（须同时具备 token 与用户输入的自定义名字才建立连接）
  useEffect(() => {
    if (!token || !userName) return;
    setAuthFail(false);
    setDestroyedMsg('');

    localStorage.setItem('pad_user_name', userName);
    // 房间参数留在地址栏，⌘R 刷新后仍在同一房间
    const extraWs = wsBase ? `&ws=${encodeURIComponent(wsBase)}` : '';
    window.history.replaceState({}, '', `${window.location.pathname}?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}&user=${encodeURIComponent(userName)}${extraWs}`);

    const defaultWsUrl = window.location.protocol === 'file:'
      ? 'wss://glasspad.up.railway.app'
      : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
    const wsUrl = wsBase || import.meta.env.VITE_WS_URL || defaultWsUrl;

    let ws;
    let reconnectTimer;
    let closed = false;
    let lastPongAt = Date.now();

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(`${wsUrl}/?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}&user=${encodeURIComponent(userName)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        lastPongAt = Date.now();
        setWsConnected(true);
        // 若客户端本地正在共享屏幕（例如断线重连后），自动重新向服务端注册共享状态
        if (shareSessionRef.current && !shareSessionRef.current.stopped) {
          ws.send(JSON.stringify({
            type: 'SCREEN_SHARE_START',
            payload: {
              micOn: Boolean(shareSessionRef.current.micTrack?.enabled),
              systemAudio: Boolean(shareSessionRef.current.sysAudioTrack),
            },
          }));
        }
        // 若导师端本地正在开麦（断线重连后），自动重新广播开麦状态
        if (mentorVoiceSessionRef.current && !mentorVoiceSessionRef.current.stopped) {
          ws.send(JSON.stringify({ type: 'VOICE_START' }));
        }
      };

      ws.onmessage = (e) => {
        lastPongAt = Date.now();
        const { type, payload } = JSON.parse(e.data);
        if (type === 'PONG') return;
        if (type === 'AUTH_FAIL') {
          setAuthFail(true);
        } else if (type === 'ROOM_DESTROYED') {
          setDestroyedMsg(payload?.reason || '该房间已被管理员销毁');
          setParticipants([]);
          stopScreenShare(false);
          closeViewerConnection();
          stopMentorMic(false);
          closeAllVoiceListeners();
        } else if (type === 'INIT' || type === 'TEXT_SYNC') {
          if (payload.clientId) myClientIdRef.current = payload.clientId;
          if (payload.screenShare) {
            setRemoteShareState(payload.screenShare);
          }
          if (Array.isArray(payload.voiceSpeakers)) {
            setActiveVoiceSpeakers(payload.voiceSpeakers);
          }
          const clean = normalizeLF(payload.text);
          // 先增量写入编辑器（保留选区），再同步 React 状态
          latestText.current = clean;
          applyRemoteText(clean);
          setText(clean);
          if (Array.isArray(payload.colorMarks)) {
            colorMarksRef.current = normalizeColorMarks(payload.colorMarks);
            renderColorMarks(colorMarksRef.current);
          }
          if (Array.isArray(payload.boldMarks)) {
            boldMarksRef.current = normalizeColorMarks(boldToInternal(payload.boldMarks));
            renderBoldMarks(boldMarksRef.current);
          }
          if (Array.isArray(payload.sizeMarks)) {
            sizeMarksRef.current = normalizeSizeMarks(payload.sizeMarks);
            renderSizeMarks(sizeMarksRef.current);
          }
          if (payload.language) setLanguage(payload.language);
        } else if (type === 'COLOR_MARKS_SYNC') {
          colorMarksRef.current = normalizeColorMarks(payload?.colorMarks || []);
          renderColorMarks(colorMarksRef.current);
        } else if (type === 'BOLD_MARKS_SYNC') {
          boldMarksRef.current = normalizeColorMarks(boldToInternal(payload?.boldMarks || []));
          renderBoldMarks(boldMarksRef.current);
        } else if (type === 'SIZE_MARKS_SYNC') {
          sizeMarksRef.current = normalizeSizeMarks(payload?.sizeMarks || []);
          renderSizeMarks(sizeMarksRef.current);
        } else if (type === 'LANG_SYNC') {
          setLanguage(payload.language);
        } else if (type === 'SEL_SYNC') {
          updateRemoteCursor(payload);
        } else if (type === 'PRESENCE') {
          const list = Array.isArray(payload) ? payload : [];
          setParticipants(list);
          syncRemoteCursorsWithPresence(list);
        } else if (type === 'SCREEN_SHARE_STATE') {
          setRemoteShareState(payload || { active: false, sharerId: null, micOn: false, systemAudio: false });
          if (!payload?.active) {
            closeViewerConnection();
          }
        } else if (type === 'SCREEN_SHARE_FORCE_STOP') {
          stopScreenShare(false);
        } else if (type === 'SCREEN_VIEWER_JOIN') {
          if (payload?.viewerId) createOfferForViewer(payload.viewerId, Boolean(payload.forceRelay));
        } else if (type === 'SCREEN_VIEWER_LEAVE') {
          if (payload?.viewerId) removeViewerPeer(payload.viewerId);
        } else if (type === 'RTC_SIGNAL') {
          handleRtcSignal(payload || {});
        } else if (type === 'VOICE_STATE') {
          setActiveVoiceSpeakers(Array.isArray(payload?.speakers) ? payload.speakers : []);
        } else if (type === 'VOICE_LISTENER_JOIN') {
          if (payload?.listenerId) createVoiceOfferForListener(payload.listenerId, Boolean(payload.forceRelay));
        } else if (type === 'VOICE_LISTENER_LEAVE') {
          if (payload?.listenerId) removeVoiceListenerPeer(payload.listenerId);
        } else if (type === 'VOICE_SIGNAL') {
          handleVoiceSignal(payload || {});
        }
      };

      ws.onclose = (ev) => {
        setWsConnected(false);
        // 4001 = 凭证无效 / 4002 = 房间已销毁，均不再重连
        if (!closed && ev.code !== 4001 && ev.code !== 4002) reconnectTimer = setTimeout(connect, 1500);
      };
    };

    connect();

    const heartbeat = setInterval(() => {
      const cur = wsRef.current;
      if (!cur) return;
      if (cur.readyState === 1) {
        // 超过 35 秒未收到任何服务端下行消息或 PONG（典型半开死连接/切代理后假在线），主动断开触发秒级重连
        if (Date.now() - lastPongAt > 35000) {
          try { cur.close(); } catch {}
          return;
        }
        cur.send(JSON.stringify({ type: 'PING', payload: { t: Date.now() } }));
      }
    }, 12000);

    // 监听操作系统网络恢复事件（切换 WiFi / 开关代理 / 唤醒睡眠）：立即踢醒死 WS 并通知观看端刷新链路
    const handleOnline = () => {
      if (closed) return;
      const cur = wsRef.current;
      if (!cur || cur.readyState === WebSocket.CLOSED || cur.readyState === WebSocket.CLOSING) {
        clearTimeout(reconnectTimer);
        connect();
      } else if (cur.readyState === WebSocket.OPEN) {
        cur.send(JSON.stringify({ type: 'PING', payload: { t: Date.now() } }));
        if (viewerPcRef.current && viewerPcRef.current.pc.connectionState !== 'connected') {
          cur.send(JSON.stringify({
            type: 'SCREEN_VIEWER_JOIN',
            payload: { forceRelay: Boolean(viewerPcRef.current.forceRelay) },
          }));
        }
      }
    };
    window.addEventListener('online', handleOnline);

    return () => {
      closed = true;
      window.removeEventListener('online', handleOnline);
      clearInterval(heartbeat);
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [roomId, token, userName, wsBase]);

  // ── CoderPad 风格：渲染所有远端成员的选区高亮 + 点击/光标位置的彩色姓名气泡 ──
  const renderAllRemoteCursors = () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    if (!remoteSelDecorations.current) {
      remoteSelDecorations.current = editor.createDecorationsCollection();
    }

    const allDecos = [];
    const activeIds = new Set();
    const maxLine = model.getLineCount();

    remoteCursorsRef.current.forEach((info, cid) => {
      if (!cid || cid === myClientIdRef.current) return;
      const selections = Array.isArray(info.selections) ? info.selections : [];
      if (selections.length === 0) return;

      const selClass = getRemoteSelectionClassName(info.color);
      for (const s of selections) {
        if (s.startLineNumber !== s.endLineNumber || s.startColumn !== s.endColumn) {
          allDecos.push({
            range: s,
            options: { className: selClass, stickiness: 2 },
          });
        }
      }

      // 取第一处选区/点击位置显示光标竖线和名字标签（点击某处时 start === end 同样显示）
      const primary = selections[0];
      const posLine = Math.max(1, Math.min(maxLine, primary.positionLineNumber || primary.endLineNumber || primary.startLineNumber || 1));
      const maxCol = model.getLineMaxColumn(posLine);
      const posCol = Math.max(1, Math.min(maxCol, primary.positionColumn || primary.endColumn || primary.startColumn || 1));

      activeIds.add(cid);
      const color = info.color || '#10b981';
      const name = info.name || 'User';

      let widget = cursorWidgetsRef.current.get(cid);
      if (!widget) {
        const domNode = document.createElement('div');
        domNode.className = 'gp-remote-cursor-widget';
        const caret = document.createElement('div');
        caret.className = 'gp-remote-cursor-caret';
        const flag = document.createElement('div');
        flag.className = 'gp-remote-cursor-flag';
        domNode.appendChild(caret);
        domNode.appendChild(flag);

        widget = {
          _domNode: domNode,
          _caret: caret,
          _flag: flag,
          _position: { lineNumber: posLine, column: posCol },
          getId: () => `gp.cursor.${cid}`,
          getDomNode: () => domNode,
          getPosition: function () {
            return {
              position: this._position,
              preference: [0], // EXACT：紧贴点击/光标所在行列展示
            };
          },
        };
        cursorWidgetsRef.current.set(cid, widget);
        editor.addContentWidget(widget);
      }

      widget._caret.style.backgroundColor = color;
      widget._flag.style.backgroundColor = color;
      widget._flag.textContent = name;
      if (info.showFlag === false) {
        widget._flag.classList.add('gp-flag-hidden');
      } else {
        widget._flag.classList.remove('gp-flag-hidden');
      }
      // 第 1 行顶部空间较窄时，姓名标签向下贴合避免被编辑器顶边裁切
      widget._flag.style.top = posLine <= 1 ? '0px' : '-18px';
      widget._position = { lineNumber: posLine, column: posCol };
      editor.layoutContentWidget(widget);
    });

    // 清理已离开或无光标的成员 Widget 与定时器
    cursorWidgetsRef.current.forEach((widget, cid) => {
      if (!activeIds.has(cid)) {
        try { editor.removeContentWidget(widget); } catch {}
        cursorWidgetsRef.current.delete(cid);
        const timer = cursorFlagTimersRef.current.get(cid);
        if (timer) {
          clearTimeout(timer);
          cursorFlagTimersRef.current.delete(cid);
        }
      }
    });

    remoteSelDecorations.current.set(allDecos);
  };

  // 为指定成员重置「名字标签显示 2.5 秒后自动消失」的计时器
  const scheduleHideCursorFlag = (cid) => {
    const prevTimer = cursorFlagTimersRef.current.get(cid);
    if (prevTimer) clearTimeout(prevTimer);
    const timer = setTimeout(() => {
      cursorFlagTimersRef.current.delete(cid);
      const cur = remoteCursorsRef.current.get(cid);
      if (cur) {
        cur.showFlag = false;
      }
      const widget = cursorWidgetsRef.current.get(cid);
      if (widget?._flag) {
        widget._flag.classList.add('gp-flag-hidden');
      }
    }, 2500);
    cursorFlagTimersRef.current.set(cid, timer);
  };

  const updateRemoteCursor = (payload) => {
    if (!payload) return;
    const cid = payload.clientId || 'legacy';
    if (cid === myClientIdRef.current) return;
    // 只有对方显式点击/选区时（payload.showFlag === true）才亮出名字标签；打字、删除、粘贴等被动光标移动绝不弹出名字
    const shouldShowFlag = payload.showFlag === true;
    remoteCursorsRef.current.set(cid, {
      name: payload.name || 'User',
      color: payload.color || '#f59e0b',
      selections: Array.isArray(payload.selections) ? payload.selections : [],
      showFlag: shouldShowFlag,
    });
    renderAllRemoteCursors();
    if (shouldShowFlag) {
      scheduleHideCursorFlag(cid);
    } else {
      const prevTimer = cursorFlagTimersRef.current.get(cid);
      if (prevTimer) {
        clearTimeout(prevTimer);
        cursorFlagTimersRef.current.delete(cid);
      }
    }
  };

  const syncRemoteCursorsWithPresence = (list) => {
    const onlineMap = new Map();
    for (const p of list || []) {
      if (p && p.id) onlineMap.set(p.id, p);
    }
    let changed = false;
    remoteCursorsRef.current.forEach((cur, cid) => {
      if (cid === 'legacy') return;
      const p = onlineMap.get(cid);
      if (!p) {
        remoteCursorsRef.current.delete(cid);
        changed = true;
      } else if (p.name !== cur.name || p.color !== cur.color) {
        cur.name = p.name;
        cur.color = p.color;
        changed = true;
      }
    });
    if (changed) renderAllRemoteCursors();
  };

  // 将局部文字颜色区间渲染为 Monaco inlineClassName 装饰
  const renderColorMarks = (marks) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    if (!colorMarksDecorations.current) {
      colorMarksDecorations.current = editor.createDecorationsCollection();
    }
    const maxLen = model.getValueLength();
    const decorations = [];
    for (const m of marks || []) {
      const start = Math.max(0, Math.min(maxLen, m.start));
      const end = Math.max(0, Math.min(maxLen, m.end));
      if (end <= start) continue;
      const inlineClassName = getInlineColorClassName(m.color);
      if (!inlineClassName) continue;
      const from = model.getPositionAt(start);
      const to = model.getPositionAt(end);
      decorations.push({
        range: {
          startLineNumber: from.lineNumber,
          startColumn: from.column,
          endLineNumber: to.lineNumber,
          endColumn: to.column,
        },
        options: {
          inlineClassName,
          stickiness: 2, // NeverGrowWhenTypingAtEdges：紧挨着局部样式边缘新打字时不自动吞入旧样式区间
        },
      });
    }
    colorMarksDecorations.current.set(decorations);
  };

  // 将加粗区间渲染为 Monaco inlineClassName 装饰（样式见 index.css 的 .gp-inline-bold）
  const renderBoldMarks = (marks) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    if (!boldMarksDecorations.current) {
      boldMarksDecorations.current = editor.createDecorationsCollection();
    }
    const maxLen = model.getValueLength();
    const decorations = [];
    for (const m of marks || []) {
      const start = Math.max(0, Math.min(maxLen, m.start));
      const end = Math.max(0, Math.min(maxLen, m.end));
      if (end <= start) continue;
      const from = model.getPositionAt(start);
      const to = model.getPositionAt(end);
      decorations.push({
        range: {
          startLineNumber: from.lineNumber,
          startColumn: from.column,
          endLineNumber: to.lineNumber,
          endColumn: to.column,
        },
        options: { inlineClassName: 'gp-inline-bold', stickiness: 2 },
      });
    }
    boldMarksDecorations.current.set(decorations);
  };

  // 将局部字号区间渲染为 Monaco inlineClassName 装饰
  const renderSizeMarks = (marks) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    if (!sizeMarksDecorations.current) {
      sizeMarksDecorations.current = editor.createDecorationsCollection();
    }
    const maxLen = model.getValueLength();
    const decorations = [];
    for (const m of marks || []) {
      const start = Math.max(0, Math.min(maxLen, m.start));
      const end = Math.max(0, Math.min(maxLen, m.end));
      if (end <= start) continue;
      const inlineClassName = getInlineSizeClassName(m.size);
      if (!inlineClassName) continue;
      const from = model.getPositionAt(start);
      const to = model.getPositionAt(end);
      decorations.push({
        range: {
          startLineNumber: from.lineNumber,
          startColumn: from.column,
          endLineNumber: to.lineNumber,
          endColumn: to.column,
        },
        options: { inlineClassName, stickiness: 2 },
      });
    }
    sizeMarksDecorations.current.set(decorations);
  };

  // 获取导师端当前有效选区：优先取编辑器实时非空选区，若因点击顶栏/弹出颜色面板短暂失焦则回退到最近一次非空选区并恢复
  const getActiveSelectionOffsets = () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return [];

    const liveNonEmpty = (editor.getSelections() || []).filter(
      (s) => s.startLineNumber !== s.endLineNumber || s.startColumn !== s.endColumn
    );
    const activeSelections = liveNonEmpty.length > 0 ? liveNonEmpty : lastNonEmptySelectionsRef.current;
    if (!activeSelections || activeSelections.length === 0) return [];

    if (liveNonEmpty.length === 0 && activeSelections.length > 0) {
      try { editor.setSelections(activeSelections); } catch {}
    }

    const maxLen = model.getValueLength();
    return activeSelections
      .map((s) => {
        const a = model.getOffsetAt({ lineNumber: s.startLineNumber, column: s.startColumn });
        const b = model.getOffsetAt({ lineNumber: s.endLineNumber, column: s.endColumn });
        return {
          start: Math.max(0, Math.min(maxLen, Math.min(a, b))),
          end: Math.max(0, Math.min(maxLen, Math.max(a, b))),
        };
      })
      .filter((r) => r.end > r.start);
  };

  // 导师端：对选中文字放大/缩小/重置字号（delta > 0 放大，delta < 0 缩小，delta === 0 恢复默认 15px），并实时同步给客户端
  const handleAdjustSelectionSize = (delta) => {
    if (isClientApp) return;
    const editor = editorRef.current;
    if (!editor) return;

    const offsetRanges = getActiveSelectionOffsets();
    if (offsetRanges.length === 0) {
      setColorTip('请先选中要调字号的文字');
      setTimeout(() => setColorTip(''), 2200);
      return;
    }

    const nextMarks = applySizeDeltaToOffsets(sizeMarksRef.current, offsetRanges, delta);
    sizeMarksRef.current = nextMarks;
    renderSizeMarks(nextMarks);

    // 更新顶栏显示当前选区字号（单一字号显示数字，混合字号显示 min-max）
    setSelectionFontSize(getSelectionSizeLabel(nextMarks, offsetRanges));

    setColorTip('');
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: 'SIZE_MARKS_SYNC', payload: { sizeMarks: nextMarks } }));
    }
    editor.focus();
  };

  // 导师端：选中文字切换加粗（选区已全部加粗则取消，否则加粗），并实时同步给客户端
  const handleToggleSelectionBold = () => {
    if (isClientApp) return;
    const editor = editorRef.current;
    if (!editor) return;

    const offsetRanges = getActiveSelectionOffsets();
    if (offsetRanges.length === 0) {
      setColorTip('请先选中要加粗的文字');
      setTimeout(() => setColorTip(''), 2200);
      return;
    }

    const removing = isRangesFullyCovered(boldMarksRef.current, offsetRanges);
    const nextMarks = applyColorToOffsets(boldMarksRef.current, offsetRanges, removing ? '' : BOLD_SENTINEL);
    boldMarksRef.current = nextMarks;
    renderBoldMarks(nextMarks);
    setColorTip('');
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: 'BOLD_MARKS_SYNC', payload: { boldMarks: boldToWire(nextMarks) } }));
    }
    editor.focus();
  };

  // 导师端：对当前选中的局部文本应用或清除字体颜色，并实时同步给客户端
  const handleApplySelectionColor = (nextColor) => {
    if (isClientApp) return;
    const editor = editorRef.current;
    if (!editor) return;

    const offsetRanges = getActiveSelectionOffsets();
    if (offsetRanges.length === 0) {
      setColorTip('请先选中要改色的文字');
      setTimeout(() => setColorTip(''), 2200);
      return;
    }

    if (nextColor) setPickerColor(nextColor);
    const nextMarks = applyColorToOffsets(colorMarksRef.current, offsetRanges, nextColor);
    colorMarksRef.current = nextMarks;
    renderColorMarks(nextMarks);
    setColorTip('');
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: 'COLOR_MARKS_SYNC', payload: { colorMarks: nextMarks } }));
    }
    editor.focus();
  };

  // 远端文字增量写入：只替换前后缀之间变化的部分，避免整体 setValue 清掉客户的选区；
  // 客户端同时锁住当前滚动位置（scrollTop / scrollLeft），导师往后追加内容时客户端视图保持原位不跳动
  const applyRemoteText = (newText) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!model) return;
    const oldText = model.getValue();
    if (oldText === newText) return;
    const savedScrollTop = isClientApp ? editor.getScrollTop() : null;
    const savedScrollLeft = isClientApp ? editor.getScrollLeft() : null;
    let start = 0;
    const minLen = Math.min(oldText.length, newText.length);
    while (start < minLen && oldText[start] === newText[start]) start++;
    let endOld = oldText.length;
    let endNew = newText.length;
    while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
      endOld--;
      endNew--;
    }
    const from = model.getPositionAt(start);
    const to = model.getPositionAt(endOld);
    isRemote.current = true; // applyEdits 会同步触发 onChange，由 handleTextChange 消费该标记
    model.applyEdits([{
      range: {
        startLineNumber: from.lineNumber, startColumn: from.column,
        endLineNumber: to.lineNumber, endColumn: to.column,
      },
      text: newText.slice(start, endNew),
    }]);
    isRemote.current = false;
    if (isClientApp && savedScrollTop !== null) {
      editor.setScrollPosition({ scrollTop: savedScrollTop, scrollLeft: savedScrollLeft });
    }
  };

  const sendText = (value, colorMarks, boldMarks, sizeMarks) => {
    if (wsRef.current?.readyState === 1) {
      const payload = { text: value };
      if (Array.isArray(colorMarks)) payload.colorMarks = colorMarks;
      if (Array.isArray(boldMarks)) payload.boldMarks = boldToWire(boldMarks);
      if (Array.isArray(sizeMarks)) payload.sizeMarks = sizeMarks;
      wsRef.current.send(JSON.stringify({ type: 'TEXT_SYNC', payload }));
    }
  };

  const handleTextChange = (val, ev) => {
    if (isClientApp) return; // 客户端只读，不发送
    if (isRemote.current) {
      isRemote.current = false;
      return;
    }
    const clean = normalizeLF(val);
    if (ev?.changes?.length && colorMarksRef.current.length > 0) {
      const shifted = shiftColorMarksByChanges(colorMarksRef.current, ev.changes);
      colorMarksRef.current = shifted;
      renderColorMarks(shifted);
    }
    if (ev?.changes?.length && boldMarksRef.current.length > 0) {
      const shiftedBold = shiftColorMarksByChanges(boldMarksRef.current, ev.changes);
      boldMarksRef.current = shiftedBold;
      renderBoldMarks(shiftedBold);
    }
    if (ev?.changes?.length && sizeMarksRef.current.length > 0) {
      const shiftedSize = shiftSizeMarksByChanges(sizeMarksRef.current, ev.changes);
      sizeMarksRef.current = shiftedSize;
      renderSizeMarks(shiftedSize);
    }
    setText(clean);
    sendText(clean, colorMarksRef.current, boldMarksRef.current, sizeMarksRef.current);
  };

  const clearPad = () => {
    colorMarksRef.current = [];
    boldMarksRef.current = [];
    sizeMarksRef.current = [];
    lastNonEmptySelectionsRef.current = [];
    setHasSelection(false);
    renderColorMarks([]);
    renderBoldMarks([]);
    renderSizeMarks([]);
    setSelectionFontSize(String(DEFAULT_FONT_SIZE));
    setText('');
    sendText('', [], [], []);
  };

  const commitNameChange = (raw) => {
    const clean = normalizeCustomName(raw);
    if (!clean) return false;
    setUserName(clean);
    localStorage.setItem('pad_user_name', clean);
    setEditingName(false);
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: 'NAME_SYNC', payload: { name: clean } }));
    }
    return true;
  };

  // 无 token：显示「粘贴邀请链接 + 输入名字」入口
  if (!token) {
    return (
      <>
        <JoinGate
          appVersion={appVersion}
          updateInfo={updateInfo}
          checkingUpdate={checkingUpdate}
          updateBannerText={updateBannerText}
          onCheckUpdate={handleManualCheckUpdate}
          onOpenUpdateModal={() => setShowUpdateModal(true)}
          initialName={userName}
          onJoin={(room, tok, user, wsOrigin) => {
            setRoomId(room);
            setToken(tok);
            if (user) {
              setUserName(user);
              localStorage.setItem('pad_user_name', user);
            }
            if (wsOrigin) setWsBase(wsOrigin);
          }}
        />
        {showUpdateModal && updateInfo && (
          <UpdateModal
            updateInfo={updateInfo}
            onClose={() => setShowUpdateModal(false)}
          />
        )}
      </>
    );
  }

  // 有 token 但尚未设置个人名字：进入 Pad 前先输入自己的名字（CoderPad 风格，不再使用默认 Client/Mentor）
  if (!userName) {
    return (
      <>
        <NameGate
          roomId={roomId}
          appVersion={appVersion}
          updateInfo={updateInfo}
          checkingUpdate={checkingUpdate}
          updateBannerText={updateBannerText}
          onCheckUpdate={handleManualCheckUpdate}
          onOpenUpdateModal={() => setShowUpdateModal(true)}
          onSubmit={(name) => commitNameChange(name)}
        />
        {showUpdateModal && updateInfo && (
          <UpdateModal
            updateInfo={updateInfo}
            onClose={() => setShowUpdateModal(false)}
          />
        )}
      </>
    );
  }

  const bgAlpha = isClientApp ? opacity : 1;
  const frost = isClientApp && supportsFrost && frostedGlass;
  const barBg = `rgba(20, 20, 20, ${Math.min(bgAlpha + 0.08, 1)})`;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      width: '100%', height: '100dvh',
      boxSizing: 'border-box',
      background: `rgba(13, 13, 13, ${bgAlpha})`,
      backdropFilter: frost ? 'blur(14px)' : 'none',
      WebkitBackdropFilter: frost ? 'blur(14px)' : 'none',
      color: '#e5e5e5', fontFamily: uiFont,
      border: isClientApp ? '1px solid rgba(255, 255, 255, 0.12)' : 'none',
      borderRadius: isClientApp ? '8px' : '0px', overflow: 'hidden',
    }}>
      {/* 顶部栏（桌面端整条可按住拖拽移动窗口，右侧控件除外） */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
        padding: '8px 14px', background: barBg,
        borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
        fontSize: '12.5px', color: '#d1d5db', flexShrink: 0,
        WebkitAppRegion: isClientApp ? 'drag' : 'no-drag',
        cursor: isClientApp ? 'grab' : 'default',
      }}>
        {isClientApp ? (
          <>
            {/* 品牌标识 + 拖拽手柄 + 清晰快捷键提示 */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              userSelect: 'none', color: '#cbd5e1', fontSize: '12px', fontWeight: 500,
              whiteSpace: 'nowrap', letterSpacing: '0.2px',
            }}>
              <BrandLogo size={18} />
              <span style={{ color: '#f1f5f9', fontWeight: 600, marginRight: '2px' }}>GlassPad</span>
              <span style={{ color: '#64748b', fontSize: '11px', fontFamily: codeFont }}>v{appVersion}</span>
              <span style={{ color: '#475569' }}>|</span>
              <span>
                拖拽移动 · {modKey}方向键 移动 · {modKey}B 隐藏/显示 · {modKey}[ {modKey}] 透明度 · {modKey}R 刷新 · {modKey}Q 退出
              </span>
            </div>

            {/* 中间弹性拖拽区 */}
            <div style={{ flex: 1, minWidth: '20px', alignSelf: 'stretch' }} />

            <div style={{
              marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '10px',
              WebkitAppRegion: 'no-drag', cursor: 'default',
            }}>
              {updateBannerText && (
                <span style={{ color: '#34d399', fontSize: '11.5px', whiteSpace: 'nowrap' }}>
                  {updateBannerText}
                </span>
              )}

              {/* 检查更新按钮（有新版本时高亮提示） */}
              <button
                onClick={() => (updateInfo?.hasUpdate ? setShowUpdateModal(true) : handleManualCheckUpdate())}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '5px',
                  background: updateInfo?.hasUpdate ? 'rgba(56, 189, 248, 0.2)' : 'rgba(31, 41, 55, 0.75)',
                  color: updateInfo?.hasUpdate ? '#38bdf8' : '#cbd5e1',
                  border: `1px solid ${updateInfo?.hasUpdate ? 'rgba(56, 189, 248, 0.5)' : '#374151'}`,
                  borderRadius: '6px', padding: '4px 9px', fontSize: '11.5px', fontWeight: 600,
                  cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >
                {updateInfo?.hasUpdate && (
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#38bdf8' }} />
                )}
                {checkingUpdate
                  ? '检查中…'
                  : updateInfo?.hasUpdate
                    ? `新版本 v${updateInfo.latestVersion}`
                    : '检查更新'}
              </button>

              {shareError && (
                <span
                  onClick={() => window.electronAPI?.openPrivacySettings?.('screen')}
                  style={{ color: '#f87171', fontSize: '11.5px', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  {shareError}
                </span>
              )}

              {isSharingScreen && shareMicError && (
                <span
                  onClick={() => window.electronAPI?.openPrivacySettings?.('microphone')}
                  style={{ color: '#f59e0b', fontSize: '11.5px', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  {shareMicError}
                </span>
              )}

              {/* 客户端静默屏幕共享开关（免弹窗直接共享主屏幕 + 声音） */}
              <button
                onClick={() => (isSharingScreen ? stopScreenShare(true) : startScreenShare())}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '6px',
                  background: isSharingScreen ? 'rgba(16, 185, 129, 0.2)' : 'rgba(31, 41, 55, 0.85)',
                  color: isSharingScreen ? '#34d399' : '#e2e8f0',
                  border: `1px solid ${isSharingScreen ? 'rgba(16, 185, 129, 0.5)' : '#374151'}`,
                  borderRadius: '6px', padding: '4px 10px', fontSize: '12px', fontWeight: 600,
                  cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >
                <span style={{
                  width: '7px', height: '7px', borderRadius: '50%',
                  background: isSharingScreen ? '#10b981' : '#64748b',
                }} />
                {isSharingScreen ? 'Sharing Screen' : 'Share Screen'}
              </button>

              {/* 麦克风开关：始终显示，含 ON / OFF / 无（不可用）三种状态 */}
              {isSharingScreen && (
                <button
                  onClick={shareHasMic ? toggleShareMic : () => window.electronAPI?.openPrivacySettings?.('microphone')}
                  style={{
                    background: shareMicOn ? 'rgba(16, 185, 129, 0.18)' : 'rgba(31, 41, 55, 0.75)',
                    color: shareHasMic ? (shareMicOn ? '#34d399' : '#94a3b8') : '#f87171',
                    border: `1px solid ${shareHasMic ? (shareMicOn ? 'rgba(16, 185, 129, 0.45)' : '#374151') : 'rgba(239, 68, 68, 0.4)'}`,
                    borderRadius: '6px', padding: '4px 8px', fontSize: '11.5px', fontWeight: 500,
                    cursor: 'pointer', whiteSpace: 'nowrap',
                  }}
                >
                  Mic: {shareHasMic ? (shareMicOn ? 'ON' : 'OFF') : '无'}
                </button>
              )}

              {/* macOS 系统音增强入口（BlackHole） */}
              {isSharingScreen && audioSetup.supported && (
                <button
                  onClick={() => setShowAudioGuide((v) => !v)}
                  style={{
                    background: audioSetup.blackholeInstalled ? 'rgba(56, 189, 248, 0.16)' : 'rgba(245, 158, 11, 0.14)',
                    color: audioSetup.blackholeInstalled ? '#38bdf8' : '#fbbf24',
                    border: `1px solid ${audioSetup.blackholeInstalled ? 'rgba(56, 189, 248, 0.4)' : 'rgba(245, 158, 11, 0.4)'}`,
                    borderRadius: '6px', padding: '4px 8px', fontSize: '11.5px', fontWeight: 600,
                    cursor: 'pointer', whiteSpace: 'nowrap',
                  }}
                >
                  🔊 系统音{audioSetup.blackholeInstalled ? ' ✓' : ''}
                </button>
              )}

              {/* 物理扬声器音量（macOS 安装 BlackHole 后常驻显示）：聚合设备接管后系统音量键失效，这里绕过聚合设备直接实时调物理扬声器 */}
              {audioSetup.blackholeInstalled && (
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: '5px', color: '#94a3b8', fontSize: '11px', whiteSpace: 'nowrap' }}
                >
                  <span>🔊 本机音量</span>
                  <input
                    type="range" min="0" max="100" step="1" value={speakerVolume}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setSpeakerVolume(v);
                      speakerDuckedRef.current = false;
                      window.electronAPI?.setSpeakerVolume?.(v);
                    }}
                    style={{ width: '56px', cursor: 'pointer', accentColor: '#38bdf8' }}
                  />
                  <span style={{ minWidth: '28px', textAlign: 'right' }}>{speakerVolume}%</span>
                </label>
              )}

              {/* 导师语音收听指示与一键静音（仅当有导师正在开麦时显示） */}
              {activeVoiceSpeakers.filter((s) => s?.id !== myClientIdRef.current).length > 0 && (
                <button
                  onClick={() => setMentorVoiceMuted((v) => !v)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '5px',
                    background: mentorVoiceMuted ? 'rgba(239, 68, 68, 0.16)' : 'rgba(16, 185, 129, 0.18)',
                    color: mentorVoiceMuted ? '#f87171' : '#34d399',
                    border: `1px solid ${mentorVoiceMuted ? 'rgba(239, 68, 68, 0.4)' : 'rgba(16, 185, 129, 0.45)'}`,
                    borderRadius: '6px', padding: '4px 8px', fontSize: '11.5px', fontWeight: 600,
                    cursor: 'pointer', whiteSpace: 'nowrap',
                  }}
                >
                  <span>{mentorVoiceMuted ? '🔇 导师已静音' : '🎙 导师语音中'}</span>
                </button>
              )}

              {/* 当前传给导师的音频来源提示 */}
              {isSharingScreen && (
                <span style={{ color: '#64748b', fontSize: '11px', whiteSpace: 'nowrap' }}>
                  {shareSystemAudio && shareHasMic
                    ? (audioSetup.blackholeInstalled ? '系统音(BlackHole) + 麦克风' : '系统音 + 麦克风')
                    : shareSystemAudio
                      ? (audioSetup.blackholeInstalled ? '系统音(BlackHole)' : '系统音')
                      : shareHasMic
                        ? (audioSetup.blackholeInstalled ? '仅麦克风（系统音未就绪）' : '麦克风拾音（系统音请开外放）')
                        : '无声音'}
                </span>
              )}

              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#e2e8f0', fontWeight: 500 }}>
                Opacity {Math.round(opacity * 100)}%
                <input
                  type="range" min="0.08" max="1" step="0.04" value={opacity}
                  onChange={(e) => setOpacity(Number(e.target.value))}
                  style={{ width: '64px', cursor: 'pointer', accentColor: '#10b981' }}
                />
              </label>

              {supportsFrost && (
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontWeight: 500, color: frostedGlass ? '#10b981' : '#cbd5e1' }}>
                  <input
                    type="checkbox" checked={frostedGlass}
                    onChange={(e) => toggleFrostedGlass(e.target.checked)}
                    style={{ accentColor: '#10b981', cursor: 'pointer' }}
                  />
                  Frosted Glass
                </label>
              )}
            </div>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginRight: '6px' }}>
              <BrandLogo size={20} />
              <span style={{ color: '#f1f5f9', fontWeight: 600, fontSize: '13px' }}>GlassPad</span>
            </div>
            <button onClick={clearPad} style={btn}>Clear</button>

            {/* 导师端开麦按钮（独立 WebRTC 语音通道，直接传给房间内候选人/其他成员） */}
            <button
              onClick={toggleMentorMic}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                background: mentorMicOn ? 'rgba(16, 185, 129, 0.22)' : 'rgba(31, 41, 55, 0.85)',
                color: mentorMicOn ? '#34d399' : '#e2e8f0',
                border: `1px solid ${mentorMicOn ? 'rgba(16, 185, 129, 0.55)' : '#374151'}`,
                borderRadius: '6px', padding: '4px 10px', fontSize: '12px', fontWeight: 600,
                cursor: 'pointer', whiteSpace: 'nowrap',
              }}
              title={mentorMicOn ? '点击关闭导师麦克风' : '点击开启导师麦克风，直接对候选人讲话'}
            >
              <span style={{
                width: '7px', height: '7px', borderRadius: '50%',
                background: mentorMicOn ? '#10b981' : '#64748b',
              }} />
              {mentorMicOn ? '🎙 导师开麦中' : '🎙 导师开麦'}
            </button>
            {mentorMicError && (
              <span style={{ color: '#f87171', fontSize: '11.5px', whiteSpace: 'nowrap' }}>
                {mentorMicError}
              </span>
            )}
            {activeVoiceSpeakers.filter((s) => s?.id !== myClientIdRef.current).length > 0 && (
              <button
                onClick={() => setMentorVoiceMuted((v) => !v)}
                style={{
                  background: mentorVoiceMuted ? 'rgba(239, 68, 68, 0.16)' : 'rgba(56, 189, 248, 0.16)',
                  color: mentorVoiceMuted ? '#f87171' : '#38bdf8',
                  border: `1px solid ${mentorVoiceMuted ? 'rgba(239, 68, 68, 0.4)' : 'rgba(56, 189, 248, 0.4)'}`,
                  borderRadius: '6px', padding: '4px 8px', fontSize: '11.5px', cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >
                {mentorVoiceMuted ? '🔇 队友静音' : '🔊 听队友语音'}
              </button>
            )}

            {/* 导师端：当候选人开启屏幕共享时显示实时观看控制 */}
            {remoteShareState.active ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  onClick={() => setShowViewerPane((v) => !v)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '6px',
                    background: showViewerPane ? 'rgba(16, 185, 129, 0.2)' : 'rgba(31, 41, 55, 0.8)',
                    color: showViewerPane ? '#34d399' : '#cbd5e1',
                    border: `1px solid ${showViewerPane ? 'rgba(16, 185, 129, 0.45)' : '#374151'}`,
                    borderRadius: '6px', padding: '4px 10px', fontSize: '12px', fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#10b981' }} />
                  {showViewerPane ? '隐藏客户屏幕' : '查看客户屏幕 (Live)'}
                </button>
                <button
                  onClick={() => wsRef.current?.send(JSON.stringify({ type: 'SCREEN_SHARE_STOP' }))}
                  style={{
                    background: 'rgba(239, 68, 68, 0.14)', color: '#f87171',
                    border: '1px solid rgba(239, 68, 68, 0.35)', borderRadius: '6px',
                    padding: '4px 9px', fontSize: '12px', cursor: 'pointer',
                  }}
                  title="远程关闭候选人的屏幕共享"
                >
                  停止共享
                </button>
              </div>
            ) : (
              <span style={{ color: '#64748b', fontSize: '12px' }}>
                客户未开启屏幕共享
              </span>
            )}

            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px' }}>
              {colorTip && (
                <span style={{ color: '#f59e0b', fontSize: '11.5px', whiteSpace: 'nowrap' }}>
                  {colorTip}
                </span>
              )}
              <SelectionSizeControl
                fontSize={selectionFontSize}
                hasSelection={hasSelection}
                onAdjust={handleAdjustSelectionSize}
              />
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleToggleSelectionBold}
                title="加粗 / 取消加粗选中文字（⌘B / Ctrl+B）"
                style={{
                  ...btn,
                  fontWeight: 800,
                  color: hasSelection ? '#34d399' : '#9ca3af',
                  borderColor: hasSelection ? 'rgba(16, 185, 129, 0.55)' : '#333',
                  padding: '3px 9px',
                }}
              >
                B
              </button>
              <SelectionColorPicker
                pickerColor={pickerColor}
                hasSelection={hasSelection}
                onApplyColor={handleApplySelectionColor}
              />
              <select
                value={language}
                onChange={(e) => {
                  const lang = e.target.value;
                  setLanguage(lang);
                  wsRef.current?.send(JSON.stringify({ type: 'LANG_SYNC', payload: { language: lang } }));
                }}
                style={{
                  background: 'transparent', color: '#9ca3af',
                  border: 'none', fontSize: '13px', outline: 'none', cursor: 'pointer',
                }}
              >
                <option value="python" style={{ background: '#141414' }}>Python</option>
                <option value="plaintext" style={{ background: '#141414' }}>Plain Text (BQ 提词)</option>
                <option value="cpp" style={{ background: '#141414' }}>C++</option>
                <option value="java" style={{ background: '#141414' }}>Java</option>
                <option value="javascript" style={{ background: '#141414' }}>JavaScript</option>
              </select>
            </div>
          </>
        )}
      </div>

      {/* 客户端提醒横幅：未装 BlackHole 时，靠麦克风拾取外放兜底，提醒候选人打开扬声器 */}
      {isClientApp && isSharingScreen && !shareSystemAudio && !audioSetup.blackholeInstalled && !speakerTipDismissed && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '8px 14px',
          background: 'linear-gradient(90deg, rgba(245, 158, 11, 0.18), rgba(239, 68, 68, 0.12))',
          borderBottom: '1px solid rgba(245, 158, 11, 0.4)',
          color: '#fbbf24', fontSize: '12.5px', fontWeight: 600,
          flexShrink: 0, WebkitAppRegion: 'no-drag', cursor: 'default',
        }}>
          <span style={{ fontSize: '15px', lineHeight: 1 }}>🔊</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            已开启屏幕共享：请打开电脑<b style={{ color: '#fcd34d' }}>扬声器外放</b>，导师才能听到你电脑里播放的声音
          </span>
          <button
            onClick={() => setSpeakerTipDismissed(true)}
            style={{
              background: 'rgba(31, 41, 55, 0.7)', color: '#fcd34d',
              border: '1px solid rgba(245, 158, 11, 0.4)', borderRadius: '5px',
              padding: '2px 9px', fontSize: '11.5px', cursor: 'pointer', fontWeight: 600,
            }}
          >
            知道了
          </button>
        </div>
      )}

      {/* macOS BlackHole 系统音引导横幅 */}
      {isClientApp && isSharingScreen && showAudioGuide && audioSetup.supported && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
          padding: '8px 14px',
          background: 'rgba(14, 22, 33, 0.96)',
          borderBottom: '1px solid rgba(56, 189, 248, 0.35)',
          color: '#cbd5e1', fontSize: '12.5px',
          flexShrink: 0, WebkitAppRegion: 'no-drag', cursor: 'default',
        }}>
          <span style={{ fontSize: '15px', lineHeight: 1 }}>🎧</span>
          {!audioSetup.blackholeInstalled ? (
            <>
              <span style={{ flex: 1, minWidth: 0 }}>
                建议安装免费组件 <b style={{ color: '#38bdf8' }}>BlackHole</b>，可无损传输电脑声音（无需开外放、不受环境噪声影响）
              </span>
              <button onClick={() => window.electronAPI?.openBlackHoleDownload?.()} style={{
                background: 'rgba(56, 189, 248, 0.18)', color: '#38bdf8',
                border: '1px solid rgba(56, 189, 248, 0.4)', borderRadius: '5px',
                padding: '3px 10px', fontSize: '12px', cursor: 'pointer', fontWeight: 600,
              }}>
                下载 BlackHole
              </button>
              <button onClick={handleRecheckAudioSetup} disabled={audioSetupBusy} style={{
                background: 'rgba(31, 41, 55, 0.8)', color: '#cbd5e1',
                border: '1px solid #334155', borderRadius: '5px',
                padding: '3px 10px', fontSize: '12px', cursor: 'pointer', fontWeight: 600,
              }}>
                {audioSetupBusy ? '检测中…' : '我已安装，重新检测'}
              </button>
            </>
          ) : (
            <>
              <span style={{ flex: 1, minWidth: 0 }}>
                {audioSetupMsg || '已检测到 BlackHole，一键配置系统声音输出后即可无损传输'}
              </span>
              <button onClick={handleRunAudioSetup} disabled={audioSetupBusy} style={{
                background: 'rgba(16, 185, 129, 0.18)', color: '#34d399',
                border: '1px solid rgba(16, 185, 129, 0.4)', borderRadius: '5px',
                padding: '3px 10px', fontSize: '12px', cursor: 'pointer', fontWeight: 600,
              }}>
                {audioSetupBusy ? '配置中…' : '一键配置系统音'}
              </button>
            </>
          )}
          <button onClick={() => setShowAudioGuide(false)} style={{
            background: 'transparent', color: '#94a3b8',
            border: 'none', fontSize: '13px', cursor: 'pointer',
          }}>
            ✕
          </button>
        </div>
      )}

      {/* 主体区域：导师端在观看屏幕时左右分栏（左侧客户实时屏幕 + 右侧提词编辑器），客户端保持单栏 */}
      <div style={{ flex: 1, display: 'flex', minWidth: 0, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
        {!isClientApp && remoteShareState.active && showViewerPane && (
          <div style={{
            width: '52%', minWidth: '340px', maxWidth: '75%',
            borderRight: '1px solid rgba(255, 255, 255, 0.1)',
            background: '#05070a', display: 'flex', flexDirection: 'column',
            position: 'relative',
          }}>
            {/* 播放器顶栏 */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '6px 12px', background: 'rgba(15, 23, 34, 0.9)',
              borderBottom: '1px solid rgba(255, 255, 255, 0.07)', fontSize: '12px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{
                  width: '7px', height: '7px', borderRadius: '50%',
                  background: viewerConnected ? '#10b981' : '#f59e0b',
                }} />
                <span style={{ color: '#e2e8f0', fontWeight: 600 }}>
                  {viewerConnected
                    ? `客户桌面实时画面 (${viewerConnMode || 'WebRTC'})`
                    : (viewerConnMode || '正在连接客户桌面…')}
                </span>
                <span style={{ color: '#64748b', fontSize: '11.5px' }}>
                  · 客户麦克风: {remoteShareState.micOn ? '已开启' : '已关闭'} · 系统音: {remoteShareState.systemAudio ? '有' : '无'}
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  onClick={() => {
                    const nextRelay = !viewerForceRelay;
                    setViewerForceRelay(nextRelay);
                    setViewerConnMode(nextRelay ? '切换 TURN 强制中继…' : '切换智能直连…');
                    wsRef.current?.send(JSON.stringify({
                      type: 'SCREEN_VIEWER_JOIN',
                      payload: { forceRelay: nextRelay },
                    }));
                  }}
                  style={{
                    background: viewerForceRelay ? 'rgba(56, 189, 248, 0.2)' : '#1e293b',
                    color: viewerForceRelay ? '#38bdf8' : '#cbd5e1',
                    border: `1px solid ${viewerForceRelay ? 'rgba(56, 189, 248, 0.5)' : '#334155'}`,
                    borderRadius: '5px', padding: '3px 8px', fontSize: '11.5px', cursor: 'pointer',
                  }}
                >
                  {viewerForceRelay ? '中继模式 ✓' : '切中继线路'}
                </button>
                <button
                  onClick={() => {
                    const next = !viewerMuted;
                    setViewerMuted(next);
                    if (remoteVideoRef.current) remoteVideoRef.current.muted = next;
                  }}
                  style={{
                    background: '#1e293b', color: viewerMuted ? '#f87171' : '#cbd5e1',
                    border: '1px solid #334155', borderRadius: '5px',
                    padding: '3px 8px', fontSize: '11.5px', cursor: 'pointer',
                  }}
                >
                  {viewerMuted ? '已静音 🔇' : '声音开启 🔊'}
                </button>
                <button
                  onClick={() => remoteVideoRef.current?.requestFullscreen?.()}
                  style={{
                    background: '#1e293b', color: '#cbd5e1',
                    border: '1px solid #334155', borderRadius: '5px',
                    padding: '3px 8px', fontSize: '11.5px', cursor: 'pointer',
                  }}
                >
                  全屏 ⛶
                </button>
              </div>
            </div>

            {/* 视频画面容器 */}
            <div style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              position: 'relative', overflow: 'hidden', background: '#000',
            }}>
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                muted={viewerMuted}
                onLoadedData={() => setViewerConnected(true)}
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
              {!viewerConnected && (
                <div style={{
                  position: 'absolute', color: viewerConnMode.includes('失败') ? '#fca5a5' : '#94a3b8', fontSize: '13px',
                  background: 'rgba(15, 23, 34, 0.88)', padding: '8px 14px', borderRadius: '6px',
                  border: viewerConnMode.includes('失败') ? '1px solid rgba(239, 68, 68, 0.4)' : 'none',
                }}>
                  {viewerConnMode.includes('失败')
                    ? `${viewerConnMode} · 请在服务端配置 CF_TURN_KEY_ID / CF_TURN_API_TOKEN`
                    : '正在建立 WebRTC 视频流（优先 P2P，跨区/代理自动走 TURN 中继）…'}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 提词编辑器区（客户端只读，实时渲染导师标注的局部文字颜色） */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            height: '100%',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <Editor
            width="100%"
            height="100%"
          theme="glasspad-transparent"
          language={language}
          // 客户端不走受控 value（库在只读模式下每次 value 变化都会整体 setValue，清掉选区），
          // 远端文字由 applyRemoteText 增量写入；导师端保持受控
          value={isClientApp ? undefined : text}
          defaultValue={text}
          onChange={handleTextChange}
          beforeMount={(monaco) => {
            monaco.editor.defineTheme('glasspad-transparent', {
              base: 'vs-dark',
              inherit: true,
              rules: [],
              colors: {
                'editor.background': '#00000000',
                'editorGutter.background': '#00000000',
                'editor.lineHighlightBackground': '#00000000',
                'scrollbarSlider.background': '#ffffff38',
                'scrollbarSlider.hoverBackground': '#ffffff55',
                'scrollbarSlider.activeBackground': '#ffffff77',
                'editor.selectionBackground': '#1e5aa8',
                'editor.inactiveSelectionBackground': '#1e5aa8',
              },
            });
          }}
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            // WS 的 INIT 可能早于 Monaco 加载完成到达，挂载时补写最新文字与局部颜色
            if (isClientApp && latestText.current) {
              applyRemoteText(latestText.current);
            } else if (!isClientApp && latestText.current) {
              const model = editor.getModel();
              if (model && model.getValue() !== latestText.current) {
                applyRemoteText(latestText.current);
              }
            }
            if (colorMarksRef.current.length > 0) renderColorMarks(colorMarksRef.current);
            if (boldMarksRef.current.length > 0) renderBoldMarks(boldMarksRef.current);
            if (sizeMarksRef.current.length > 0) renderSizeMarks(sizeMarksRef.current);
            if (remoteCursorsRef.current.size > 0) renderAllRemoteCursors();
            monaco.editor.setTheme('glasspad-transparent');
            editor.getModel()?.setEOL(monaco.editor.EndOfLineSequence.LF);
            requestAnimationFrame(() => editor.layout());
            // 导师端注册加粗快捷键
            if (!isClientApp) {
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, handleToggleSelectionBold);
            }
            // 双端（导师 + 候选人）：只有鼠标显式点击/框选（source === 'mouse'）时才显示名字标签；打字、删除、粘贴等被动光标移动不弹名字
            editor.onDidChangeCursorSelection((ev) => {
              const selections = (editor.getSelections() || []).map((s) => ({
                startLineNumber: s.startLineNumber,
                startColumn: s.startColumn,
                endLineNumber: s.endLineNumber,
                endColumn: s.endColumn,
                positionLineNumber: s.positionLineNumber,
                positionColumn: s.positionColumn,
              }));
              if (!isClientApp) {
                const nonEmpty = selections.filter(
                  (s) => s.startLineNumber !== s.endLineNumber || s.startColumn !== s.endColumn
                );
                const model = editor.getModel();
                if (model && nonEmpty.length > 0) {
                  lastNonEmptySelectionsRef.current = nonEmpty;
                  setHasSelection(true);
                  const offsetRanges = nonEmpty.map((s) => {
                    const a = model.getOffsetAt({ lineNumber: s.startLineNumber, column: s.startColumn });
                    const b = model.getOffsetAt({ lineNumber: s.endLineNumber, column: s.endColumn });
                    return { start: Math.min(a, b), end: Math.max(a, b) };
                  });
                  setSelectionFontSize(getSelectionSizeLabel(sizeMarksRef.current, offsetRanges));
                } else if (document.activeElement && editor.getDomNode()?.contains(document.activeElement)) {
                  // 仅当焦点仍在编辑器内且用户主动点空白处取消选区时，才清空缓存选区
                  lastNonEmptySelectionsRef.current = [];
                  setHasSelection(false);
                  setSelectionFontSize(String(DEFAULT_FONT_SIZE));
                }
              }
              if (wsRef.current?.readyState !== 1) return;
              // 仅鼠标点击/框选触发名字标签（排除键盘输入/删除/粘贴/远端文本同步引起的被动光标移动）
              const isExplicitClick = ev?.source === 'mouse';
              wsRef.current.send(JSON.stringify({
                type: 'SEL_SYNC',
                payload: { selections, showFlag: isExplicitClick },
              }));
            });
            // 鼠标重复点击编辑器同一位置时，selection 未变化不会触发 onDidChangeCursorSelection，这里用 onMouseDown 补发一次带 showFlag: true
            editor.onMouseDown((mouseEv) => {
              if (!mouseEv?.target?.position) return;
              requestAnimationFrame(() => {
                if (wsRef.current?.readyState !== 1) return;
                const selections = (editor.getSelections() || []).map((s) => ({
                  startLineNumber: s.startLineNumber,
                  startColumn: s.startColumn,
                  endLineNumber: s.endLineNumber,
                  endColumn: s.endColumn,
                  positionLineNumber: s.positionLineNumber,
                  positionColumn: s.positionColumn,
                }));
                if (selections.length > 0) {
                  wsRef.current.send(JSON.stringify({
                    type: 'SEL_SYNC',
                    payload: { selections, showFlag: true },
                  }));
                }
              });
            });
          }}
          options={{
            readOnly: isClientApp,
            contextmenu: !isClientApp,
            hover: { enabled: !isClientApp },
            links: !isClientApp,
            quickSuggestions: !isClientApp,
            parameterHints: { enabled: !isClientApp },
            automaticLayout: true,
            fontFamily: codeFont,
            fontSize: DEFAULT_FONT_SIZE,
            lineHeight: 28,
            padding: { top: 8, bottom: 16 },
            lineNumbersMinChars: 4,
            glyphMargin: false,
            folding: false,
            disableMonospaceOptimizations: true,
            fontLigatures: false,
            wordWrap: 'on',
            wrappingStrategy: 'advanced',
            minimap: { enabled: false },
            stickyScroll: { enabled: false },
            renderLineHighlight: 'none',
            overviewRulerBorder: false,
            scrollBeyondLastLine: false,
            scrollbar: {
              vertical: 'visible',
              horizontal: 'auto',
              verticalScrollbarSize: 10,
              horizontalScrollbarSize: 10,
              alwaysConsumeMouseWheel: false,
            },
          }}
        />
        </div>
      </div>

      {/* 底部栏：连接状态 + 在线成员（桌面端同样支持按住拖拽） */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '8px 16px', background: barBg, flexShrink: 0,
        borderTop: '1px solid rgba(255, 255, 255, 0.08)', fontSize: '13px',
        WebkitAppRegion: isClientApp ? 'drag' : 'no-drag',
        cursor: isClientApp ? 'grab' : 'default',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          background: 'rgba(34, 34, 34, 0.7)', padding: '3px 10px', borderRadius: '14px', fontSize: '12px', color: '#aaa',
        }}>
          <span>Wss:</span>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: wsConnected ? '#10b981' : '#ef4444' }} />
        </div>

        {authFail && <span style={{ color: '#ef4444', fontSize: '12px' }}>房间凭证无效</span>}
        {destroyedMsg && <span style={{ color: '#ef4444', fontSize: '12px' }}>{destroyedMsg}</span>}

        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          {participants.map((p, idx) => {
            const isMe = p.id && p.id === myClientIdRef.current;
            return (
              <div
                key={p.id || idx}
                style={{ display: 'flex', alignItems: 'center', gap: '6px', WebkitAppRegion: 'no-drag' }}
              >
                <span style={{ width: '12px', height: '12px', borderRadius: '3px', background: p.color || '#00bcd4' }} />
                {isMe && editingName ? (
                  <input
                    autoFocus
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onBlur={() => {
                      if (!commitNameChange(nameDraft)) setEditingName(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitNameChange(nameDraft);
                      if (e.key === 'Escape') setEditingName(false);
                    }}
                    placeholder="输入你的名字"
                    style={{
                      background: '#1e293b', color: '#f8fafc', border: '1px solid #10b981',
                      borderRadius: '4px', padding: '1px 6px', fontSize: '12px', width: '96px', outline: 'none',
                    }}
                  />
                ) : (
                  <span
                    onClick={() => {
                      if (isMe) {
                        setNameDraft(userName);
                        setEditingName(true);
                      }
                    }}
                    title={isMe ? '点击修改你的名字' : p.name}
                    style={{
                      color: '#e5e5e5',
                      fontWeight: 500,
                      cursor: isMe ? 'pointer' : 'default',
                      borderBottom: isMe ? '1px dashed rgba(148, 163, 184, 0.45)' : 'none',
                    }}
                  >
                    {p.name}{isMe ? ' (我)' : ''}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 客户端版本更新详情与下载弹窗 */}
      {showUpdateModal && updateInfo && (
        <UpdateModal
          updateInfo={updateInfo}
          onClose={() => setShowUpdateModal(false)}
        />
      )}
    </div>
  );
}

// ── 导师端选中文本局部字号放大缩小控件：仅对当前选中的文字放大/缩小/重置，不影响未选中内容 ──
function SelectionSizeControl({ fontSize, hasSelection, onAdjust }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '3px',
        background: 'rgba(15, 23, 34, 0.65)',
        border: `1px solid ${hasSelection ? 'rgba(16, 185, 129, 0.55)' : '#334155'}`,
        borderRadius: '6px',
        padding: '2px 5px',
        WebkitAppRegion: 'no-drag',
      }}
      title={`先选中部分文字，再点 A- / A+ 缩小或放大选中文字（${modKey}- 缩小 · ${modKey}+ 放大 · 点击数字或 ${modKey}0 恢复默认 ${DEFAULT_FONT_SIZE}px）`}
    >
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onAdjust(-2)}
        title={`缩小选中文字 (${modKey}-)`}
        style={{
          background: 'transparent',
          color: hasSelection ? '#34d399' : '#cbd5e1',
          border: 'none',
          borderRadius: '4px',
          padding: '1px 5px',
          fontSize: '11.5px',
          fontWeight: 600,
          cursor: 'pointer',
          lineHeight: 1.2,
        }}
      >
        A-
      </button>
      <span
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onAdjust(0)}
        title={`当前选区字号 ${fontSize}px，点击将选中文字恢复默认 ${DEFAULT_FONT_SIZE}px`}
        style={{
          fontSize: '11px',
          fontFamily: codeFont,
          color: String(fontSize) !== String(DEFAULT_FONT_SIZE) ? '#34d399' : (hasSelection ? '#e2e8f0' : '#94a3b8'),
          minWidth: '22px',
          padding: '0 2px',
          textAlign: 'center',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        {fontSize}
      </span>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onAdjust(2)}
        title={`放大选中文字 (${modKey}+)`}
        style={{
          background: 'transparent',
          color: hasSelection ? '#34d399' : '#cbd5e1',
          border: 'none',
          borderRadius: '4px',
          padding: '1px 5px',
          fontSize: '11.5px',
          fontWeight: 700,
          cursor: 'pointer',
          lineHeight: 1.2,
        }}
      >
        A+
      </button>
    </div>
  );
}

// ── 导师端选中文本局部字色选择器：仅对当前选中的文字着色或清除，不影响未选中内容 ──
function SelectionColorPicker({ pickerColor, hasSelection, onApplyColor }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        background: 'rgba(15, 23, 34, 0.65)',
        border: `1px solid ${hasSelection ? 'rgba(16, 185, 129, 0.55)' : '#334155'}`,
        borderRadius: '6px',
        padding: '3px 7px',
        WebkitAppRegion: 'no-drag',
      }}
      title="先在编辑器中选中部分文字，再点击色点为选中内容改色（最左侧彩点清除选中色，最右侧自由取色）"
    >
      <span style={{ fontSize: '11.5px', color: hasSelection ? '#34d399' : '#94a3b8', fontWeight: 500, marginRight: '2px' }}>
        选中字色
      </span>
      {FONT_COLOR_PRESETS.map((preset) => (
        <button
          key={preset.label}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onApplyColor(preset.value)}
          title={preset.label}
          style={{
            width: '14px',
            height: '14px',
            borderRadius: '50%',
            padding: 0,
            background: preset.swatch,
            border: '1px solid rgba(255,255,255,0.4)',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        />
      ))}
      <label
        title="为选中文字自定义任意颜色"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '16px',
          height: '16px',
          cursor: 'pointer',
          position: 'relative',
          marginLeft: '1px',
        }}
      >
        <input
          type="color"
          value={pickerColor && /^#[0-9a-fA-F]{6}$/.test(pickerColor) ? pickerColor : '#34d399'}
          onChange={(e) => onApplyColor(e.target.value)}
          style={{
            opacity: 0,
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            cursor: 'pointer',
            border: 'none',
            padding: 0,
          }}
        />
        <span
          style={{
            fontSize: '11px',
            lineHeight: 1,
            color: pickerColor || '#94a3b8',
            fontWeight: 700,
            borderBottom: `2px solid ${pickerColor || '#94a3b8'}`,
          }}
        >
          A
        </span>
      </label>
    </div>
  );
}

// ── 更新详情弹窗：展示最新版本号、更新日志与 1 秒极速热更新（免下载 98MB 安装包） ──
function UpdateModal({ updateInfo, onClose }) {
  const platformLabel = isWindows ? 'Windows (.exe)' : 'macOS (.dmg)';
  const primaryUrl = updateInfo.downloadUrl || (isWindows ? updateInfo.winUrl : updateInfo.macUrl) || '';
  const canHotUpdate = Boolean(window.electronAPI?.applyHotUpdate);
  const canInAppUpdate = Boolean(window.electronAPI?.downloadAndInstallUpdate && primaryUrl);

  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState({ stage: '', percent: 0, message: '' });
  const [updateErr, setUpdateErr] = useState('');

  useEffect(() => {
    if (!window.electronAPI?.onUpdateProgress) return;
    const off = window.electronAPI.onUpdateProgress((data) => {
      if (!data) return;
      setProgress({
        stage: data.stage || '',
        percent: typeof data.percent === 'number' ? data.percent : 0,
        message: data.message || '',
      });
      if (data.stage === 'error') {
        setUpdating(false);
        setUpdateErr(data.message || '自动更新失败，请使用浏览器下载');
      }
    });
    return () => off?.();
  }, []);

  // 1 秒极速热更新（直接走 Railway 高速节点同步最新前端代码，不走 GitHub 98MB 慢速整包下载）
  const handleStartAutoUpdate = async () => {
    if (updating) return;
    if (canHotUpdate) {
      setUpdating(true);
      setUpdateErr('');
      setProgress({ stage: 'downloading', percent: 35, message: '正在从 Railway 高速节点极速热更新…' });
      localStorage.setItem('pad_hot_version', updateInfo.latestVersion || '');
      const res = await window.electronAPI.applyHotUpdate(updateInfo.latestVersion);
      if (res?.ok) {
        setTimeout(() => onClose?.(), 350);
        return;
      }
      setUpdating(false);
      setUpdateErr(res?.error || '极速热更新失败，请点击下方安装包更新');
      return;
    }

    if (!primaryUrl) return;
    if (!canInAppUpdate) {
      openDownloadUrl(primaryUrl);
      return;
    }
    setUpdating(true);
    setUpdateErr('');
    setProgress({ stage: 'downloading', percent: 0, message: '正在连接更新服务器…' });
    const res = await window.electronAPI.downloadAndInstallUpdate(primaryUrl);
    if (!res?.ok) {
      setUpdating(false);
      setUpdateErr(res?.error || '自动更新失败，请点击下方浏览器下载');
    }
  };

  // 完整安装包覆盖更新（仅当底层 Electron 壳变动或用户主动需要重装整包时使用）
  const handleFullInstallerUpdate = async () => {
    if (!primaryUrl || updating) return;
    if (!canInAppUpdate) {
      openDownloadUrl(primaryUrl);
      return;
    }
    setUpdating(true);
    setUpdateErr('');
    setProgress({ stage: 'downloading', percent: 0, message: '正在下载完整安装包…' });
    const res = await window.electronAPI.downloadAndInstallUpdate(primaryUrl);
    if (!res?.ok) {
      setUpdating(false);
      setUpdateErr(res?.error || '完整包下载失败，正在打开浏览器下载…');
      openDownloadUrl(primaryUrl);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.65)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '20px', fontFamily: uiFont, WebkitAppRegion: 'no-drag',
      }}
      onClick={() => { if (!updateInfo.forceUpdate && !updating) onClose(); }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: '430px', background: '#121721',
          border: '1px solid rgba(56, 189, 248, 0.4)', borderRadius: '12px',
          padding: '20px', color: '#e2e8f0', boxShadow: '0 20px 50px rgba(0,0,0,0.6)',
          display: 'flex', flexDirection: 'column', gap: '14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BrandLogo size={28} />
            <div>
              <div style={{ fontSize: '15px', fontWeight: 700, color: '#f8fafc' }}>
                发现 GlassPad 新版本 v{updateInfo.latestVersion}
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '2px' }}>
                当前版本 v{updateInfo.currentVersion} → 最新版本 v{updateInfo.latestVersion}
              </div>
            </div>
          </div>
          {!updateInfo.forceUpdate && !updating && (
            <button
              onClick={onClose}
              style={{
                background: 'transparent', border: 'none', color: '#64748b',
                fontSize: '16px', cursor: 'pointer', padding: '4px',
              }}
            >
              ✕
            </button>
          )}
        </div>

        {updateInfo.notes ? (
          <div style={{
            background: '#0b0e13', border: '1px solid #2b3445', borderRadius: '8px',
            padding: '10px 12px', fontSize: '12.5px', color: '#cbd5e1',
            lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: '150px', overflowY: 'auto',
          }}>
            {updateInfo.notes}
          </div>
        ) : (
          <div style={{ fontSize: '12.5px', color: '#94a3b8' }}>
            包含性能优化、防截屏稳定性提升与最新功能更新，建议立即升级。
          </div>
        )}

        {/* 软件内静默下载进度条 */}
        {(updating || progress.stage === 'downloading' || progress.stage === 'installing') && (
          <div style={{
            background: '#0b0e13', border: '1px solid #1e293b', borderRadius: '8px',
            padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#38bdf8' }}>
              <span>{progress.message || '正在下载更新…'}</span>
              <span style={{ fontFamily: codeFont }}>{progress.percent}%</span>
            </div>
            <div style={{
              width: '100%', height: '6px', background: '#1e293b',
              borderRadius: '999px', overflow: 'hidden',
            }}>
              <div style={{
                width: `${Math.max(2, Math.min(100, progress.percent || 0))}%`,
                height: '100%', background: 'linear-gradient(90deg, #10b981, #38bdf8)',
                transition: 'width 0.15s ease',
              }} />
            </div>
          </div>
        )}

        {updateErr && (
          <div style={{ fontSize: '12px', color: '#f87171', lineHeight: 1.4 }}>
            {updateErr}
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: '4px' }}>
          {!updateInfo.forceUpdate && !updating && (
            <button
              onClick={onClose}
              style={{
                background: '#1e2636', color: '#cbd5e1', border: '1px solid #334155',
                borderRadius: '7px', padding: '8px 14px', fontSize: '12.5px', cursor: 'pointer',
              }}
            >
              稍后提醒
            </button>
          )}

          {primaryUrl && (canHotUpdate || canInAppUpdate) && (
            <button
              onClick={handleFullInstallerUpdate}
              disabled={updating}
              style={{
                background: 'transparent', color: '#94a3b8', border: '1px solid #334155',
                borderRadius: '7px', padding: '8px 12px', fontSize: '12px', cursor: 'pointer',
              }}
            >
              完整安装包更新
            </button>
          )}

          {(canHotUpdate || primaryUrl) ? (
            <button
              onClick={handleStartAutoUpdate}
              disabled={updating}
              style={{
                background: updating ? '#065f46' : '#10b981',
                color: updating ? '#a7f3d0' : '#032219',
                border: 'none',
                borderRadius: '7px', padding: '8px 16px', fontSize: '13px',
                fontWeight: 700, cursor: updating ? 'default' : 'pointer',
              }}
            >
              {updating
                ? (progress.stage === 'installing' ? '正在刷新生效…' : `正在更新 (${progress.percent}%)…`)
                : (canHotUpdate
                  ? '⚡ 1 秒极速热更新'
                  : (canInAppUpdate ? '立即自动更新并重启' : `立即下载 ${platformLabel} ↗`))}
            </button>
          ) : (
            <span style={{ fontSize: '12px', color: '#f59e0b', alignSelf: 'center' }}>
              管理员暂未配置当前平台下载链接
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// 解析邀请链接：提取 room / token / user / wsOrigin
function parseLink(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    const room = u.searchParams.get('room');
    const token = u.searchParams.get('token');
    const wsOrigin = (u.protocol === 'http:' || u.protocol === 'https:')
      ? `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`
      : '';
    if (room && token) return { room, token, user: u.searchParams.get('user'), wsOrigin };
  } catch {
    const m = s.match(/room=([^&\s]+).*token=([^&\s]+)/);
    if (m) return { room: m[1], token: m[2], user: null, wsOrigin: '' };
  }
  return null;
}

// ── 进入 Pad 前输入个人名字（当已通过 URL 拿到 room+token，但尚未填写个人名字时显示）──
function NameGate({
  roomId,
  onSubmit,
  appVersion,
  updateInfo,
  checkingUpdate,
  updateBannerText,
  onCheckUpdate,
  onOpenUpdateModal,
}) {
  const [name, setName] = useState(() => normalizeCustomName(localStorage.getItem('pad_user_name')) || '');
  const [error, setError] = useState('');

  const handleConfirm = () => {
    const clean = normalizeCustomName(name);
    if (!clean) {
      setError('请输入你的名字（不能使用默认的 Client / Mentor / Candidate）');
      return;
    }
    onSubmit(clean);
  };

  return (
    <div style={{
      height: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: '14px',
      background: '#0d0d0d', color: '#e5e5e5', fontFamily: uiFont, padding: '20px',
      position: 'relative',
      WebkitAppRegion: isClientApp ? 'drag' : 'no-drag',
    }}>
      {isClientApp && (
        <div style={{
          position: 'absolute', top: '14px', right: '18px',
          display: 'flex', alignItems: 'center', gap: '10px',
          WebkitAppRegion: 'no-drag',
        }}>
          {updateBannerText && (
            <span style={{ color: '#34d399', fontSize: '12px' }}>{updateBannerText}</span>
          )}
          <span style={{ color: '#64748b', fontSize: '12px', fontFamily: codeFont }}>
            v{appVersion || '1.0.0'}
          </span>
          <button
            onClick={() => (updateInfo?.hasUpdate ? onOpenUpdateModal?.() : onCheckUpdate?.())}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              background: updateInfo?.hasUpdate ? 'rgba(56, 189, 248, 0.18)' : '#1a1a1a',
              color: updateInfo?.hasUpdate ? '#38bdf8' : '#cbd5e1',
              border: `1px solid ${updateInfo?.hasUpdate ? 'rgba(56, 189, 248, 0.5)' : '#333'}`,
              borderRadius: '6px', padding: '5px 11px', fontSize: '12px', fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {updateInfo?.hasUpdate && (
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#38bdf8' }} />
            )}
            {checkingUpdate
              ? '检查中…'
              : updateInfo?.hasUpdate
                ? `发现新版本 v${updateInfo.latestVersion}`
                : '检查更新'}
          </button>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '2px' }}>
        <BrandLogo size={38} />
        <div>
          <div style={{ fontSize: '20px', fontWeight: 700, letterSpacing: '0.3px', color: '#f8fafc' }}>GlassPad</div>
          <div style={{ fontSize: '12px', color: '#10b981', fontWeight: 500 }}>
            进入房间 #{roomId}
          </div>
        </div>
      </div>

      <div style={{ color: '#9ca3af', fontSize: '13px' }}>
        请输入你的名字（点击编辑器任意位置时，其他成员会看到你的名字标签）
      </div>

      <input
        autoFocus
        value={name}
        onChange={(e) => { setName(e.target.value); setError(''); }}
        onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm(); }}
        placeholder="输入你的名字，例如：Alex / 张三"
        style={{
          width: '100%', maxWidth: 340, background: '#1f1f1f', border: '1px solid #333',
          borderRadius: '8px', color: '#e5e5e5', padding: '12px 14px', fontSize: '13.5px',
          outline: 'none', WebkitAppRegion: 'no-drag',
        }}
      />

      <button
        onClick={handleConfirm}
        style={{
          background: '#10b981', color: '#04281f', border: 'none', borderRadius: '6px',
          padding: '10px 28px', fontSize: '14px', fontWeight: 600, cursor: 'pointer',
          WebkitAppRegion: 'no-drag',
        }}
      >
        进入 Pad
      </button>

      {error && <div style={{ color: '#ef4444', fontSize: '13px' }}>{error}</div>}
    </div>
  );
}

// ── 加入入口：客户粘贴导师发的邀请链接 + 输入自己的名字 ──
function JoinGate({
  onJoin,
  initialName,
  appVersion,
  updateInfo,
  checkingUpdate,
  updateBannerText,
  onCheckUpdate,
  onOpenUpdateModal,
}) {
  const [input, setInput] = useState('');
  const [name, setName] = useState(() => normalizeCustomName(initialName) || normalizeCustomName(localStorage.getItem('pad_user_name')) || '');
  const [error, setError] = useState('');

  const tryJoin = (value, customName = name) => {
    const parsed = parseLink(value);
    if (!parsed) {
      setError('链接无效，请粘贴完整的邀请链接');
      return;
    }
    const cleanName = normalizeCustomName(customName) || normalizeCustomName(parsed.user);
    if (!cleanName) {
      setError('请先在上方输入你的名字');
      return;
    }
    onJoin(parsed.room, parsed.token, cleanName, parsed.wsOrigin);
  };

  const pasteFromClipboard = async () => {
    try {
      const value = window.electronAPI?.readClipboardText
        ? await window.electronAPI.readClipboardText()
        : await navigator.clipboard.readText();
      setInput(value);
      tryJoin(value, name);
    } catch {
      setError('无法读取剪贴板，请手动粘贴');
    }
  };

  return (
    <div style={{
      height: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: '12px',
      background: '#0d0d0d', color: '#e5e5e5', fontFamily: uiFont, padding: '20px',
      position: 'relative',
      WebkitAppRegion: isClientApp ? 'drag' : 'no-drag',
    }}>
      {/* 右上角：当前版本与检查更新入口 */}
      {isClientApp && (
        <div style={{
          position: 'absolute', top: '14px', right: '18px',
          display: 'flex', alignItems: 'center', gap: '10px',
          WebkitAppRegion: 'no-drag',
        }}>
          {updateBannerText && (
            <span style={{ color: '#34d399', fontSize: '12px' }}>{updateBannerText}</span>
          )}
          <span style={{ color: '#64748b', fontSize: '12px', fontFamily: codeFont }}>
            v{appVersion || '1.0.0'}
          </span>
          <button
            onClick={() => (updateInfo?.hasUpdate ? onOpenUpdateModal?.() : onCheckUpdate?.())}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              background: updateInfo?.hasUpdate ? 'rgba(56, 189, 248, 0.18)' : '#1a1a1a',
              color: updateInfo?.hasUpdate ? '#38bdf8' : '#cbd5e1',
              border: `1px solid ${updateInfo?.hasUpdate ? 'rgba(56, 189, 248, 0.5)' : '#333'}`,
              borderRadius: '6px', padding: '5px 11px', fontSize: '12px', fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {updateInfo?.hasUpdate && (
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#38bdf8' }} />
            )}
            {checkingUpdate
              ? '检查中…'
              : updateInfo?.hasUpdate
                ? `发现新版本 v${updateInfo.latestVersion}`
                : '检查更新'}
          </button>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '2px' }}>
        <BrandLogo size={38} />
        <div>
          <div style={{ fontSize: '20px', fontWeight: 700, letterSpacing: '0.3px', color: '#f8fafc' }}>GlassPad</div>
          <div style={{ fontSize: '12px', color: '#10b981', fontWeight: 500 }}>加入实时提词房间</div>
        </div>
      </div>
      <div style={{ color: '#9ca3af', fontSize: '13px' }}>输入你的名字并粘贴邀请链接即可加入</div>

      <input
        value={name}
        onChange={(e) => { setName(e.target.value); setError(''); }}
        placeholder="你的名字（例如：Alex / 张三）"
        style={{
          width: '100%', maxWidth: 420, background: '#1f1f1f', border: '1px solid #333',
          borderRadius: '8px', color: '#e5e5e5', padding: '11px 14px', fontSize: '13px',
          outline: 'none', WebkitAppRegion: 'no-drag',
        }}
      />

      <input
        value={input}
        onChange={(e) => { setInput(e.target.value); setError(''); }}
        onPaste={(e) => {
          const pasted = e.clipboardData?.getData('text');
          if (pasted) {
            e.preventDefault();
            setInput(pasted);
            setError('');
            tryJoin(pasted, name);
          }
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') tryJoin(input, name); }}
        placeholder="https://.../?room=xxxx&token=xxxx"
        style={{
          width: '100%', maxWidth: 420, background: '#1f1f1f', border: '1px solid #333',
          borderRadius: '8px', color: '#e5e5e5', padding: '12px 14px', fontSize: '13px',
          outline: 'none', fontFamily: codeFont, WebkitAppRegion: 'no-drag',
        }}
      />

      <div style={{ display: 'flex', gap: '10px', WebkitAppRegion: 'no-drag' }}>
        <button
          onClick={pasteFromClipboard}
          style={{
            background: '#10b981', color: '#04281f', border: 'none', borderRadius: '6px',
            padding: '10px 20px', fontSize: '14px', fontWeight: 600, cursor: 'pointer',
          }}
        >
          从剪贴板粘贴并加入
        </button>
        <button
          onClick={() => tryJoin(input, name)}
          style={{
            background: '#1f1f1f', color: '#d4d4d4', border: '1px solid #333', borderRadius: '6px',
            padding: '10px 16px', fontSize: '13px', cursor: 'pointer',
          }}
        >
          加入
        </button>
      </div>

      {error && <div style={{ color: '#ef4444', fontSize: '13px' }}>{error}</div>}
    </div>
  );
}
