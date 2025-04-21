FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg
RUN mkdir -p /app/temp
COPY package.json package-lock.json ./
RUN npm ci
RUN npm install -g peer
COPY . .
EXPOSE 4000 9000

CMD /usr/local/bin/peer --port 9000 --path /myapp --allow_discovery true & npm start || npm start