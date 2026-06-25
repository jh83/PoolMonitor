FROM node:22-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server/ ./server/
COPY www/ ./www/

ENV DATA_DIR=/data
ENV PORT=8088
VOLUME /data
EXPOSE 8088

CMD ["node", "server/index.js"]
