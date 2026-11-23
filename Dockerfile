# GlassPad 生产镜像：构建前端 -> 单进程服务静态页 + WebSocket
FROM node:20-slim

WORKDIR /app

# 先装依赖（含 devDependencies，构建需要 vite）
COPY package.json package-lock.json ./
RUN npm ci

# 拷贝源码并构建前端（产出 dist/）
COPY . .
RUN npm run build

# 清理 devDependencies，减小镜像体积
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server/index.js"]
