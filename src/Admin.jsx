import React, { useState, useEffect, useCallback } from 'react';
import { BrandLogo } from './App.jsx';

const uiFont = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif';
const codeFont = 'ui-monospace, SFMono-Regular, "Cascadia Code", Consolas, Menlo, monospace';

function formatRelativeTime(ts) {
  if (!ts) return '-';
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 10) return '刚刚';
  if (diff < 60) return `${diff}秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  return `${Math.floor(diff / 86400)}天前`;
}

export default function Admin() {
  const [key, setKey] = useState(() => localStorage.getItem('admin_key') || '');
  const [note, setNote] = useState('');
  const [rooms, setRooms] = useState([]);
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [destroyingId, setDestroyingId] = useState('');
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null); // 最近新创建的房间
  const [copiedTag, setCopiedTag] = useState(''); // 例如 "new-client" | "<roomId>-client" | "<roomId>-mentor"

  // 邀请链接：客户点开即进，带 room + token + user=Client
  const buildLink = (roomId, token, user) =>
    `${window.location.origin}/?room=${roomId}&token=${token}&user=${user}`;

  const fetchRooms = useCallback(async (adminKey, silent = false) => {
    const k = (adminKey ?? key).trim();
    if (!k) return;
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/rooms', {
        headers: { 'x-admin-key': k },
      });
      const data = await res.json();
      if (!res.ok) {
        if (!silent) setError(data.error || '加载失败');
        setAuthed(false);
        return;
      }
      localStorage.setItem('admin_key', k);
      setRooms(Array.isArray(data.rooms) ? data.rooms : []);
      setAuthed(true);
      if (!silent) setError('');
    } catch (e) {
      if (!silent) setError('请求失败：' + e.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [key]);

  // 页面初次加载：若本地存有 admin_key 则自动拉取列表，并每 3 秒自动轮询在线状态
  useEffect(() => {
    const saved = localStorage.getItem('admin_key');
    if (saved) fetchRooms(saved);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!authed || !key.trim()) return;
    const timer = setInterval(() => {
      fetchRooms(key, true);
    }, 3000);
    return () => clearInterval(timer);
  }, [authed, key, fetchRooms]);

  const createRoom = async () => {
    const k = key.trim();
    if (!k) { setError('请先输入管理员密钥'); return; }
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': k,
        },
        body: JSON.stringify({ key: k, note: note.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '创建失败');
        return;
      }
      localStorage.setItem('admin_key', k);
      setCreated(data);
      setNote('');
      setAuthed(true);
      await fetchRooms(k, true);
    } catch (e) {
      setError('请求失败：' + e.message);
    } finally {
      setCreating(false);
    }
  };

  const destroySingleRoom = async (roomId) => {
    const k = key.trim();
    if (!k) { setError('请先输入管理员密钥'); return; }
    setDestroyingId(roomId);
    setError('');
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
        method: 'DELETE',
        headers: { 'x-admin-key': k },
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '销毁失败');
        return;
      }
      if (created?.roomId === roomId) setCreated(null);
      setRooms((prev) => prev.filter((r) => r.roomId !== roomId));
    } catch (e) {
      setError('销毁请求失败：' + e.message);
    } finally {
      setDestroyingId('');
    }
  };

  const destroyBatchRooms = async (mode) => {
    const k = key.trim();
    if (!k) { setError('请先输入管理员密钥'); return; }
    const label = mode === 'all'
      ? `确定销毁全部 ${rooms.length} 个房间吗？在线连接的客户端将立即断开。`
      : '确定清理所有当前无人在线（0人）的空闲房间吗？';
    if (!window.confirm(label)) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/rooms?mode=${encodeURIComponent(mode)}`, {
        method: 'DELETE',
        headers: { 'x-admin-key': k },
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '批量销毁失败');
        return;
      }
      if (created && data.destroyed?.includes(created.roomId)) {
        setCreated(null);
      }
      await fetchRooms(k, true);
    } catch (e) {
      setError('批量销毁失败：' + e.message);
    } finally {
      setLoading(false);
    }
  };

  const copy = async (text, tag) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTag(tag);
      setTimeout(() => setCopiedTag((prev) => (prev === tag ? '' : prev)), 1800);
    } catch {
      window.prompt('复制下面的链接：', text);
    }
  };

  const totalOnlineUsers = rooms.reduce((sum, r) => sum + (r.onlineCount || 0), 0);
  const activeRoomsCount = rooms.filter((r) => r.onlineCount > 0).length;
  const idleRoomsCount = rooms.length - activeRoomsCount;

  return (
    <div style={{
      minHeight: '100vh', height: '100vh', overflowY: 'auto',
      background: '#0b0e13', color: '#e5e7eb',
      fontFamily: uiFont, padding: '36px 20px 60px', boxSizing: 'border-box',
    }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        {/* 顶部标题栏 + 统计概览 */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap', gap: '16px', marginBottom: '24px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <BrandLogo size={38} />
            <div>
              <h1 style={{ fontSize: '21px', fontWeight: 700, margin: 0, color: '#f8fafc' }}>
                GlassPad 在线 Pad 管理台
              </h1>
              <div style={{ color: '#94a3b8', fontSize: '13px', marginTop: '3px' }}>
                实时管理所有提词房间 · 支持一键 Create 建房与 Destroy 强制销毁断连
              </div>
            </div>
          </div>

          {authed && (
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
              <StatPill label="总房间" value={rooms.length} color="#cbd5e1" />
              <StatPill label="活跃中" value={activeRoomsCount} color="#10b981" dot />
              <StatPill label="在线连接" value={totalOnlineUsers} color="#38bdf8" />
            </div>
          )}
        </div>

        {/* 管理员密钥 & Create 新建房间操作面板 */}
        <div style={{
          background: '#121721', border: '1px solid rgba(255,255,255,0.09)',
          borderRadius: '10px', padding: '18px', marginBottom: '20px',
        }}>
          <div style={{
            display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center',
          }}>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') fetchRooms(key); }}
              placeholder="管理员密钥（ADMIN_KEY）"
              style={{
                flex: '1 1 200px', background: '#0b0e13', border: '1px solid #2b3445',
                borderRadius: '7px', color: '#f1f5f9', padding: '10px 12px',
                fontSize: '13.5px', outline: 'none', fontFamily: codeFont,
              }}
            />
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createRoom(); }}
              placeholder="备注名（可选，如：候选人A - 下午场）"
              style={{
                flex: '1.2 1 220px', background: '#0b0e13', border: '1px solid #2b3445',
                borderRadius: '7px', color: '#f1f5f9', padding: '10px 12px',
                fontSize: '13.5px', outline: 'none',
              }}
            />
            <button
              onClick={createRoom}
              disabled={creating}
              style={{
                background: '#10b981', color: '#032219', border: 'none', borderRadius: '7px',
                padding: '10px 18px', fontSize: '13.5px', fontWeight: 700, cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {creating ? '创建中…' : '+ Create 新建 Pad'}
            </button>
            <button
              onClick={() => fetchRooms(key)}
              disabled={loading}
              style={{
                background: '#1e2636', color: '#cbd5e1', border: '1px solid #334155',
                borderRadius: '7px', padding: '10px 14px', fontSize: '13px', fontWeight: 500,
                cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              {loading ? '刷新中…' : '刷新列表'}
            </button>
          </div>

          {error && (
            <div style={{
              color: '#f87171', fontSize: '13px', marginTop: '12px',
              background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.28)',
              padding: '8px 12px', borderRadius: '6px',
            }}>
              {error}
            </div>
          )}

          {/* 刚创建的房间高亮卡片 */}
          {created && (
            <div style={{
              marginTop: '16px', background: 'rgba(16, 185, 129, 0.07)',
              border: '1px solid rgba(16, 185, 129, 0.45)', borderRadius: '8px', padding: '14px 16px',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                marginBottom: '10px', flexWrap: 'wrap', gap: '8px',
              }}>
                <div style={{ fontSize: '13.5px', color: '#34d399', fontWeight: 600 }}>
                  ✓ 新建 Pad 已就绪：#{created.roomId}
                  {created.note ? `（${created.note}）` : ''}
                </div>
                <button
                  onClick={() => setCreated(null)}
                  style={{
                    background: 'transparent', border: 'none', color: '#94a3b8',
                    fontSize: '12px', cursor: 'pointer',
                  }}
                >
                  收起
                </button>
              </div>

              <LinkRow
                label="发给客户（候选人只读端）："
                url={buildLink(created.roomId, created.token, 'Client')}
                color="#60a5fa"
                copied={copiedTag === 'new-client'}
                onCopy={() => copy(buildLink(created.roomId, created.token, 'Client'), 'new-client')}
              />
              <div style={{ height: '8px' }} />
              <LinkRow
                label="导师自己（网页提词端）："
                url={buildLink(created.roomId, created.token, 'Mentor')}
                color="#fbbf24"
                copied={copiedTag === 'new-mentor'}
                onCopy={() => copy(buildLink(created.roomId, created.token, 'Mentor'), 'new-mentor')}
                openUrl={buildLink(created.roomId, created.token, 'Mentor')}
              />
            </div>
          )}
        </div>

        {/* 在线 Pad 列表区 */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap', gap: '10px', marginBottom: '12px',
        }}>
          <div style={{ fontSize: '15px', fontWeight: 600, color: '#f1f5f9' }}>
            当前 Pad 列表（{rooms.length}）
          </div>

          {rooms.length > 0 && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {idleRoomsCount > 0 && (
                <button
                  onClick={() => destroyBatchRooms('idle')}
                  style={{
                    background: '#1e2636', color: '#cbd5e1', border: '1px solid #334155',
                    borderRadius: '6px', padding: '6px 12px', fontSize: '12px', cursor: 'pointer',
                  }}
                >
                  清理空闲 Pad ({idleRoomsCount})
                </button>
              )}
              <button
                onClick={() => destroyBatchRooms('all')}
                style={{
                  background: 'rgba(239, 68, 68, 0.14)', color: '#f87171',
                  border: '1px solid rgba(239, 68, 68, 0.35)', borderRadius: '6px',
                  padding: '6px 12px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                }}
              >
                Destroy 全部 ({rooms.length})
              </button>
            </div>
          )}
        </div>

        {!authed ? (
          <div style={{
            background: '#121721', border: '1px dashed #2b3445', borderRadius: '10px',
            padding: '44px 20px', textAlign: 'center', color: '#64748b', fontSize: '13.5px',
          }}>
            请输入管理员密钥（ADMIN_KEY）后点击「刷新列表」或「+ Create 新建 Pad」管理所有在线房间
          </div>
        ) : rooms.length === 0 ? (
          <div style={{
            background: '#121721', border: '1px dashed #2b3445', borderRadius: '10px',
            padding: '44px 20px', textAlign: 'center', color: '#64748b', fontSize: '13.5px',
          }}>
            当前没有任何运行中的 Pad，点击上方「+ Create 新建 Pad」创建一个新房间
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {rooms.map((room) => {
              const clientUrl = buildLink(room.roomId, room.token, 'Client');
              const mentorUrl = buildLink(room.roomId, room.token, 'Mentor');
              const isOnline = room.onlineCount > 0;
              const isDestroying = destroyingId === room.roomId;

              return (
                <div
                  key={room.roomId}
                  style={{
                    background: '#121721',
                    border: `1px solid ${isOnline ? 'rgba(16, 185, 129, 0.38)' : 'rgba(255, 255, 255, 0.08)'}`,
                    borderRadius: '10px', padding: '14px 16px',
                    display: 'flex', flexDirection: 'column', gap: '10px',
                  }}
                >
                  {/* 第一行：房间号 + 备注 + 在线状态 + 语言/字数 + 操作按钮 */}
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    flexWrap: 'wrap', gap: '10px',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      {/* 在线状态灯 */}
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: '6px',
                        background: isOnline ? 'rgba(16, 185, 129, 0.14)' : 'rgba(148, 163, 184, 0.1)',
                        color: isOnline ? '#34d399' : '#94a3b8',
                        border: `1px solid ${isOnline ? 'rgba(16, 185, 129, 0.35)' : 'rgba(148, 163, 184, 0.2)'}`,
                        padding: '3px 9px', borderRadius: '999px', fontSize: '12px', fontWeight: 600,
                      }}>
                        <span style={{
                          width: '7px', height: '7px', borderRadius: '50%',
                          background: isOnline ? '#10b981' : '#64748b',
                        }} />
                        {isOnline ? `${room.onlineCount} 人在线` : '空闲 (0人)'}
                      </span>

                      <span style={{
                        fontFamily: codeFont, fontSize: '15px', fontWeight: 700, color: '#f8fafc',
                      }}>
                        #{room.roomId}
                      </span>

                      {room.note && (
                        <span style={{
                          background: '#1e293b', color: '#e2e8f0', padding: '2px 8px',
                          borderRadius: '5px', fontSize: '12px', fontWeight: 500,
                        }}>
                          {room.note}
                        </span>
                      )}

                      <span style={{ color: '#64748b', fontSize: '12px' }}>
                        {room.language} · {room.textLength || 0} 字符 · 活跃于 {formatRelativeTime(room.lastActive)}
                      </span>
                    </div>

                    {/* 右侧动作按钮组 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <button
                        onClick={() => copy(clientUrl, `${room.roomId}-client`)}
                        style={{
                          background: '#1a2232',
                          color: copiedTag === `${room.roomId}-client` ? '#34d399' : '#93c5fd',
                          border: '1px solid #2d3b52', borderRadius: '6px',
                          padding: '6px 11px', fontSize: '12px', fontWeight: 500, cursor: 'pointer',
                        }}
                      >
                        {copiedTag === `${room.roomId}-client` ? '已复制客户链接 ✓' : '复制客户链接'}
                      </button>

                      <button
                        onClick={() => copy(mentorUrl, `${room.roomId}-mentor`)}
                        style={{
                          background: '#1a2232',
                          color: copiedTag === `${room.roomId}-mentor` ? '#34d399' : '#fcd34d',
                          border: '1px solid #2d3b52', borderRadius: '6px',
                          padding: '6px 11px', fontSize: '12px', fontWeight: 500, cursor: 'pointer',
                        }}
                      >
                        {copiedTag === `${room.roomId}-mentor` ? '已复制导师链接 ✓' : '复制导师链接'}
                      </button>

                      <a
                        href={mentorUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          background: 'rgba(16, 185, 129, 0.14)', color: '#34d399',
                          border: '1px solid rgba(16, 185, 129, 0.35)', borderRadius: '6px',
                          padding: '6px 11px', fontSize: '12px', fontWeight: 600,
                          textDecoration: 'none',
                        }}
                      >
                        打开提词端 ↗
                      </a>

                      <button
                        onClick={() => destroySingleRoom(room.roomId)}
                        disabled={isDestroying}
                        style={{
                          background: 'rgba(239, 68, 68, 0.15)', color: '#f87171',
                          border: '1px solid rgba(239, 68, 68, 0.38)', borderRadius: '6px',
                          padding: '6px 12px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                        }}
                      >
                        {isDestroying ? '销毁中…' : 'Destroy'}
                      </button>
                    </div>
                  </div>

                  {/* 第二行：在线成员铭牌 & 内容摘要 */}
                  {(room.participants?.length > 0 || room.textPreview) && (
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      flexWrap: 'wrap', gap: '10px', paddingTop: '6px',
                      borderTop: '1px solid rgba(255, 255, 255, 0.05)', fontSize: '12px',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                        <span style={{ color: '#64748b' }}>在线成员：</span>
                        {room.participants?.length ? (
                          room.participants.map((p, i) => (
                            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', color: '#cbd5e1' }}>
                              <span style={{ width: '9px', height: '9px', borderRadius: '2px', background: p.color || '#10b981' }} />
                              {p.name}
                            </span>
                          ))
                        ) : (
                          <span style={{ color: '#475569' }}>暂无</span>
                        )}
                      </div>

                      {room.textPreview && (
                        <div style={{
                          fontFamily: codeFont, color: '#94a3b8', background: '#0b0e13',
                          padding: '3px 8px', borderRadius: '4px', maxWidth: '420px',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }} title={room.textPreview}>
                          {room.textPreview.replace(/\n/g, ' ↵ ')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div style={{ marginTop: '24px', color: '#64748b', fontSize: '12px', lineHeight: 1.8 }}>
          <div>· 点击 <strong style={{ color: '#f87171' }}>Destroy</strong> 会立即从服务端彻底删除该房间凭证，并强制断开当前在房间内的所有客户端与导师端 WebSocket 连接。</div>
          <div>· 列表每 3 秒自动同步一次在线人数、成员状态与代码字数预览。</div>
        </div>
      </div>
    </div>
  );
}

function StatPill({ label, value, color, dot }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '7px',
      background: '#121721', border: '1px solid rgba(255,255,255,0.09)',
      padding: '6px 12px', borderRadius: '8px', fontSize: '12.5px',
    }}>
      {dot && <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: color }} />}
      <span style={{ color: '#94a3b8' }}>{label}</span>
      <span style={{ color, fontWeight: 700, fontFamily: codeFont }}>{value}</span>
    </div>
  );
}

function LinkRow({ label, url, color, copied, onCopy, openUrl }) {
  return (
    <div>
      <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '4px' }}>{label}</div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <input
          readOnly
          value={url}
          onFocus={(e) => e.target.select()}
          style={{
            flex: 1, background: '#0b0e13', border: '1px solid #2b3445', borderRadius: '6px',
            color, padding: '7px 10px', fontSize: '12px', outline: 'none', fontFamily: codeFont,
          }}
        />
        <button
          onClick={onCopy}
          style={{
            background: '#1e2636', color: copied ? '#34d399' : '#e2e8f0',
            border: '1px solid #334155', borderRadius: '6px', padding: '7px 12px',
            fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          {copied ? '已复制 ✓' : '复制'}
        </button>
        {openUrl && (
          <a
            href={openUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              background: '#10b981', color: '#032219', borderRadius: '6px',
              padding: '7px 12px', fontSize: '12px', fontWeight: 700,
              textDecoration: 'none', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center',
            }}
          >
            进入房间 ↗
          </a>
        )}
      </div>
    </div>
  );
}
