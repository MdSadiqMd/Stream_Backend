import { Socket } from 'socket.io';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { logger, serverConfig } from '../config';

interface IStreamParams {
    roomId: string;
}

const activeStreams = new Map<string, {
    process: any;
    outputDir: string;
    isActive: boolean;
}>();

const streamHandler = (socket: Socket) => {
    const startHLSStream = ({ roomId }: IStreamParams, callback: Function) => {
        try {
            if (activeStreams.has(roomId) && activeStreams.get(roomId)?.isActive) {
                logger.error(`Room ${roomId} is already streaming`);
                return callback({ error: 'This room is already streaming' });
            }
            logger.info(`Starting HLS stream for room ${roomId}`);

            const outputDir = path.join(__dirname, '..', '..', 'public', 'streams', roomId);
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            } else {
                const files = fs.readdirSync(outputDir);
                files.forEach(file => {
                    fs.unlinkSync(path.join(outputDir, file));
                });
            }

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

                // Audio codec settings
                '-c:a', 'aac',             // Audio codec
                '-b:a', '128k',            // Audio bitrate
                '-ar', '44100',            // Audio sample rate

                // HLS specific settings
                '-f', 'hls',               // Output format: HLS
                '-hls_time', '2',          // Segment duration in seconds
                '-hls_list_size', '10',    // Number of segments to keep in playlist
                '-hls_flags', 'delete_segments+append_list',  // Delete old segments
                '-hls_segment_type', 'mpegts',  // Segment file type
                '-hls_segment_filename', `${outputDir}/segment_%03d.ts`,  // Segment naming pattern
                `${outputDir}/playlist.m3u8`    // Playlist file
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
                if (activeStreams.has(roomId)) {
                    activeStreams.get(roomId)!.isActive = false;
                }
            });

            ffmpegProcess.on('close', (code) => {
                logger.info(`FFmpeg process for room ${roomId} exited with code ${code}`);
                socket.to(roomId).emit(serverConfig.STREAMING_STATUS, { streaming: false });
                socket.emit(serverConfig.STREAMING_STATUS, { streaming: false });
                if (activeStreams.has(roomId)) {
                    activeStreams.get(roomId)!.isActive = false;
                }
            });

            activeStreams.set(roomId, {
                process: ffmpegProcess,
                outputDir,
                isActive: true
            });

            socket.join(`stream:${roomId}`);
            socket.to(roomId).emit(serverConfig.STREAMING_STATUS, {
                streaming: true,
                playbackUrl: `/streams/${roomId}/playlist.m3u8`
            });
            socket.emit(serverConfig.STREAMING_STATUS, {
                streaming: true,
                playbackUrl: `/streams/${roomId}/playlist.m3u8`
            });

            callback({
                success: true,
                playbackUrl: `/streams/${roomId}/playlist.m3u8`
            });
        } catch (error) {
            logger.error(`Error starting HLS stream: ${error}`);
            callback({ error: 'Failed to start streaming. Please try again.' });
        }
    };

    const stopHLSStream = ({ roomId }: { roomId: string; }, callback: Function) => {
        try {
            const streamData = activeStreams.get(roomId);
            if (!streamData || !streamData.isActive) {
                logger.error(`No active stream found for room ${roomId}`);
                return callback({ error: 'No active stream found for this room' });
            }

            logger.info(`Stopping HLS stream for room ${roomId}`);

            if (streamData.process) {
                streamData.process.stdin.end();
                setTimeout(() => {
                    if (streamData.process) {
                        streamData.process.kill('SIGINT');
                    }
                }, 500);
            }

            streamData.isActive = false;
            socket.leave(`stream:${roomId}`);
            socket.to(roomId).emit(serverConfig.STREAMING_STATUS, { streaming: false });
            socket.emit(serverConfig.STREAMING_STATUS, { streaming: false });
            callback({ success: true });
        } catch (error) {
            logger.error(`Error stopping HLS stream: ${error}`);
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

        if (!streamData || !streamData.isActive || !streamData.process) {
            logger.error(`Received binary stream for non-existent stream in room ${roomId}`);
            return;
        }

        if (streamData.process.killed || streamData.process.exitCode !== null) {
            logger.error(`FFmpeg process for room ${roomId} is no longer running`);
            socket.emit(serverConfig.STREAMING_STATUS, { streaming: false });
            streamData.isActive = false;
            return;
        }
        streamData.process.stdin.write(data, (err: any) => {
            if (err) {
                logger.error(`Error writing to FFmpeg process: ${err}`);
                if (err.code === 'EPIPE' || err.code === 'EOF') {
                    logger.error('FFmpeg process closed pipe or ended');
                    stopHLSStream({ roomId }, () => { });
                }
            }
        });
    };

    socket.on(serverConfig.START_HLS_STREAM, startHLSStream);
    socket.on(serverConfig.STOP_HLS_STREAM, stopHLSStream);
    socket.on(serverConfig.BINARY_STREAM, handleBinaryStream);

    socket.on('disconnect', () => {
        for (const [roomId, streamData] of activeStreams.entries()) {
            if (socket.rooms?.has(`stream:${roomId}`) && streamData.isActive) {
                logger.info(`Cleaning up stream for room ${roomId} due to socket disconnect`);
                if (streamData.process) {
                    streamData.process.kill('SIGINT');
                }
                streamData.isActive = false;
                socket.to(roomId).emit(serverConfig.STREAMING_STATUS, { streaming: false });
            }
        }
    });
};

export default streamHandler;