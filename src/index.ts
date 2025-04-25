import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';

import { serverConfig, logger } from './config';
import roomHandler from './handlers/room.handler';
import streamHandler from './handlers/stream.handler';
import { setupStreamInfoRoutes } from './handlers/stream-info';

const app = express();
const server = http.createServer(app);

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use('/streams', express.static(path.join(__dirname, '..', 'public', 'streams')));
app.options('*', cors());

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    next();
});

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
    },
    maxHttpBufferSize: 1e8,
    path: '/socket.io',
    transports: ['polling'],
    allowEIO3: true
});

app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Stream backend is running',
        socketio: `${req.protocol}://${req.headers.host}/socket.io`,
        hls: `${req.protocol}://${req.headers.host}/streams/`
    });
});

setupStreamInfoRoutes(app);
const streamsDir = path.join(__dirname, '..', 'public', 'streams');
if (!fs.existsSync(streamsDir)) {
    fs.mkdirSync(streamsDir, { recursive: true });
}

io.on('connection', (socket) => {
    logger.info(`New User Connected: ${socket.id}`);
    const transport = socket.conn.transport.name;
    logger.info(`Socket transport: ${transport}`);
    roomHandler(socket);
    streamHandler(socket);
    socket.on('disconnect', () => {
        logger.info(`User Disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || serverConfig.PORT || 4000;
server.listen(PORT, () => {
    logger.info(`Server is running on PORT: ${PORT}`);
    logger.info(`Socket.IO server running with polling transport`);
});