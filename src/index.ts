import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import * as mediasoup from 'mediasoup';

import { serverConfig, logger } from './config';
import roomHandler from './handlers/room.handler';
import streamHandler from './handlers/stream.handler';
import mediasoupHandler from './handlers/mediasoup.handler';

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

let worker: mediasoup.types.Worker;
async function initializeMediaSoup() {
    try {
        worker = await mediasoup.createWorker({
            logLevel: 'warn',
            rtcMinPort: 10000,
            rtcMaxPort: 59999
        });
        logger.info(`MediaSoup worker created with pid ${worker.pid}`);

        worker.on('died', () => {
            logger.error('MediaSoup worker died, exiting...');
            process.exit(1);
        });

        return worker;
    } catch (error) {
        logger.error('Failed to create MediaSoup worker:', error);
        process.exit(1);
    }
}

async function initializeServer() {
    try {
        await initializeMediaSoup();
        io.on('connection', (socket) => {
            logger.info(`New User Connected: ${socket.id}`);
            roomHandler(socket);

            const mediasoupMethods = mediasoupHandler(socket, io);
            streamHandler(socket, io, mediasoupMethods);

            socket.on('disconnect', () => {
                logger.info(`User Disconnected: ${socket.id}`);
            });
        });
        server.listen(serverConfig.PORT, () => {
            logger.info(`Server is running on PORT: ${serverConfig.PORT}`);
        });
    } catch (error) {
        logger.error('Failed to initialize server:', error);
        process.exit(1);
    }
}

process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection:', reason);
});

initializeServer();