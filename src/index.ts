import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

import { serverConfig, logger } from './config';
import roomHandler from './handlers/room.handler';
import streamHandler from './handlers/stream.handler';

const app = express();

app.use(cors({
    origin: ['*', "http://localhost:3000", "https://stream-frontend-bef.pages.dev"],
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true
}));
app.options('*', cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: ['*', "http://localhost:3000", "https://stream-frontend-bef.pages.dev"],
        methods: ['GET', 'POST', 'OPTIONS'],
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization']
    },
    maxHttpBufferSize: 1e8,
    transports: ['polling', 'websocket'],
    allowEIO3: true
});

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Stream backend is running' });
});

io.on('connection', (socket) => {
    logger.info(`New User Connected: ${socket.id}`);
    roomHandler(socket);
    streamHandler(socket);
    socket.on('disconnect', () => {
        logger.info(`User Disconnected: ${socket.id}`);
    });
});

server.listen(serverConfig.PORT, () => {
    logger.info(`Server is running on PORT: ${serverConfig.PORT}`);
});