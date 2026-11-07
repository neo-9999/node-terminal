FROM node:19-alpine
WORKDIR /app

# 先复制 package.json 并安装依赖
COPY package.json ./
RUN npm install

# 再复制其他所有文件
COPY . /app

EXPOSE 16895
CMD ["node", "index.js"]
