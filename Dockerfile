FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg
RUN mkdir -p /app/temp
COPY package.json package-lock.json ./
RUN npm ci
RUN npm install -g peer
COPY . .

RUN echo '#!/bin/sh' > /app/start.sh && \
    echo 'export APP_PORT=${PORT:-4000}' >> /app/start.sh && \
    echo 'export PEER_PORT=9000' >> /app/start.sh && \
    echo 'npx peer --port ${PEER_PORT} --path /myapp --allow_discovery true &' >> /app/start.sh && \
    echo 'npm start' >> /app/start.sh && \
    chmod +x /app/start.sh

CMD ["/app/start.sh"]