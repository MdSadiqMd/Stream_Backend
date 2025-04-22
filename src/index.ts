import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

import { serverConfig, logger } from './config';
import roomHandler from './handlers/room.handler';
import streamHandler from './handlers/stream.handler';

const app = express();

const allowedOrigins = [
    'http://localhost:3000',
    'https://stream-frontend-bef.pages.dev'
];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin) || origin.includes('localhost')) {
            return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ['GET', 'POST', 'OPTIONS'],
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization']
    },
    maxHttpBufferSize: 1e8,
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    path: '/socket.io'
});

app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Stream backend is running',
        websocket: `wss://${req.headers.host}/socket.io`,
        peerjs: `wss://${req.headers.host}/myapp/peerjs`
    });
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
    logger.info(`Allowed origins: ${allowedOrigins.join(', ')}`);
});