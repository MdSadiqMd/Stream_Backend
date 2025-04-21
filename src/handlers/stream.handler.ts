import { Socket } from 'socket.io';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

import { logger, serverConfig } from '../config';

interface IStreamParams {
    roomId: string;
    streamKey: string;
}

const activeStreams = new Map<string, {
    process: any;
    tempFilePath?: string;
}>();

const streamHandler = (socket: Socket) => {
    const startYouTubeStream = ({ roomId, streamKey }: IStreamParams, callback: Function) => {
        try {
            if (activeStreams.has(roomId)) {
                logger.error(`Room ${roomId} is already streaming`);
                return callback({ error: 'This room is already streaming to YouTube' });
            }
            logger.info(`Starting YouTube stream for room ${roomId}`);

            const tempDir = path.join(__dirname, '..', '..', 'temp');
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            const tempFilePath = path.join(tempDir, `stream-${roomId}-${uuidv4()}.webm`);
            const rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${streamKey}`;
            const ffmpegOptions = [
                // Input from stdin (binary data will be piped in)
                '-i', '-',

                // Video codec settings
                '-c:v', 'libx264',         // H.264 codec
                '-preset', 'veryfast',     // Encoding speed/compression ratio
                '-tune', 'zerolatency',    // Optimize for low latency
                '-r', '30',                // Framerate
                '-g', '60',                // GOP size (2 seconds)
                '-keyint_min', '30',       // Minimum keyframe interval
                '-b:v', '2500k',           // Video bitrate
                '-maxrate', '2500k',       // Maximum bitrate
                '-bufsize', '5000k',       // Buffer size

                // Color profile settings
                '-pix_fmt', 'yuv420p',     // Pixel format
                '-profile:v', 'main',      // H.264 profile
                '-level', '4.0',           // H.264 level

                // Audio codec settings
                '-c:a', 'aac',             // Audio codec
                '-b:a', '128k',            // Audio bitrate
                '-ar', '44100',            // Audio sample rate

                // Output format and destination
                '-f', 'flv',               // Output format (FLV for RTMP)
                rtmpUrl                    // YouTube RTMP URL
            ];

            const ffmpegProcess = spawn('ffmpeg', ffmpegOptions);
            ffmpegProcess.stdout.on('data', (data) => {
                logger.info(`FFmpeg stdout: ${data}`);
            });

            ffmpegProcess.stderr.on('data', (data) => {
                logger.info(`FFmpeg stderr: ${data}`);
            });

            ffmpegProcess.on('error', (error) => {
                logger.error(`FFmpeg process error: ${error.message}`);
                socket.to(roomId).emit(serverConfig.STREAMING_STATUS, { streaming: false });
                socket.emit(serverConfig.STREAMING_STATUS, { streaming: false });
                activeStreams.delete(roomId);
                if (fs.existsSync(tempFilePath)) {
                    fs.unlinkSync(tempFilePath);
                }
            });

            ffmpegProcess.on('close', (code) => {
                logger.info(`FFmpeg process for room ${roomId} exited with code ${code}`);
                socket.to(roomId).emit(serverConfig.STREAMING_STATUS, { streaming: false });
                socket.emit(serverConfig.STREAMING_STATUS, { streaming: false });
                activeStreams.delete(roomId);
                if (fs.existsSync(tempFilePath)) {
                    fs.unlinkSync(tempFilePath);
                }
            });

            activeStreams.set(roomId, {
                process: ffmpegProcess,
                tempFilePath
            });

            socket.join(`stream:${roomId}`);
            socket.to(roomId).emit(serverConfig.STREAMING_STATUS, { streaming: true });
            socket.emit(serverConfig.STREAMING_STATUS, { streaming: true });
            callback({ success: true });
        } catch (error) {
            logger.error(`Error starting YouTube stream: ${error}`);
            callback({ error: 'Failed to start streaming. Please try again.' });
        }
    };

    const stopYouTubeStream = ({ roomId }: { roomId: string; }, callback: Function) => {
        try {
            const streamData = activeStreams.get(roomId);
            if (!streamData) {
                logger.error(`No active stream found for room ${roomId}`);
                return callback({ error: 'No active stream found for this room' });
            }

            logger.info(`Stopping YouTube stream for room ${roomId}`);

            if (streamData.process) {
                streamData.process.stdin.end();
                setTimeout(() => {
                    if (streamData.process) {
                        streamData.process.kill('SIGINT');
                    }
                }, 500);
            }

            if (streamData.tempFilePath && fs.existsSync(streamData.tempFilePath)) {
                fs.unlinkSync(streamData.tempFilePath);
            }

            activeStreams.delete(roomId);
            socket.leave(`stream:${roomId}`);
            socket.to(roomId).emit(serverConfig.STREAMING_STATUS, { streaming: false });
            socket.emit(serverConfig.STREAMING_STATUS, { streaming: false });
            callback({ success: true });
        } catch (error) {
            logger.error(`Error stopping YouTube stream: ${error}`);
            callback({ error: 'Failed to stop streaming. Please try again.' });
        }
    };

    const handleBinaryStream = (data: any) => {
        const streamRoom = Array.from(socket.rooms)
            .find(room => room.startsWith('stream:'));
        if (!streamRoom) {
            logger.error(`Received binary stream but socket is not in any streaming room`);
            return;
        }

        const roomId = streamRoom.replace('stream:', '');
        const streamData = activeStreams.get(roomId);

        if (!streamData || !streamData.process) {
            logger.error(`Received binary stream for non-existent stream in room ${roomId}`);
            return;
        }

        if (streamData.process.killed || streamData.process.exitCode !== null) {
            logger.error(`FFmpeg process for room ${roomId} is no longer running`);
            socket.emit(serverConfig.STREAMING_STATUS, { streaming: false });
            activeStreams.delete(roomId);
            return;
        }
        streamData.process.stdin.write(data, (err: any) => {
            if (err) {
                logger.error(`Error writing to FFmpeg process: ${err}`);
                if (err.code === 'EPIPE' || err.code === 'EOF') {
                    logger.error('FFmpeg process closed pipe or ended');
                    stopYouTubeStream({ roomId }, () => { });
                }
            }
        });
    };

    socket.on(serverConfig.START_YOUTUBE_STREAM, startYouTubeStream);
    socket.on(serverConfig.STOP_YOUTUBE_STREAM, stopYouTubeStream);
    socket.on(serverConfig.BINARY_STREAM, handleBinaryStream);

    socket.on('disconnect', () => {
        for (const [roomId, streamData] of activeStreams.entries()) {
            if (socket.rooms?.has(`stream:${roomId}`)) {
                logger.info(`Cleaning up stream for room ${roomId} due to socket disconnect`);
                if (streamData.process) {
                    streamData.process.kill('SIGINT');
                }
                if (streamData.tempFilePath && fs.existsSync(streamData.tempFilePath)) {
                    fs.unlinkSync(streamData.tempFilePath);
                }

                activeStreams.delete(roomId);
                socket.to(roomId).emit(serverConfig.STREAMING_STATUS, { streaming: false });
            }
        }
    });
};

export default streamHandler;