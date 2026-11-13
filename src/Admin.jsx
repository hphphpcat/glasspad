import React, { useState } from 'react';

export default function Admin() {
  const [key, setKey] = useState(() => localStorage.getItem('admin_key') || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null); // { roomId, token }
  const [copied, setCopied] = useState(false);

  // 邀请链接：客户点开即进，带 room + token + user=Client
  const buildLink = (roomId, token, user) =>
    `${window.location.origin}/?room=${roomId}&token=${token}&user=${user}`;

  const createRoom = async () => {
    if (!key.trim()) { setError('请先输入管理员密钥'); return; }
    setLoading(true);
    setError('');
    setCreated(null);
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '创建失败');
        return;
      }
      localStorage.setItem('admin_key', key.trim());
      setCreated(data);
    } catch (e) {
      setError('请求失败：' + e.message);
    } finally {
      setLoading(false);
    }
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('复制下面的链接：', text);
    }
  };

  const link = created ? buildLink(created.roomId, created.token, 'Client') : '';
  const mentorLink = created ? buildLink(created.roomId, created.token, 'Mentor') : '';

  return (
    <div style={{
      minHeight: '100vh', background: '#0d0d0d', color: '#e5e5e5',
      fontFamily: 'monospace', padding: '40px 20px',
    }}>
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <h1 style={{ fontSize: '20px', margin: '0 0 8px' }}>Codex 管理台</h1>
        <p style={{ color: '#888', fontSize: '13px', margin: '0 0 24px' }}>
          创建面试房间，把带 token 的链接发给客户。客户只能通过链接加入，无法自己开房或偷看别人的房间。
        </p>

        {/* 密钥输入 */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="管理员密钥（ADMIN_KEY）"
            style={{
              flex: 1, background: '#1f1f1f', border: '1px solid #333', borderRadius: '6px',
              color: '#e5e5e5', padding: '10px 12px', fontSize: '14px', outline: 'none', fontFamily: 'monospace',
            }}
          />
          <button
            onClick={createRoom}
            disabled={loading}
            style={{
              background: '#10b981', color: '#04281f', border: 'none', borderRadius: '6px',
              padding: '10px 18px', fontSize: '14px', fontWeight: 600, cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {loading ? '创建中…' : '+ 创建房间'}
          </button>
        </div>

        {error && (
          <div style={{ color: '#ef4444', fontSize: '13px', marginBottom: '16px' }}>{error}</div>
        )}

        {/* 创建结果 */}
        {created && (
          <div style={{
            background: '#141414', border: '1px solid #2ea043', borderRadius: '8px', padding: '16px',
          }}>
            <div style={{ fontSize: '13px', color: '#10b981', marginBottom: '12px' }}>
              ✓ 房间已创建（房间号 {created.roomId}）
            </div>

            <div style={{ fontSize: '13px', color: '#888', marginBottom: '6px' }}>发给客户（候选人）：</div>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
              <input
                readOnly
                value={link}
                onFocus={(e) => e.target.select()}
                style={{
                  flex: 1, background: '#0d0d0d', border: '1px solid #333', borderRadius: '6px',
                  color: '#58a6ff', padding: '8px 10px', fontSize: '12px', outline: 'none', fontFamily: 'monospace',
                }}
              />
              <button
                onClick={() => copy(link)}
                style={{
                  background: '#1f1f1f', color: copied ? '#10b981' : '#d4d4d4', border: '1px solid #333',
                  borderRadius: '6px', padding: '8px 12px', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >
                {copied ? '已复制 ✓' : '复制'}
              </button>
            </div>

            <div style={{ fontSize: '13px', color: '#888', marginBottom: '6px' }}>导师自己（提词端）：</div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                readOnly
                value={mentorLink}
                onFocus={(e) => e.target.select()}
                style={{
                  flex: 1, background: '#0d0d0d', border: '1px solid #333', borderRadius: '6px',
                  color: '#f59e0b', padding: '8px 10px', fontSize: '12px', outline: 'none', fontFamily: 'monospace',
                }}
              />
              <button
                onClick={() => copy(mentorLink)}
                style={{
                  background: '#1f1f1f', color: '#d4d4d4', border: '1px solid #333',
                  borderRadius: '6px', padding: '8px 12px', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >
                复制
              </button>
            </div>
          </div>
        )}

        <div style={{ marginTop: '24px', color: '#555', fontSize: '12px', lineHeight: 1.7 }}>
          <div>· 密钥由 ADMIN_KEY 环境变量控制，只在你自己的部署里生效。</div>
          <div>· 房间号 + token 双要素，缺一不可，客户猜不到也进不来。</div>
          <div>· 每个客户发一个独立房间，面试完房间在没人时自动回收。</div>
        </div>
      </div>
    </div>
  );
}
