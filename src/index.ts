import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';

import { serverConfig, logger } from './config';
import roomHandler from './handlers/room.handler';
import streamHandler from './handlers/stream.handler';

const app = express();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Access-Control-Allow-Origin']
}));
app.options('*', cors());
app.use('/streams', express.static(path.join(__dirname, '..', 'public', 'streams')));

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Access-Control-Allow-Origin']
    },
    maxHttpBufferSize: 1e8,
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    path: '/socket.io'
});

app.get('/', (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
    res.json({
        status: 'ok',
        message: 'Stream backend is running',
        websocket: `wss://${req.headers.host}/socket.io`,
        hls: `http://${req.headers.host}/streams/`,
        peerjs: `wss://${req.headers.host}/myapp/peerjs`
    });
});

app.get('/streams/info/:roomId', (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');

    const { roomId } = req.params;
    const playbackUrl = `/streams/${roomId}/playlist.m3u8`;

    try {
        const playlistPath = path.join(__dirname, '..', 'public', 'streams', roomId, 'playlist.m3u8');
        const isActive = fs.existsSync(playlistPath);
        res.json({
            roomId,
            isActive,
            playbackUrl: isActive ? playbackUrl : null
        });
    } catch (error) {
        logger.error(`Error checking stream info: ${error}`);
        res.status(500).json({
            error: 'Failed to check stream status'
        });
    }
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