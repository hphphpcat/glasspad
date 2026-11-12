import React, { useState, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';

export default function App() {
  const params = new URLSearchParams(window.location.search);

  const [roomId, setRoomId] = useState(
    () => params.get('room') || localStorage.getItem('pad_room') || '1024'
  );
  const [roomInput, setRoomInput] = useState(roomId);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2. 切换毛玻璃开关并同步给 Electron 主进程与本地存储
  const toggleFrostedGlass = (enabled) => {
    setFrostedGlass(enabled);
    localStorage.setItem('pad_frost', String(enabled));
    window.electronAPI?.setFrostedGlass?.(enabled);
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
    localStorage.setItem('pad_room', roomId);
    localStorage.setItem('pad_user', userName);

    const newUrl = `${window.location.pathname}?room=${encodeURIComponent(roomId)}&user=${encodeURIComponent(userName)}`;
    window.history.replaceState({}, '', newUrl);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = import.meta.env.VITE_WS_URL || `${protocol}//${window.location.host}`;

    let ws;
    let reconnectTimer;
    let isUnmounted = false;

    const connect = () => {
      if (isUnmounted) return;
      ws = new WebSocket(`${wsUrl}/?room=${encodeURIComponent(roomId)}&user=${encodeURIComponent(userName)}`);
      wsRef.current = ws;

      ws.onopen = () => setWsConnected(true);

      ws.onmessage = (e) => {
        const { type, payload } = JSON.parse(e.data);
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
  }, [roomId, userName, autoScroll]);

  const handleTextChange = (val) => {
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
    setText('');
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({
        type: 'TEXT_SYNC',
        payload: { text: '' },
      }));
    }
  };

  const copyInvite = () => {
    const link = `${window.location.origin}/?room=${encodeURIComponent(roomId)}&user=Helper`;
    navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      // 动态透明度底色 + CSS 毛玻璃模糊双重加持
      background: `rgba(13, 13, 13, ${opacity})`,
      backdropFilter: supportsFrost && frostedGlass ? 'blur(14px)' : 'none',
      WebkitBackdropFilter: supportsFrost && frostedGlass ? 'blur(14px)' : 'none',
      color: '#e5e5e5', fontFamily: 'monospace',
      border: `1px solid rgba(255, 255, 255, ${Math.min(opacity * 0.18, 0.15)})`,
      borderRadius: '8px', overflow: 'hidden',
    }}>
      {/* 顶部栏 */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        flexWrap: 'wrap', gap: '8px',
        padding: '8px 14px',
        background: `rgba(20, 20, 20, ${Math.min(opacity + 0.08, 1)})`,
        borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
        WebkitAppRegion: 'drag',
      }}>
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

          <button
            onClick={clearPad}
            style={{
              background: 'rgba(31, 31, 31, 0.7)', color: '#9ca3af', border: '1px solid #333',
              borderRadius: '6px', padding: '4px 8px', fontSize: '12px', cursor: 'pointer',
            }}
          >
            Clear
          </button>
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
            onChange={(e) => {
              const lang = e.target.value;
              setLanguage(lang);
              wsRef.current?.send(JSON.stringify({ type: 'LANG_SYNC', payload: { language: lang } }));
            }}
            style={{
              background: 'transparent', color: '#9ca3af', border: 'none',
              fontSize: '13px', outline: 'none', cursor: 'pointer',
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

      {/* 中间打字提词主区域（背景完全透明，透出外层容器的 rgba 透明度） */}
      <div style={{ flex: 1, position: 'relative', paddingTop: '8px' }}>
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
              },
            });
          }}
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            monaco.editor.setTheme('codex-transparent');
            editor.getModel()?.setEOL(monaco.editor.EndOfLineSequence.LF);
          }}
          options={{
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
        <button
          onClick={copyInvite}
          style={{
            background: 'transparent', color: copied ? '#10b981' : '#d4d4d4', border: 'none',
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
          }}
        >
          <span>+</span> {copied ? 'Copied!' : 'Invite'}
        </button>

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
