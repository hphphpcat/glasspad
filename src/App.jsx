import React, { useState, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';

export default function App() {
  const params = new URLSearchParams(window.location.search);

  // 优先 URL 参数，其次本地上次保存的房间号，默认 1024
  const [roomId, setRoomId] = useState(
    () => params.get('room') || localStorage.getItem('pad_room') || '1024'
  );
  const [roomInput, setRoomInput] = useState(roomId);

  const [userName, setUserName] = useState(
    () => params.get('user') || localStorage.getItem('pad_user') || 'Cstech Cat'
  );

  const [text, setText] = useState('');
  const [language, setLanguage] = useState('python');
  const [wsConnected, setWsConnected] = useState(false);
  const [participants, setParticipants] = useState([]);
  const [copied, setCopied] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true); // 提词自动滚屏到底部

  const wsRef = useRef(null);
  const editorRef = useRef(null);
  const isRemote = useRef(false);

  // 每次切换房间或修改名字时，建立对应的 WebSocket 房间连接
  useEffect(() => {
    localStorage.setItem('pad_room', roomId);
    localStorage.setItem('pad_user', userName);

    // 同步更新地址栏参数（方便浏览器端直接复制 URL）
    const newUrl = `${window.location.pathname}?room=${encodeURIComponent(roomId)}&user=${encodeURIComponent(userName)}`;
    window.history.replaceState({}, '', newUrl);

    // dev：走 VITE_WS_URL（.env.development 指向 ws://localhost:8080）；生产：同源 wss://
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

          // 导师打字超过一屏时，候选人界面自动平滑滚动到最后一行
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

  // 处理本地打字同步
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

  // 切换房间号（按回车或失焦触发）
  const applyRoomSwitch = (e) => {
    e.preventDefault();
    const trimmed = roomInput.trim();
    if (trimmed && trimmed !== roomId) {
      setText('// Switching room...');
      setRoomId(trimmed);
    }
  };

  // 一键清空当前题目的提词板（同步清空双方屏幕）
  const clearPad = () => {
    setText('');
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({
        type: 'TEXT_SYNC',
        payload: { text: '' },
      }));
    }
  };

  // 复制导师/客户直达链接
  const copyInvite = async () => {
    const link = `${window.location.origin}/?room=${encodeURIComponent(roomId)}&user=Helper`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy the invite link:', link);
    }
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      background: '#0d0d0d', color: '#e5e5e5', fontFamily: 'monospace',
      border: '1px solid #262626', borderRadius: '8px', overflow: 'hidden',
    }}>
      {/* 顶部栏：Run 按钮 + 动态房间切换框 + 语言选择 */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '8px 14px', background: '#141414', borderBottom: '1px solid #222',
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

          {/* 房间号快速输入框（输入 4 位房间码按回车立即切换） */}
          <form onSubmit={applyRoomSwitch} style={{
            display: 'flex', alignItems: 'center', background: '#1f1f1f',
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
                fontWeight: 600, fontSize: '13px', width: '64px', outline: 'none', fontFamily: 'monospace',
              }}
            />
          </form>

          {/* 一键清屏按钮（切下一道题时用） */}
          <button
            onClick={clearPad}
            title="Clear pad for next question"
            style={{
              background: '#1f1f1f', color: '#9ca3af', border: '1px solid #333',
              borderRadius: '6px', padding: '4px 8px', fontSize: '12px', cursor: 'pointer',
            }}
          >
            Clear
          </button>
        </div>

        {/* 右侧：自动滚屏开关 + 语言选择 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', WebkitAppRegion: 'no-drag' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: '#888', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
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

      {/* 中间打字提词主区域 */}
      <div style={{ flex: 1, position: 'relative', paddingTop: '8px' }}>
        <Editor
          height="100%"
          theme="vs-dark"
          language={language}
          value={text}
          onChange={handleTextChange}
          beforeMount={(monaco) => {
            monaco.editor.defineTheme('pure-dark', {
              base: 'vs-dark',
              inherit: true,
              rules: [],
              colors: {
                'editor.background': '#0d0d0d',
                'editorGutter.background': '#0d0d0d',
                'editor.lineHighlightBackground': '#141414',
              },
            });
          }}
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            monaco.editor.setTheme('pure-dark');
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

      {/* 底部栏：+ Invite + Wss 绿灯 + 在线协作者铭牌 + 点击改名 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '8px 16px', background: '#141414', borderTop: '1px solid #222', fontSize: '13px',
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

        {/* Wss 状态灯 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          background: '#222', padding: '3px 10px', borderRadius: '14px', fontSize: '12px', color: '#aaa',
        }}>
          <span>Wss:</span>
          <span style={{
            width: '8px', height: '8px', borderRadius: '50%',
            background: wsConnected ? '#10b981' : '#ef4444',
          }} />
        </div>

        <span style={{ color: '#333' }}>|</span>

        {/* 在线队友标签列表 */}
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

        {/* 右下角：修改自己的显示昵称 */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <input
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            title="Click to edit your display name"
            style={{
              background: 'transparent', border: '1px solid transparent', color: '#666',
              fontSize: '12px', width: '90px', textAlign: 'right', outline: 'none',
            }}
          />
        </div>
      </div>
    </div>
  );
}
