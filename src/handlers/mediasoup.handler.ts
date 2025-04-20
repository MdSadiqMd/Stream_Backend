import { Socket } from 'socket.io';
import * as mediasoup from 'mediasoup';

import { logger, serverConfig } from '../config';

let worker: mediasoup.types.Worker;
const routers: Record<string, mediasoup.types.Router> = {};
const producers: Record<string, mediasoup.types.Producer> = {};
const consumers: Record<string, mediasoup.types.Consumer> = {};
const transports: Record<string, mediasoup.types.Transport> = {};
const plainTransports: Record<string, mediasoup.types.PlainTransport> = {};

// Fixed mediaCodecs to use the correct types for MediaKind
const mediaCodecs: mediasoup.types.RtpCodecCapability[] = [
    {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
    },
    {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
            'x-google-start-bitrate': 1000
        }
    },
    {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',
            'level-asymmetry-allowed': 1,
            'x-google-start-bitrate': 1000
        }
    }
];

async function initializeMediaSoup() {
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
}

async function createRouter(roomId: string) {
    if (routers[roomId]) {
        return routers[roomId];
    }

    const router = await worker.createRouter({ mediaCodecs });
    routers[roomId] = router;

    logger.info(`MediaSoup router created for room ${roomId}`);
    return router;
}

interface TransportAppData {
    [key: string]: any;
    socketId?: string;
    roomId?: string;
    transportId?: string;
}

const mediasoupHandler = (socket: Socket, io: any) => {
    const getRouterRtpCapabilities = async ({ roomId }: { roomId: string; }, callback: Function) => {
        try {
            if (!worker) {
                await initializeMediaSoup();
            }

            const router = await createRouter(roomId);
            callback({ rtpCapabilities: router.rtpCapabilities });
        } catch (error) {
            logger.error('Error getting router RTP capabilities:', error);
            callback({ error: 'Failed to get router RTP capabilities' });
        }
    };

    const createWebRtcTransport = async ({ roomId }: { roomId: string; }, callback: Function) => {
        try {
            const router = routers[roomId];
            if (!router) {
                return callback({ error: 'Router not found' });
            }

            const transport = await router.createWebRtcTransport({
                listenIps: [
                    {
                        ip: '0.0.0.0',
                        announcedIp: serverConfig.ANNOUNCED_IP || '127.0.0.1'
                    }
                ],
                enableUdp: true,
                enableTcp: true,
                preferUdp: true
            });

            // Set appData correctly
            transport.appData = {
                socketId: socket.id,
                roomId: roomId
            } as TransportAppData;

            const transportId = transport.id;
            transports[transportId] = transport;

            logger.info(`WebRTC transport created for room ${roomId} with id ${transportId}`);
            callback({
                transportId,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters
            });
        } catch (error) {
            logger.error('Error creating WebRTC transport:', error);
            callback({ error: 'Failed to create WebRTC transport' });
        }
    };

    const connectWebRtcTransport = async ({ transportId, dtlsParameters }: any, callback: Function) => {
        try {
            const transport = transports[transportId];
            if (!transport) {
                return callback({ error: 'Transport not found' });
            }

            await transport.connect({ dtlsParameters });

            logger.info(`WebRTC transport ${transportId} connected`);
            callback({ success: true });
        } catch (error) {
            logger.error('Error connecting WebRTC transport:', error);
            callback({ error: 'Failed to connect WebRTC transport' });
        }
    };

    const produce = async ({ transportId, kind, rtpParameters }: any, callback: Function) => {
        try {
            const transport = transports[transportId];
            if (!transport) {
                return callback({ error: 'Transport not found' });
            }

            // Store the transportId in producer appData
            const producer = await transport.produce({
                kind,
                rtpParameters,
                appData: { transportId }
            });

            const producerId = producer.id;
            producers[producerId] = producer;

            logger.info(`Producer ${producerId} created with kind ${kind}`);

            producer.on('transportclose', () => {
                logger.info(`Producer ${producerId} closed due to transport closure`);
                delete producers[producerId];
            });

            callback({ producerId });
        } catch (error) {
            logger.error('Error producing:', error);
            callback({ error: 'Failed to produce' });
        }
    };

    const createPlainTransport = async ({ roomId }: { roomId: string; }) => {
        try {
            const router = routers[roomId];
            if (!router) {
                throw new Error('Router not found');
            }

            // Use empty string instead of null for announcedIp
            const transport = await router.createPlainTransport({
                listenIp: { ip: '127.0.0.1', announcedIp: '' },
                rtcpMux: false,
                comedia: false
            });

            // Set appData correctly
            transport.appData = {
                roomId,
                socketId: socket.id
            } as TransportAppData;

            const transportId = transport.id;
            plainTransports[transportId] = transport;

            logger.info(`Plain transport created for room ${roomId} with id ${transportId}`);

            return transport;
        } catch (error) {
            logger.error('Error creating plain transport:', error);
            throw error;
        }
    };

    const extractMediaForStreaming = async ({ roomId }: { roomId: string; }) => {
        try {
            let videoProducer = null;
            let audioProducer = null;

            for (const producerId in producers) {
                const producer = producers[producerId];

                // Access appData safely with proper type casting
                const transportId = (producer.appData as TransportAppData).transportId;
                if (!transportId) continue;

                const transport = transports[transportId];
                if (!transport) continue;

                // Access appData safely with proper type casting
                const transportRoomId = (transport.appData as TransportAppData).roomId;
                if (transportRoomId === roomId) {
                    if (producer.kind === 'video' && !videoProducer) {
                        videoProducer = producer;
                    } else if (producer.kind === 'audio' && !audioProducer) {
                        audioProducer = producer;
                    }
                }

                if (videoProducer && audioProducer) break;
            }

            if (!videoProducer) {
                throw new Error('No video producer found in the room');
            }

            const videoPlainTransport = await createPlainTransport({ roomId });
            let audioPlainTransport = null;
            if (audioProducer) {
                audioPlainTransport = await createPlainTransport({ roomId });
            }

            const videoConsumer = await videoPlainTransport.consume({
                producerId: videoProducer.id,
                rtpCapabilities: routers[roomId].rtpCapabilities,
                paused: false
            });

            let audioConsumer = null;
            if (audioProducer && audioPlainTransport) {
                audioConsumer = await audioPlainTransport.consume({
                    producerId: audioProducer.id,
                    rtpCapabilities: routers[roomId].rtpCapabilities,
                    paused: false
                });
            }

            if (videoConsumer) {
                consumers[videoConsumer.id] = videoConsumer;
            }

            if (audioConsumer) {
                consumers[audioConsumer.id] = audioConsumer;
            }

            return {
                video: {
                    transport: videoPlainTransport,
                    consumer: videoConsumer
                },
                audio: audioPlainTransport && audioConsumer ? {
                    transport: audioPlainTransport,
                    consumer: audioConsumer
                } : null
            };
        } catch (error) {
            logger.error('Error extracting media for streaming:', error);
            throw error;
        }
    };

    socket.on('get-router-rtp-capabilities', getRouterRtpCapabilities);
    socket.on('create-webrtc-transport', createWebRtcTransport);
    socket.on('connect-webrtc-transport', connectWebRtcTransport);
    socket.on('produce', produce);

    socket.on('disconnect', () => {
        for (const transportId in transports) {
            const transport = transports[transportId];
            const socketId = (transport.appData as TransportAppData).socketId;
            if (socketId === socket.id) {
                transport.close();
                delete transports[transportId];
            }
        }
    });

    return {
        extractMediaForStreaming
    };
};

export default mediasoupHandler;