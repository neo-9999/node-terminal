FROM node:19-alpine
WORKDIR /app

# 安装 python3 供 PTY 终端调用
RUN apk add --no-cache python3

# 复制 package.json 并安装依赖
COPY package.json ./
RUN npm install

# 复制其他所有文件
COPY . /app

EXPOSE 16895
CMD ["node", "index.js"]
