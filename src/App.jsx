import React, { useState, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';

// 客户 App（Electron）只读；导师用网页版可编辑
const isClientApp = Boolean(window.electronAPI?.isDesktop);
const isWindows = window.electronAPI?.platform === 'win32' || /Win/i.test(navigator.platform || '');
const modKey = isWindows ? 'Ctrl+' : '⌘';
const uiFont = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif';
const codeFont = 'ui-monospace, SFMono-Regular, "Cascadia Code", Consolas, Menlo, "Microsoft YaHei UI", monospace';

const normalizeLF = (s) => (s || '').replace(/\r\n/g, '\n');

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
    () => params.get('user') || (isClientApp ? 'Client' : 'Mentor')
  );

  // 桌面端外观：透明度（调低可透视下方浏览器）/ 毛玻璃（默认关闭）
  const [opacity, setOpacity] = useState(() => Number(localStorage.getItem('pad_opacity')) || 0.78);
  const [supportsFrost, setSupportsFrost] = useState(false);
  const [frostedGlass, setFrostedGlass] = useState(() => localStorage.getItem('pad_frost_v2') === 'true');

  const [text, setText] = useState('');
  const [language, setLanguage] = useState('python');
  const [wsConnected, setWsConnected] = useState(false);
  const [authFail, setAuthFail] = useState(false);
  const [destroyedMsg, setDestroyedMsg] = useState('');
  const [participants, setParticipants] = useState([]);

  const wsRef = useRef(null);
  const editorRef = useRef(null);
  const isRemote = useRef(false);
  const remoteSelDecorations = useRef(null); // 对方选区的高亮装饰集合
  const latestText = useRef(''); // 最近收到的远端文字（编辑器挂载前到达时用于补写）

  // 桌面端：检测系统是否支持毛玻璃
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    api.getFrostSupport?.().then((res) => {
      const ok = Boolean(res?.supportsFrostedGlass);
      setSupportsFrost(ok);
      api.setFrostedGlass(ok && frostedGlass);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 桌面端：透明度记忆 + ⌘[ / ⌘] 调节
  useEffect(() => {
    localStorage.setItem('pad_opacity', String(opacity));
  }, [opacity]);

  useEffect(() => {
    if (!isClientApp) return;
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '[') {
        e.preventDefault();
        setOpacity((p) => Math.max(0.08, Number((p - 0.08).toFixed(2))));
      } else if (e.key === ']') {
        e.preventDefault();
        setOpacity((p) => Math.min(1, Number((p + 0.08).toFixed(2))));
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

  // WebSocket 实时同步
  useEffect(() => {
    if (!token) return;
    setAuthFail(false);
    setDestroyedMsg('');

    // 房间参数留在地址栏，⌘R 刷新后仍在同一房间
    const extraWs = wsBase ? `&ws=${encodeURIComponent(wsBase)}` : '';
    window.history.replaceState({}, '', `${window.location.pathname}?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}&user=${encodeURIComponent(userName)}${extraWs}`);

    const defaultWsUrl = window.location.protocol === 'file:'
      ? 'wss://codex-clone-production.up.railway.app'
      : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
    const wsUrl = wsBase || import.meta.env.VITE_WS_URL || defaultWsUrl;

    let ws;
    let reconnectTimer;
    let closed = false;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(`${wsUrl}/?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}&user=${encodeURIComponent(userName)}`);
      wsRef.current = ws;

      ws.onopen = () => setWsConnected(true);

      ws.onmessage = (e) => {
        const { type, payload } = JSON.parse(e.data);
        if (type === 'AUTH_FAIL') {
          setAuthFail(true);
        } else if (type === 'ROOM_DESTROYED') {
          setDestroyedMsg(payload?.reason || '该房间已被管理员销毁');
          setParticipants([]);
        } else if (type === 'INIT' || type === 'TEXT_SYNC') {
          const clean = normalizeLF(payload.text);
          // 先增量写入编辑器（保留选区），再同步 React 状态
          latestText.current = clean;
          applyRemoteText(clean);
          setText(clean);
          if (payload.language) setLanguage(payload.language);
          if (isClientApp) scrollToBottom();
        } else if (type === 'LANG_SYNC') {
          setLanguage(payload.language);
        } else if (type === 'SEL_SYNC') {
          applyRemoteSelections(payload.selections || []);
        } else if (type === 'PRESENCE') {
          setParticipants(payload);
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
      if (wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({ type: 'PING' }));
      }
    }, 20000);

    return () => {
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [roomId, token, userName, wsBase]);

  // 客户端提词：导师打字超过一屏时自动滚到最新一行
  const scrollToBottom = () => {
    setTimeout(() => {
      const editor = editorRef.current;
      const lineCount = editor?.getModel()?.getLineCount();
      if (lineCount) editor.revealLine(lineCount);
    }, 20);
  };

  // 把对方的选区画成高亮装饰（不影响本地选区）
  const applyRemoteSelections = (selections) => {
    const editor = editorRef.current;
    if (!editor) return;
    if (!remoteSelDecorations.current) {
      remoteSelDecorations.current = editor.createDecorationsCollection();
    }
    remoteSelDecorations.current.set(
      selections
        .filter((s) => s.startLineNumber !== s.endLineNumber || s.startColumn !== s.endColumn)
        .map((s) => ({ range: s, options: { className: 'remote-selection', stickiness: 1 } }))
    );
  };

  // 远端文字增量写入：只替换前后缀之间变化的部分，避免整体 setValue 清掉客户的选区
  const applyRemoteText = (newText) => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    const oldText = model.getValue();
    if (oldText === newText) return;
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
  };

  const sendText = (value) => {
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: 'TEXT_SYNC', payload: { text: value } }));
    }
  };

  const handleTextChange = (val) => {
    if (isClientApp) return; // 客户端只读，不发送
    if (isRemote.current) {
      isRemote.current = false;
      return;
    }
    const clean = normalizeLF(val);
    setText(clean);
    sendText(clean);
  };

  const clearPad = () => {
    setText('');
    sendText('');
  };

  // 无 token：显示「粘贴邀请链接」入口
  if (!token) {
    return (
      <JoinGate
        onJoin={(room, tok, user, wsOrigin) => {
          setRoomId(room);
          setToken(tok);
          if (user) setUserName(user);
          if (wsOrigin) setWsBase(wsOrigin);
        }}
      />
    );
  }

  const bgAlpha = isClientApp ? opacity : 1;
  const frost = isClientApp && supportsFrost && frostedGlass;
  const barBg = `rgba(20, 20, 20, ${Math.min(bgAlpha + 0.08, 1)})`;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      background: `rgba(13, 13, 13, ${bgAlpha})`,
      backdropFilter: frost ? 'blur(14px)' : 'none',
      WebkitBackdropFilter: frost ? 'blur(14px)' : 'none',
      color: '#e5e5e5', fontFamily: uiFont,
      border: '1px solid rgba(255, 255, 255, 0.12)',
      borderRadius: '8px', overflow: 'hidden',
    }}>
      {/* 顶部栏（桌面端整条可按住拖拽移动窗口，右侧控件除外） */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '8px 14px', background: barBg,
        borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
        fontSize: '12.5px', color: '#d1d5db',
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
            }} title="按住顶部栏任意空白处可拖动窗口">
              <BrandLogo size={18} />
              <span style={{ color: '#f1f5f9', fontWeight: 600, marginRight: '2px' }}>GlassPad</span>
              <span style={{ color: '#475569' }}>|</span>
              <span>
                拖拽移动 · {modKey}方向键 移动 · {modKey}B 隐藏/显示 · {modKey}[ {modKey}] 透明度 · {modKey}R 刷新 · {modKey}Q 退出
              </span>
            </div>

            {/* 中间弹性拖拽区 */}
            <div style={{ flex: 1, minWidth: '20px', alignSelf: 'stretch' }} />

            <div style={{
              marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px',
              WebkitAppRegion: 'no-drag', cursor: 'default',
            }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#e2e8f0', fontWeight: 500 }} title={`${modKey}[ / ${modKey}] 调节`}>
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
            <select
              value={language}
              onChange={(e) => {
                const lang = e.target.value;
                setLanguage(lang);
                wsRef.current?.send(JSON.stringify({ type: 'LANG_SYNC', payload: { language: lang } }));
              }}
              style={{
                marginLeft: 'auto', background: 'transparent', color: '#9ca3af',
                border: 'none', fontSize: '13px', outline: 'none', cursor: 'pointer',
              }}
            >
              <option value="python" style={{ background: '#141414' }}>Python</option>
              <option value="plaintext" style={{ background: '#141414' }}>Plain Text (BQ 提词)</option>
              <option value="cpp" style={{ background: '#141414' }}>C++</option>
              <option value="java" style={{ background: '#141414' }}>Java</option>
              <option value="javascript" style={{ background: '#141414' }}>JavaScript</option>
            </select>
          </>
        )}
      </div>

      {/* 提词区（客户端只读） */}
      <div style={{ flex: 1, position: 'relative', paddingTop: '8px' }}>
        <Editor
          height="100%"
          theme="codex-transparent"
          language={language}
          // 客户端不走受控 value（库在只读模式下每次 value 变化都会整体 setValue，清掉选区），
          // 远端文字由 applyRemoteText 增量写入；导师端保持受控
          value={isClientApp ? undefined : text}
          defaultValue={text}
          onChange={handleTextChange}
          beforeMount={(monaco) => {
            monaco.editor.defineTheme('codex-transparent', {
              base: 'vs-dark',
              inherit: true,
              rules: [],
              colors: {
                'editor.background': '#00000000',
                'editorGutter.background': '#00000000',
                'editor.lineHighlightBackground': '#00000000',
                'scrollbarSlider.background': '#ffffff22',
                'editor.selectionBackground': '#1e5aa8',
                'editor.inactiveSelectionBackground': '#1e5aa8',
              },
            });
          }}
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            // WS 的 INIT 可能早于 Monaco 加载完成到达，挂载时补写最新文字
            if (isClientApp && latestText.current) applyRemoteText(latestText.current);
            monaco.editor.setTheme('codex-transparent');
            editor.getModel()?.setEOL(monaco.editor.EndOfLineSequence.LF);
            // 导师端：把自己的选区实时发给客户
            if (!isClientApp) {
              editor.onDidChangeCursorSelection(() => {
                if (wsRef.current?.readyState !== 1) return;
                const selections = editor.getSelections().map((s) => ({
                  startLineNumber: s.startLineNumber,
                  startColumn: s.startColumn,
                  endLineNumber: s.endLineNumber,
                  endColumn: s.endColumn,
                }));
                wsRef.current.send(JSON.stringify({ type: 'SEL_SYNC', payload: { selections } }));
              });
            }
          }}
          options={{
            readOnly: isClientApp,
            fontFamily: codeFont,
            fontSize: 15,
            lineHeight: 24,
            wordWrap: 'on',
            minimap: { enabled: false },
            stickyScroll: { enabled: false },
            renderLineHighlight: 'none',
            overviewRulerBorder: false,
            scrollBeyondLastLine: false,
          }}
        />
      </div>

      {/* 底部栏：连接状态 + 在线成员（桌面端同样支持按住拖拽） */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '8px 16px', background: barBg,
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
          {participants.map((p, idx) => (
            <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '12px', height: '12px', borderRadius: '3px', background: p.color || '#00bcd4' }} />
              <span style={{ color: '#e5e5e5', fontWeight: 500 }}>{p.name}</span>
            </div>
          ))}
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

