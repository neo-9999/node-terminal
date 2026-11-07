FROM node:19-alpine
WORKDIR /app
COPY . /app
EXPOSE 16895
CMD ["node", "index.js"]
