# Codex Clone · 极简实时打字提词版

实时打字同步 + 动态房间码 + 昵称记忆 + 自动滚屏 + 在线队友列表。打包一次客户端发给所有客户，每次面试发个 4 位房间码即可秒进专属提词房间。

## 功能

- **动态房间码切换**：左上角 `Room:` 框输入 4 位数字回车，秒切房间；URL / localStorage 三级记忆。
- **昵称记忆**：右下角改名字，存 localStorage，下次自动恢复。
- **自动滚屏跟随**：导师打字超过一屏，候选人界面自动滚到底部（可开关）。
- **语言同步**：导师切 Python / Plain Text / C++ / Java / JS，客户端语法高亮跟着切（`LANG_SYNC`）。
- **一键清屏**：`Clear` 按钮同步清空双方屏幕，切下一道题用。
- **在线列表**：底部 `Wss: 🟢` 状态灯 + 彩色队友铭牌 + 断线自动重连。

## 协议

`INIT`（房间文字+语言）/ `TEXT_SYNC`（打字广播）/ `LANG_SYNC`（语言同步）/ `PRESENCE`（在线列表）/ `PING`（心跳）。

## 本地运行

```bash
export PATH="/opt/homebrew/bin:$PATH"
cd ~/codex-clone
npm install
npm run build          # 生成 dist
node server/index.js   # 后端 8080，打开 http://localhost:8080
```

开发热更新：`npm run dev`（起 server + web），打开 http://localhost:5173 —— `.env.development` 已把 WS 指向 `ws://localhost:8080`。

## 跨互联网部署（打包一次，永久复用）

1. **部署后端**：把目录推到 Railway / Render / Fly.io，构建 `npm run build`、启动 `node server/index.js`，得到 `https://xxx.up.railway.app`。
2. **打包客户端**：`ELECTRON_START_URL=https://xxx.up.railway.app/` 打包 Mac/Win 客户端（`startUrl` 不带固定房间号）。
3. **每次面试**：
   - 客户打开软件，左上角 `Room:` 输入你发他的 4 位码（如 `2088`）回车。
   - 导师浏览器打开 `https://xxx.up.railway.app/?room=2088&user=Mentor`。
   - 双方底部亮 `Wss: 🟢`，导师打字 → 客户实时逐字浮现 + 自动滚屏。
   - 切下一题：导师点 `Clear`。

## 验证

```bash
node server/index.js
node scripts/sync-test.mjs
```

## 说明

- **Run 按钮当前是纯 UI**（截图 1:1 复刻），无代码执行逻辑。
- 房间状态存单进程内存，重启丢失；单节点够全球打字同步用，要持久化需接存储。
- 4 位房间码当前是「约定码」，无鉴权——知道房间号即可加入。若要防串线/防旁听，需加房间密码或 token（可后续补）。