// ── 加入入口：客户粘贴导师发的邀请链接 ──
function JoinGate({ onJoin }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  const tryJoin = (value) => {
    const parsed = parseLink(value);
    if (!parsed) {
      setError('链接无效，请粘贴完整的邀请链接');
      return;
    }
    onJoin(parsed.room, parsed.token, parsed.user || 'Client', parsed.wsOrigin);
  };

  const pasteFromClipboard = async () => {
    try {
      const value = window.electronAPI?.readClipboardText
        ? await window.electronAPI.readClipboardText()
        : await navigator.clipboard.readText();
      setInput(value);
      tryJoin(value);
    } catch {
      setError('无法读取剪贴板，请手动粘贴');
    }
  };

  return (
    <div style={{
      height: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: '14px',
      background: '#0d0d0d', color: '#e5e5e5', fontFamily: uiFont, padding: '20px',
      WebkitAppRegion: isClientApp ? 'drag' : 'no-drag',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '2px' }}>
        <BrandLogo size={38} />
        <div>
          <div style={{ fontSize: '20px', fontWeight: 700, letterSpacing: '0.3px', color: '#f8fafc' }}>GlassPad</div>
          <div style={{ fontSize: '12px', color: '#10b981', fontWeight: 500 }}>加入实时提词房间</div>
        </div>
      </div>
      <div style={{ color: '#9ca3af', fontSize: '13px' }}>复制导师发的邀请链接，点「从剪贴板粘贴」即可加入</div>

      <input
        value={input}
        onChange={(e) => { setInput(e.target.value); setError(''); }}
        onPaste={(e) => {
          const pasted = e.clipboardData?.getData('text');
          if (pasted) {
            e.preventDefault();
            setInput(pasted);
            setError('');
            tryJoin(pasted);
          }
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') tryJoin(input); }}
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
          从剪贴板粘贴
        </button>
        <button
          onClick={() => tryJoin(input)}
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
