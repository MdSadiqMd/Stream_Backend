import { Socket } from 'socket.io';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { logger } from '../config';

interface StreamParams {
    roomId: string;
    youtubeUrl: string;
}

const activeStreams: Record<string, {
    ffmpegProcess: ChildProcessWithoutNullStreams,
    sdpFilePath: string;
}> = {};

const streamHandler = (socket: Socket, io: any, mediasoupMethods: any) => {
    const startYouTubeStream = async ({ roomId, youtubeUrl }: StreamParams, callback: Function) => {
        logger.info(`Request to start YouTube stream for room: ${roomId}`);

        try {
            if (activeStreams[roomId]) {
                logger.warn(`Room ${roomId} is already streaming`);
                return callback({ error: 'This room is already streaming' });
            }

            const mediaInfo = await mediasoupMethods.extractMediaForStreaming({ roomId });
            if (!mediaInfo || !mediaInfo.video) {
                logger.error(`No video found in room ${roomId} for streaming`);
                return callback({ error: 'No video stream available for streaming' });
            }

            const sdpContent = createSdpFile(
                mediaInfo.video.transport.tuple.localPort,
                mediaInfo.video.consumer.rtpParameters,
                mediaInfo.audio ? mediaInfo.audio.transport.tuple.localPort : null,
                mediaInfo.audio ? mediaInfo.audio.consumer.rtpParameters : null
            );

            const sdpFilePath = path.join(__dirname, `../tmp/${roomId}.sdp`);
            const tmpDir = path.join(__dirname, '../tmp');
            if (!fs.existsSync(tmpDir)) {
                fs.mkdirSync(tmpDir, { recursive: true });
            }

            fs.writeFileSync(sdpFilePath, sdpContent);
            logger.info(`Created SDP file at ${sdpFilePath}`);

            const ffmpegCommand = [
                '-protocol_whitelist', 'file,udp,rtp',
                '-i', sdpFilePath,
                '-map', '0:v:0',
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-tune', 'zerolatency',
                '-profile:v', 'main',
                '-level', '4.1',
                '-b:v', '2500k',
                '-bufsize', '5000k',
                '-maxrate', '2500k',
                '-g', '60', // Keyframe every 2 seconds at 30fps
                '-keyint_min', '60'
            ];

            // Add audio if available
            if (mediaInfo.audio) {
                ffmpegCommand.push(
                    '-map', '0:a:0',
                    '-c:a', 'aac',
                    '-b:a', '128k',
                    '-ar', '44100'
                );
            }

            ffmpegCommand.push(
                '-f', 'flv',
                youtubeUrl
            );

            logger.info(`Starting FFmpeg with command: ffmpeg ${ffmpegCommand.join(' ')}`);

            const ffmpeg = spawn('ffmpeg', ffmpegCommand);
            ffmpeg.stdout.on('data', (data) => {
                logger.info(`FFmpeg stdout: ${data}`);
            });

            ffmpeg.stderr.on('data', (data) => {
                logger.info(`FFmpeg stderr: ${data.toString()}`);
            });

            ffmpeg.on('close', (code) => {
                logger.info(`FFmpeg process exited with code ${code}`);
                cleanupStream(roomId);
                io.to(roomId).emit('streaming-status', { streaming: false });
            });

            activeStreams[roomId] = {
                ffmpegProcess: ffmpeg,
                sdpFilePath
            };

            io.to(roomId).emit('streaming-status', { streaming: true });
            callback({ success: true });
        } catch (error) {
            logger.error('Error starting YouTube stream:', error);
            callback({ error: 'Failed to start streaming' });
        }
    };

    const stopYouTubeStream = ({ roomId }: { roomId: string; }, callback: Function) => {
        logger.info(`Request to stop YouTube stream for room: ${roomId}`);
        try {
            if (!activeStreams[roomId]) {
                logger.warn(`Room ${roomId} is not streaming`);
                return callback({ error: 'This room is not streaming' });
            }

            activeStreams[roomId].ffmpegProcess.kill('SIGINT');
            cleanupStream(roomId);
            io.to(roomId).emit('streaming-status', { streaming: false });
            callback({ success: true });
        } catch (error) {
            logger.error('Error stopping YouTube stream:', error);
            callback({ error: 'Failed to stop streaming' });
        }
    };

    const cleanupStream = (roomId: string) => {
        if (!activeStreams[roomId]) return;
        const { sdpFilePath } = activeStreams[roomId];
        if (fs.existsSync(sdpFilePath)) {
            fs.unlinkSync(sdpFilePath);
            logger.info(`Removed SDP file at ${sdpFilePath}`);
        }

        delete activeStreams[roomId];
        logger.info(`Cleaned up stream for room: ${roomId}`);
    };

    const cleanupStreamsOnDisconnect = () => {
        Object.keys(activeStreams).forEach(roomId => {
            if (socket.rooms && socket.rooms.has(roomId)) {
                const room = io.sockets.adapter.rooms.get(roomId);
                if (!room || room.size <= 1) {
                    logger.info(`Cleaning up stream for room: ${roomId} on disconnect`);
                    activeStreams[roomId].ffmpegProcess.kill('SIGINT');
                    cleanupStream(roomId);
                }
            }
        });
    };

    function createSdpFile(
        videoPort: number,
        videoRtpParameters: any,
        audioPort: number | null,
        audioRtpParameters: any | null
    ) {
        const videoCodec = videoRtpParameters.codecs[0];

        let sdp = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=WebRTC to YouTube
c=IN IP4 127.0.0.1
t=0 0
`;

        sdp += `m=video ${videoPort} RTP/AVP ${videoCodec.payloadType}
a=rtpmap:${videoCodec.payloadType} ${videoCodec.mimeType.split('/')[1]}/${videoCodec.clockRate}
a=sendonly
`;

        if (videoCodec.parameters) {
            const fmtpParams = Object.keys(videoCodec.parameters)
                .map(key => `${key}=${videoCodec.parameters[key]}`)
                .join(';');

            if (fmtpParams) {
                sdp += `a=fmtp:${videoCodec.payloadType} ${fmtpParams}\n`;
            }
        }

        if (videoRtpParameters.encodings && videoRtpParameters.encodings.length > 0) {
            const encoding = videoRtpParameters.encodings[0];
            if (encoding.ssrc) {
                sdp += `a=ssrc:${encoding.ssrc} cname:webrtc\n`;
            }
        }

        if (audioPort && audioRtpParameters) {
            const audioCodec = audioRtpParameters.codecs[0];

            sdp += `m=audio ${audioPort} RTP/AVP ${audioCodec.payloadType}
a=rtpmap:${audioCodec.payloadType} ${audioCodec.mimeType.split('/')[1]}/${audioCodec.clockRate}${audioCodec.channels > 1 ? '/' + audioCodec.channels : ''}
a=sendonly
`;

            if (audioCodec.parameters) {
                const fmtpParams = Object.keys(audioCodec.parameters)
                    .map(key => `${key}=${audioCodec.parameters[key]}`)
                    .join(';');

                if (fmtpParams) {
                    sdp += `a=fmtp:${audioCodec.payloadType} ${fmtpParams}\n`;
                }
            }

            if (audioRtpParameters.encodings && audioRtpParameters.encodings.length > 0) {
                const encoding = audioRtpParameters.encodings[0];
                if (encoding.ssrc) {
                    sdp += `a=ssrc:${encoding.ssrc} cname:webrtc\n`;
                }
            }
        }
        return sdp;
    }

    socket.on('start-youtube-stream', startYouTubeStream);
    socket.on('stop-youtube-stream', stopYouTubeStream);
    socket.on('disconnect', cleanupStreamsOnDisconnect);
};

export default streamHandler;