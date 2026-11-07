FROM nikolaik/python-nodejs:python3.11-nodejs19
WORKDIR /app

# 复制 package.json 并安装依赖
COPY package.json ./
RUN npm install

# 复制其他所有文件
COPY . /app

EXPOSE 16895
CMD ["node", "index.js"]
