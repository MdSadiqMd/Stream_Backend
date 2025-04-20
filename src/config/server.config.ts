// src/config/server.config.ts
import dotenv from 'dotenv';

dotenv.config();

const serverConfig = {
    PORT: process.env.PORT || 4000,

    // Socket events for room management
    ROOM_SOCKET: 'room-created',
    USERS_SOCKET: 'get-users',
    JOINED_SOCKET: 'joined-room',
    CREATE_SOCKET: 'create-room',
    USER_JOINED_SOCKET: 'user-joined',
    READY_SOCKET: 'ready',
    CALL_SOCKET: 'call',
    STRAM_SOCKET: 'stream',

    // New events for MediaSoup and YouTube streaming
    GET_ROUTER_RTP_CAPABILITIES: 'get-router-rtp-capabilities',
    CREATE_WEBRTC_TRANSPORT: 'create-webrtc-transport',
    CONNECT_WEBRTC_TRANSPORT: 'connect-webrtc-transport',
    PRODUCE: 'produce',
    CONSUME: 'consume',
    START_YOUTUBE_STREAM: 'start-youtube-stream',
    STOP_YOUTUBE_STREAM: 'stop-youtube-stream',
    STREAMING_STATUS: 'streaming-status',

    // MediaSoup configurations
    MEDIASOUP: {
        WORKER: {
            rtcMinPort: 10000,
            rtcMaxPort: 59999,
            logLevel: 'warn',
            logTags: [
                'info',
                'ice',
                'dtls',
                'rtp',
                'srtp',
                'rtcp'
            ]
        },
        ROUTER: {
            mediaCodecs: [
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
            ]
        },
        WEBRTC_TRANSPORT: {
            listenIps: [
                {
                    ip: '0.0.0.0',
                    announcedIp: process.env.ANNOUNCED_IP || '127.0.0.1'
                }
            ],
            initialAvailableOutgoingBitrate: 1000000,
            minimumAvailableOutgoingBitrate: 600000,
            maxSctpMessageSize: 262144,
            maxIncomingBitrate: 1500000
        }
    },

    // Network configuration
    ANNOUNCED_IP: process.env.ANNOUNCED_IP || '127.0.0.1',

    // Temporary files location
    TMP_DIR: process.env.TMP_DIR || './tmp'
};

export default serverConfig;