import React, { useState, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';

export default function App() {
  const params = new URLSearchParams(window.location.search);

  // 判断是否桌面应用端（客户 App 强制只读；导师用网页版可编辑）
  const isClientApp = Boolean(window.electronAPI?.isDesktop);

  const [roomId, setRoomId] = useState(
    () => params.get('room') || localStorage.getItem('pad_room') || '1024'
  );
  const [roomInput, setRoomInput] = useState(roomId);

  // 邀请 token（管理员建房后随链接下发；缺失则无法进入房间）
  const [token, setToken] = useState(() => params.get('token') || '');

  const [userName, setUserName] = useState(
    () => params.get('user') || localStorage.getItem('pad_user') || 'Cstech Cat'
  );

  // 透明度状态（默认 0.78，配合毛玻璃质感最佳）
  const [opacity, setOpacity] = useState(
    () => Number(localStorage.getItem('pad_opacity')) || 0.78
  );

  // Frosted Glass（毛玻璃）支持状态与开关
  const [supportsFrost, setSupportsFrost] = useState(true);
  const [frostedGlass, setFrostedGlass] = useState(
    () => localStorage.getItem('pad_frost') !== 'false'
  );

  const [text, setText] = useState('');
  const [language, setLanguage] = useState('python');
  const [wsConnected, setWsConnected] = useState(false);
  const [participants, setParticipants] = useState([]);
  const [copied, setCopied] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [authFail, setAuthFail] = useState(false);
  // 鼠标穿透状态（仅桌面 App 端生效）
  const [clickThrough, setClickThrough] = useState(false);

  const wsRef = useRef(null);
  const editorRef = useRef(null);
  const isRemote = useRef(false);

  // 1. 初始化检测系统是否支持原生毛玻璃（Win10 自动隐藏开关并关闭）
  useEffect(() => {
    if (window.electronAPI?.getFrostSupport) {
      window.electronAPI.getFrostSupport().then((res) => {
        if (!res.supportsFrostedGlass) {
          setSupportsFrost(false);
          setFrostedGlass(false);
          window.electronAPI.setFrostedGlass(false);
        } else {
          setSupportsFrost(true);
          window.electronAPI.setFrostedGlass(frostedGlass);
        }
      });
    }
    // 监听主进程 ⌘+M 快捷键触发的穿透状态变化
    if (window.electronAPI?.onClickThroughChanged) {
      window.electronAPI.onClickThroughChanged((val) => setClickThrough(val));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2. 切换毛玻璃开关并同步给 Electron 主进程与本地存储
  const toggleFrostedGlass = (enabled) => {
    setFrostedGlass(enabled);
    localStorage.setItem('pad_frost', String(enabled));
    window.electronAPI?.setFrostedGlass?.(enabled);
  };

  // 切换鼠标穿透模式
  const toggleClickThrough = (enabled) => {
    setClickThrough(enabled);
    window.electronAPI?.setClickThrough?.(enabled);
  };

  // 3. 保存透明度并支持 ⌘+[ 和 ⌘+] 快捷键微调
  useEffect(() => {
    localStorage.setItem('pad_opacity', String(opacity));
  }, [opacity]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key === '[') {
          e.preventDefault();
          setOpacity((prev) => Math.max(0.08, Number((prev - 0.08).toFixed(2))));
        } else if (e.key === ']') {
          e.preventDefault();
          setOpacity((prev) => Math.min(1, Number((prev + 0.08).toFixed(2))));
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 4. WebSocket 实时同步
  useEffect(() => {
    // 无 token 不发起连接（客户必须通过邀请链接进入）
    if (!token) {
      setAuthFail(true);
      return;
    }
    setAuthFail(false);

    localStorage.setItem('pad_room', roomId);
    localStorage.setItem('pad_user', userName);

    const newUrl = `${window.location.pathname}?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}&user=${encodeURIComponent(userName)}`;
    window.history.replaceState({}, '', newUrl);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = import.meta.env.VITE_WS_URL || `${protocol}//${window.location.host}`;

    let ws;
    let reconnectTimer;
    let isUnmounted = false;

    const connect = () => {
      if (isUnmounted) return;
      ws = new WebSocket(`${wsUrl}/?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}&user=${encodeURIComponent(userName)}`);
      wsRef.current = ws;

      ws.onopen = () => setWsConnected(true);

      ws.onmessage = (e) => {
        const { type, payload } = JSON.parse(e.data);
        if (type === 'AUTH_FAIL') {
          setAuthFail(true);
          setWsConnected(false);
          return;
        }
        if (type === 'INIT' || type === 'TEXT_SYNC') {
          isRemote.current = true;
          const cleanText = (payload.text || '').replace(/\r\n/g, '\n');
          setText(cleanText);
          if (payload.language) setLanguage(payload.language);

          if (autoScroll && editorRef.current) {
            setTimeout(() => {
              const lineCount = editorRef.current.getModel()?.getLineCount() || 1;
              editorRef.current.revealLine(lineCount);
            }, 20);
          }
        } else if (type === 'LANG_SYNC') {
          setLanguage(payload.language);
        } else if (type === 'PRESENCE') {
          setParticipants(payload);
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        if (!isUnmounted) {
          reconnectTimer = setTimeout(connect, 1500);
        }
      };
    };

    connect();

    const heartbeat = setInterval(() => {
      if (wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({ type: 'PING' }));
      }
    }, 20000);

    return () => {
      isUnmounted = true;
      clearInterval(heartbeat);
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [roomId, userName, autoScroll, token]);

  const handleTextChange = (val) => {
    // 客户端 App 只读，直接拦截任何文本发送逻辑
    if (isClientApp) return;
    if (isRemote.current) {
      isRemote.current = false;
      return;
    }
    const cleanText = (val || '').replace(/\r\n/g, '\n');
    setText(cleanText);
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({
        type: 'TEXT_SYNC',
        payload: { text: cleanText },
      }));
    }
  };

  const applyRoomSwitch = (e) => {
    e.preventDefault();
    const trimmed = roomInput.trim();
    if (trimmed && trimmed !== roomId) {
      setText('// Switching room...');
      setRoomId(trimmed);
    }
  };

  const clearPad = () => {
    if (isClientApp) return; // 客户端不可清屏
    setText('');
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({
        type: 'TEXT_SYNC',
        payload: { text: '' },
      }));
    }
  };

  // 无 token：显示「粘贴邀请链接」入口（客户把导师发的链接粘进来即可加入）
  if (!token) {
    return <JoinGate onJoin={(room, tok, user) => {
      setRoomId(room);
      setRoomInput(room);
      setToken(tok);
      if (user) setUserName(user);
    }} />;
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      // 动态透明度底色 + CSS 毛玻璃模糊双重加持
      background: `rgba(13, 13, 13, ${opacity})`,
      backdropFilter: supportsFrost && frostedGlass ? 'blur(14px)' : 'none',
      WebkitBackdropFilter: supportsFrost && frostedGlass ? 'blur(14px)' : 'none',
      color: '#e5e5e5', fontFamily: 'monospace',
      border: `1px solid ${clickThrough ? 'rgba(16, 185, 129, 0.4)' : `rgba(255, 255, 255, ${Math.min(opacity * 0.18, 0.15)})`}`,
      borderRadius: '8px', overflow: 'hidden',
    }}>
      {/* 顶部栏 */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        flexWrap: 'wrap', gap: '8px',
        padding: '8px 14px',
        background: `rgba(20, 20, 20, ${Math.min(opacity + 0.08, 1)})`,
        borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
      }}>
        {/* 移动窗口提示：不设拖拽（拖拽会激活应用触发切屏检测），改用 ⌘+方向键移动 */}
        <div style={{
          padding: '4px 10px', margin: '-4px 0', userSelect: 'none',
          color: '#666', fontSize: '14px', lineHeight: 1.2,
          borderRight: '1px solid rgba(255,255,255,0.06)',
          display: 'flex', alignItems: 'center', gap: '6px',
        }} title="移动窗口：⌘ + 方向键">
          <span style={{ fontSize: '16px' }}>⠿</span>
          <span style={{ fontSize: '11px', color: '#888' }}>⌘+方向键移动</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', WebkitAppRegion: 'no-drag' }}>
        <button style={{
          background: '#e5e5e5', color: '#111', border: 'none', borderRadius: '6px',
          padding: '5px 12px', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: '6px',
        }}>
            Run <span style={{ fontSize: '11px' }}>▷</span>
          </button>

          <form onSubmit={applyRoomSwitch} style={{
            display: 'flex', alignItems: 'center', background: 'rgba(31, 31, 31, 0.7)',
            border: '1px solid #333', borderRadius: '6px', padding: '2px 8px',
          }}>
            <span style={{ fontSize: '12px', color: '#777', marginRight: '6px' }}>Room:</span>
            <input
              value={roomInput}
              onChange={(e) => setRoomInput(e.target.value)}
              onBlur={applyRoomSwitch}
              placeholder="Room ID"
              style={{
                background: 'transparent', border: 'none', color: '#10b981',
                fontWeight: 600, fontSize: '13px', width: '56px', outline: 'none', fontFamily: 'monospace',
              }}
            />
          </form>

          {/* 仅网页端导师显示 Clear 清屏按钮，防止客户误触 */}
          {!isClientApp && (
            <button
              onClick={clearPad}
              style={{
                background: 'rgba(31, 31, 31, 0.7)', color: '#9ca3af', border: '1px solid #333',
                borderRadius: '6px', padding: '4px 8px', fontSize: '12px', cursor: 'pointer',
              }}
            >
              Clear
            </button>
          )}

          {/* 客户端显示穿透模式开关（快捷键 ⌘/Ctrl + M） */}
          {isClientApp && (
            <button
              onClick={() => toggleClickThrough(!clickThrough)}
              title="Press Cmd/Ctrl + M to toggle Click-Through at any time"
              style={{
                background: clickThrough ? 'rgba(16, 185, 129, 0.2)' : 'rgba(31, 31, 31, 0.7)',
                color: clickThrough ? '#10b981' : '#9ca3af',
                border: `1px solid ${clickThrough ? '#10b981' : '#333'}`,
                borderRadius: '6px', padding: '4px 10px', fontSize: '12px', cursor: 'pointer',
              }}
            >
              {clickThrough ? '⚡ Click-Through ON (⌘+M to unlock)' : '🔒 Read-Only | Enable Click-Through (⌘+M)'}
            </button>
          )}
        </div>

        {/* 右侧控制区：透明度滑块 + Frosted Glass 开关 + Auto-Scroll + 语言选择 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', WebkitAppRegion: 'no-drag' }}>
          {/* 透明度滑块 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#9ca3af' }} title="Shortcut: Cmd/Ctrl + [ or ]">
            <span>Opacity: {Math.round(opacity * 100)}%</span>
            <input
              type="range"
              min="0.08"
              max="1"
              step="0.04"
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
              style={{ width: '64px', cursor: 'pointer', accentColor: '#10b981' }}
            />
          </div>

          {/* Frosted Glass 开关（仅支持的系统显示，Win10 自动隐藏） */}
          {supportsFrost && (
            <label style={{
              display: 'flex', alignItems: 'center', gap: '4px',
              fontSize: '12px', color: frostedGlass ? '#10b981' : '#888', cursor: 'pointer',
            }}>
              <input
                type="checkbox"
                checked={frostedGlass}
                onChange={(e) => toggleFrostedGlass(e.target.checked)}
                style={{ accentColor: '#10b981', cursor: 'pointer' }}
              />
              Frosted Glass
            </label>
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: '#888', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              style={{ accentColor: '#10b981', cursor: 'pointer' }}
            />
            Auto-Scroll
          </label>

          <select
            value={language}
            disabled={isClientApp}
            onChange={(e) => {
              const lang = e.target.value;
              setLanguage(lang);
              wsRef.current?.send(JSON.stringify({ type: 'LANG_SYNC', payload: { language: lang } }));
            }}
            style={{
              background: 'transparent', color: '#9ca3af', border: 'none',
              fontSize: '13px', outline: 'none', cursor: isClientApp ? 'default' : 'pointer',
            }}
          >
            <option value="python" style={{ background: '#141414' }}>Python (3.8.1)</option>
            <option value="plaintext" style={{ background: '#141414' }}>Plain Text (BQ 提词)</option>
            <option value="cpp" style={{ background: '#141414' }}>C++ (GCC 9.2)</option>
            <option value="java" style={{ background: '#141414' }}>Java (OpenJDK 13)</option>
            <option value="javascript" style={{ background: '#141414' }}>JavaScript (Node)</option>
          </select>
        </div>
      </div>

      {/* 中间打字提词主区域（客户端只读；穿透时忽略所有鼠标事件） */}
      <div style={{
        flex: 1, position: 'relative', paddingTop: '8px',
        pointerEvents: clickThrough ? 'none' : 'auto',
      }}>
        <Editor
          height="100%"
          theme="codex-transparent"
          language={language}
          value={text}
          onChange={handleTextChange}
          beforeMount={(monaco) => {
            // 将编辑器和行号栏背景设为 #00000000 全透明
            monaco.editor.defineTheme('codex-transparent', {
              base: 'vs-dark',
              inherit: true,
              rules: [],
              colors: {
                'editor.background': '#00000000',
                'editorGutter.background': '#00000000',
                'editor.lineHighlightBackground': '#00000000',
                'scrollbarSlider.background': '#ffffff22',
                // 选中高亮：用高对比度的实心蓝，透明背景下也清晰可见
                'editor.selectionBackground': '#1e5aa8',
                'editor.inactiveSelectionBackground': '#1e5aa8',
                'editor.selectionHighlightBackground': '#2d6fbf',
                'editor.selectionHighlightBorder': '#58a6ff',
              },
            });
          }}
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            monaco.editor.setTheme('codex-transparent');
            editor.getModel()?.setEOL(monaco.editor.EndOfLineSequence.LF);
            // 兜底：直接注入 CSS 覆盖选中高亮，确保任何主题/焦点状态下都可见
            const styleId = 'codex-selection-style';
            if (!document.getElementById(styleId)) {
              const style = document.createElement('style');
              style.id = styleId;
              style.textContent = `
                .monaco-editor .selected-text {
                  background-color: #1e5aa8 !important;
                }
                .monaco-editor .focused .selected-text {
                  background-color: #1e5aa8 !important;
                }
              `;
              document.head.appendChild(style);
            }
          }}
          options={{
            readOnly: isClientApp,            // 客户端强制只读（仍可选中文字查看高亮）
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

      {/* 底部栏 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '8px 16px',
        background: `rgba(20, 20, 20, ${Math.min(opacity + 0.08, 1)})`,
        borderTop: '1px solid rgba(255, 255, 255, 0.08)', fontSize: '13px',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          background: 'rgba(34, 34, 34, 0.7)', padding: '3px 10px', borderRadius: '14px', fontSize: '12px', color: '#aaa',
        }}>
          <span>Wss:</span>
          <span style={{
            width: '8px', height: '8px', borderRadius: '50%',
            background: wsConnected ? '#10b981' : '#ef4444',
          }} />
        </div>

        {authFail && (
          <span style={{ color: '#ef4444', fontSize: '12px' }}>房间凭证无效</span>
        )}

        <span style={{ color: '#444' }}>|</span>

        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          {participants.map((p, idx) => (
            <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{
                width: '12px', height: '12px', borderRadius: '3px',
                background: p.color || '#00bcd4',
              }} />
              <span style={{ color: '#e5e5e5', fontWeight: 500 }}>{p.name}</span>
            </div>
          ))}
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <input
            value={userName}
            disabled={isClientApp && clickThrough}
            onChange={(e) => setUserName(e.target.value)}
            title="Click to edit your display name"
            style={{
              background: 'transparent', border: '1px solid transparent', color: '#888',
              fontSize: '12px', width: '90px', textAlign: 'right', outline: 'none',
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ── 加入入口：客户粘贴导师发的邀请链接 ──
function JoinGate({ onJoin }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [hasClipboard, setHasClipboard] = useState(false);

  // 检测剪贴板是否可用（Electron 里优先用 preload 暴露的接口）
  useEffect(() => {
    const electronClipboard = !!window.electronAPI?.readClipboardText;
    const browserClipboard = typeof navigator.clipboard?.readText === 'function';
    setHasClipboard(electronClipboard || browserClipboard);
  }, []);

  // 解析邀请链接：从中提取 room / token / user
  const parseLink = (raw) => {
    const s = (raw || '').trim();
    if (!s) return null;
    try {
      const u = new URL(s);
      const room = u.searchParams.get('room');
      const token = u.searchParams.get('token');
      const user = u.searchParams.get('user');
      if (room && token) return { room, token, user };
    } catch {
      // 不是完整 URL，尝试按 room+token 纯文本解析
      const m = s.match(/room=([^&\s]+).*token=([^&\s]+)/);
      if (m) return { room: m[1], token: m[2], user: null };
    }
    return null;
  };

  const join = () => {
    const parsed = parseLink(input);
    if (!parsed) {
      setError('链接无效，请粘贴完整的邀请链接');
      return;
    }
    onJoin(parsed.room, parsed.token, parsed.user || 'Client');
  };

  const pasteFromClipboard = async () => {
    try {
      // 桌面端优先走 Electron 剪贴板接口
      let text = '';
      if (window.electronAPI?.readClipboardText) {
        text = window.electronAPI.readClipboardText();
      } else {
        text = await navigator.clipboard.readText();
      }
      setInput(text);
      const parsed = parseLink(text);
      if (parsed) {
        onJoin(parsed.room, parsed.token, parsed.user || 'Client');
      } else {
        setError('剪贴板里没有有效的邀请链接');
      }
    } catch {
      setError('无法读取剪贴板，请手动粘贴');
    }
  };

  return (
    <div style={{
      height: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: '14px',
      background: '#0d0d0d', color: '#e5e5e5', fontFamily: 'monospace',
      padding: '20px',
    }}>
      <div style={{ fontSize: '18px', fontWeight: 600 }}>加入面试房间</div>
      <div style={{ color: '#888', fontSize: '13px', textAlign: 'center', lineHeight: 1.6 }}>
        请粘贴导师发给你的邀请链接
      </div>
      <div style={{ color: '#666', fontSize: '12px', textAlign: 'center' }}>
        推荐：先复制链接，再点下方「从剪贴板粘贴」一键加入
      </div>

      <input
        value={input}
        onChange={(e) => { setInput(e.target.value); setError(''); }}
        onKeyDown={(e) => { if (e.key === 'Enter') join(); }}
        placeholder="https://.../?room=xxxx&token=xxxx"
        style={{
          width: '100%', maxWidth: 420, background: '#1f1f1f', border: '1px solid #333',
          borderRadius: '8px', color: '#e5e5e5', padding: '12px 14px', fontSize: '13px',
          outline: 'none', fontFamily: 'monospace',
        }}
      />

      <div style={{ display: 'flex', gap: '10px' }}>
        <button
          onClick={join}
          style={{
            background: '#10b981', color: '#04281f', border: 'none', borderRadius: '6px',
            padding: '10px 20px', fontSize: '14px', fontWeight: 600, cursor: 'pointer',
          }}
        >
          加入
        </button>
        {hasClipboard && (
          <button
            onClick={pasteFromClipboard}
            style={{
              background: '#1f1f1f', color: '#d4d4d4', border: '1px solid #333', borderRadius: '6px',
              padding: '10px 16px', fontSize: '13px', cursor: 'pointer',
            }}
          >
            从剪贴板粘贴
          </button>
        )}
      </div>

      {error && <div style={{ color: '#ef4444', fontSize: '13px' }}>{error}</div>}
    </div>
  );
}
