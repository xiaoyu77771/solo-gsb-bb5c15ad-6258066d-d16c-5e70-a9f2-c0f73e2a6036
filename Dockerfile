# 陶艺装窑预检 Web 应用
# 启动即自动安装依赖并初始化示例方案（data/plan.json）
FROM node:20-alpine

WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# 拷贝应用源码
COPY server.js ./
COPY public ./public
COPY test ./test

# 方案持久化目录（由容器内 node 进程写入）
RUN mkdir -p data && chown -R node:node /app
USER node
VOLUME ["/app/data"]

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# 启动前无需额外迁移；server.js 启动时自动创建 data/plan.json
CMD ["node", "server.js"]
