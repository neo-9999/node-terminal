# 第一阶段：构建阶段 (Builder)
FROM node:20-alpine AS builder
WORKDIR /app

# 仅复制依赖配置文件
COPY package*.json ./

# 【新增此行】：安装 Alpine 缺失的 Python 和 C++ 编译工具
RUN apk add --no-cache python3 make g++

# 核心优化 1：安装生产依赖 (使用最新的 --omit=dev 避免警告)
# 核心优化 2：清理 npm 缓存
RUN npm install --omit=dev && npm cache clean --force

# 第二阶段：运行阶段 (Runner)
FROM node:20-alpine
WORKDIR /app

# 核心优化 3：从 builder 提取已经编译好的 node_modules，不带 Python 和编译垃圾
COPY --from=builder /app/node_modules ./node_modules

# 复制业务代码
COPY . /app

EXPOSE 14484
CMD ["node", "index.js"]
