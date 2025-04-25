import { Socket } from 'socket.io';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { logger, serverConfig } from '../config';

interface IStreamParams {
    roomId: string;
}

const activeStreams = new Map();
class ChunkBuffer {
    chunks: Buffer[];
    maxSize: number;
    totalBytes: number;

    constructor(maxSize = 10) {
        this.chunks = [];
        this.maxSize = maxSize;
        this.totalBytes = 0;
    }

    add(chunk: Buffer) {
        this.chunks.push(chunk);
        this.totalBytes += chunk.length;
        while (this.chunks.length > this.maxSize) {
            const removed = this.chunks.shift();
            if (removed) {
                this.totalBytes -= removed.length;
            }
        }
    }

    getChunks() {
        return this.chunks;
    }

    clear() {
        this.chunks = [];
        this.totalBytes = 0;
    }

    isEmpty() {
        return this.chunks.length === 0;
    }
}

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

            createInitialSegments(outputDir, roomId);
            activeStreams.set(roomId, {
                process: null,
                outputDir,
                isActive: true,
                chunkBuffer: new ChunkBuffer(20),
                initialized: false,
                restartCount: 0,
                lastFrameTime: Date.now()
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
            initializeStreamProcessor(roomId);
        } catch (error) {
            logger.error(`Error starting HLS stream: ${error}`);
            callback({ error: 'Failed to start streaming. Please try again.' });
        }
    };

    const createInitialSegments = (outputDir: string, roomId: string) => {
        const playlistContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:4.000000,
dummy_segment_0.ts
`;
        fs.writeFileSync(path.join(outputDir, 'playlist.m3u8'), playlistContent);
        const dummySegment = Buffer.alloc(1024);
        fs.writeFileSync(path.join(outputDir, 'dummy_segment_0.ts'), dummySegment);
        logger.info(`Created initial HLS files for room ${roomId}`);
    };

    const initializeStreamProcessor = (roomId: string) => {
        const streamData = activeStreams.get(roomId);
        if (!streamData) return;
        logger.info(`Initializing stream processor for room ${roomId}`);

        const ffmpegOptions = [
            // First try with WebM format which is most likely from browser
            '-f', 'webm',              // WebM container format
            '-i', 'pipe:0',            // Read from stdin pipe

            // Ensure consistent output regardless of input format
            '-c:v', 'libx264',         // H.264 video codec
            '-preset', 'ultrafast',    // Fastest encoding
            '-tune', 'zerolatency',    // Optimize for low latency
            '-profile:v', 'baseline',  // Most compatible profile
            '-pix_fmt', 'yuv420p',     // Standard pixel format
            '-g', '30',                // Keyframe every 30 frames
            '-sc_threshold', '0',      // Disable scene change detection
            '-b:v', '800k',            // Video bitrate
            '-bufsize', '1600k',       // Double of bitrate
            '-maxrate', '1000k',       // Maximum video bitrate

            // Audio settings
            '-c:a', 'aac',             // AAC audio codec
            '-b:a', '128k',            // Audio bitrate
            '-ar', '44100',            // Audio sample rate

            // HLS specific settings - optimized for low latency
            '-f', 'hls',                      // Output format: HLS
            '-hls_time', '1',                 // Shorter segment duration (1s)
            '-hls_list_size', '6',            // Fewer segments in playlist for lower latency
            '-hls_flags', 'delete_segments+append_list+program_date_time',
            '-hls_segment_type', 'mpegts',    // Segment file type
            '-hls_segment_filename', `${streamData.outputDir}/segment_%03d.ts`,
            `${streamData.outputDir}/playlist.m3u8`
        ];

        const ffmpegProcess = spawn('ffmpeg', ffmpegOptions);
        ffmpegProcess.stdout.on('data', (data) => {
            logger.info(`FFmpeg stdout: ${data}`);
        });
        ffmpegProcess.stderr.on('data', (data) => {
            if (streamData.logCounter === undefined) streamData.logCounter = 0;
            streamData.logCounter++;

            if (streamData.logCounter % 10 === 0) {
                logger.info(`FFmpeg stderr (${roomId}): ${data.toString().substring(0, 150)}...`);
            }
        });

        ffmpegProcess.on('error', (error) => {
            logger.error(`FFmpeg process error for room ${roomId}: ${error.message}`);
            tryBackupProcessor(roomId);
        });

        ffmpegProcess.on('close', (code) => {
            logger.info(`FFmpeg process for room ${roomId} exited with code ${code}`);

            if (streamData.isActive) {
                tryBackupProcessor(roomId);
            } else {
                socket.to(roomId).emit(serverConfig.STREAMING_STATUS, { streaming: false });
                socket.emit(serverConfig.STREAMING_STATUS, { streaming: false });
            }
        });

        streamData.process = ffmpegProcess;
        streamData.initialized = true;
        streamData.format = 'webm';
        const chunks = streamData.chunkBuffer.getChunks();
        if (chunks.length > 0) {
            logger.info(`Writing ${chunks.length} buffered chunks for room ${roomId}`);
            for (const chunk of chunks) {
                try {
                    ffmpegProcess.stdin.write(chunk);
                } catch (e) {
                    logger.error(`Error writing buffered chunk: ${e}`);
                }
            }
        }

        const healthCheckInterval = setInterval(() => {
            if (!activeStreams.has(roomId) || !streamData.isActive) {
                clearInterval(healthCheckInterval);
                return;
            }
            const now = Date.now();
            if (now - streamData.lastFrameTime > 10000) {
                logger.warn(`No data received for 10s in room ${roomId}, restarting processor`);
                restartProcessor(roomId);
            }
        }, 5000);

        streamData.healthCheckInterval = healthCheckInterval;
    };

    const restartProcessor = (roomId: string) => {
        const streamData = activeStreams.get(roomId);
        if (!streamData || !streamData.isActive) return;
        if (streamData.restartCount >= 5) {
            logger.error(`Exceeded restart limit for room ${roomId}, falling back to test pattern`);
            generateTestPattern(roomId);
            return;
        }

        logger.info(`Restarting stream processor for room ${roomId} (attempt ${streamData.restartCount + 1})`);

        if (streamData.process) {
            try {
                streamData.process.stdin.end();
                streamData.process.kill('SIGTERM');
            } catch (e) {
                logger.error(`Error closing processor: ${e}`);
            }
        }
        if (streamData.healthCheckInterval) {
            clearInterval(streamData.healthCheckInterval);
        }
        streamData.restartCount++;
        streamData.initialized = false;

        setTimeout(() => {
            initializeStreamProcessor(roomId);
        }, 1000);
    };

    const tryBackupProcessor = (roomId: string) => {
        const streamData = activeStreams.get(roomId);
        if (!streamData || !streamData.isActive) return;

        logger.info(`Trying backup processor for room ${roomId}`);

        if (streamData.format === 'webm' && streamData.restartCount >= 2) {
            streamData.format = 'matroska';
            streamData.restartCount = 0;
            restartProcessor(roomId);
        } else if (streamData.format === 'matroska' && streamData.restartCount >= 2) {
            generateTestPattern(roomId);
        } else {
            restartProcessor(roomId);
        }
    };

    const generateTestPattern = (roomId: string) => {
        const streamData = activeStreams.get(roomId);
        if (!streamData || !streamData.isActive) return;

        logger.info(`Falling back to test pattern for room ${roomId}`);

        if (streamData.process) {
            try {
                streamData.process.stdin.end();
                streamData.process.kill('SIGTERM');
            } catch (e) {
                logger.error(`Error closing process: ${e}`);
            }
        }

        if (streamData.healthCheckInterval) {
            clearInterval(streamData.healthCheckInterval);
        }

        const testPatternOptions = [
            '-f', 'lavfi',                 // Use lavfi input format
            '-i', 'testsrc=size=640x480:rate=30,drawtext=text=\'Live Stream\':fontsize=24:fontcolor=white:x=(w-text_w)/2:y=h-40',
            '-t', '600',                   // 10 minutes duration
            '-c:v', 'libx264',             // H.264 codec
            '-pix_fmt', 'yuv420p',         // Standard pixel format
            '-profile:v', 'baseline',      // Most compatible profile
            '-b:v', '800k',                // Video bitrate
            '-f', 'hls',                   // Output format: HLS
            '-hls_time', '2',              // Segment duration
            '-hls_list_size', '6',         // Segments in playlist
            '-hls_flags', 'delete_segments+append_list',
            '-hls_segment_type', 'mpegts',
            '-hls_segment_filename', `${streamData.outputDir}/segment_%03d.ts`,
            `${streamData.outputDir}/playlist.m3u8`
        ];

        const ffmpegProcess = spawn('ffmpeg', testPatternOptions);

        ffmpegProcess.stderr.on('data', (data) => {
            if (streamData.logCounter === undefined) streamData.logCounter = 0;
            streamData.logCounter++;

            if (streamData.logCounter % 20 === 0) {
                logger.info(`Test pattern FFmpeg (${roomId}): ${data.toString().substring(0, 100)}...`);
            }
        });

        ffmpegProcess.on('error', (error) => {
            logger.error(`Test pattern FFmpeg error: ${error.message}`);
            socket.to(roomId).emit(serverConfig.STREAMING_STATUS, { streaming: false });
            socket.emit(serverConfig.STREAMING_STATUS, { streaming: false });
        });

        ffmpegProcess.on('close', (code) => {
            logger.info(`Test pattern FFmpeg process exited with code ${code}`);
            socket.to(roomId).emit(serverConfig.STREAMING_STATUS, { streaming: false });
            socket.emit(serverConfig.STREAMING_STATUS, { streaming: false });

            if (activeStreams.has(roomId)) {
                activeStreams.get(roomId)!.isActive = false;
            }
        });

        streamData.process = ffmpegProcess;
        streamData.format = 'test-pattern';
        streamData.initialized = true;
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
                try {
                    streamData.process.stdin.end();
                } catch (e) {
                    logger.error(`Error ending FFmpeg stdin: ${e}`);
                }

                setTimeout(() => {
                    if (streamData.process) {
                        try {
                            streamData.process.kill('SIGINT');
                        } catch (e) {
                            logger.error(`Error killing FFmpeg process: ${e}`);
                        }
                    }
                }, 500);
            }

            if (streamData.healthCheckInterval) {
                clearInterval(streamData.healthCheckInterval);
            }

            streamData.isActive = false;
            streamData.initialized = false;
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
            return;
        }

        const roomId = streamRoom.replace('stream:', '');
        const streamData = activeStreams.get(roomId);
        if (!streamData || !streamData.isActive) {
            return;
        }

        try {
            streamData.lastFrameTime = Date.now();
            const buffer = Buffer.from(data);
            streamData.chunkBuffer.add(buffer);
            if (!streamData.initialized) {
                if (streamData.chunkBuffer.getChunks().length >= 3) {
                    initializeStreamProcessor(roomId);
                }
                return;
            }

            if (streamData.process && !streamData.process.killed && streamData.process.exitCode === null) {
                try {
                    streamData.process.stdin.write(buffer, (err: any) => {
                        if (err) {
                            if (!streamData.hasLoggedWriteError) {
                                logger.error(`Error writing to process: ${err}`);
                                streamData.hasLoggedWriteError = true;
                            }
                        }
                    });
                } catch (error) {
                    if (!streamData.hasLoggedWriteError) {
                        logger.error(`Exception writing to process: ${error}`);
                        streamData.hasLoggedWriteError = true;
                    }
                }
            }
        } catch (error) {
            if (!streamData.hasLoggedHandleError) {
                logger.error(`Error handling binary stream: ${error}`);
                streamData.hasLoggedHandleError = true;
            }
        }
    };

    socket.on(serverConfig.START_HLS_STREAM, startHLSStream);
    socket.on(serverConfig.STOP_HLS_STREAM, stopHLSStream);
    socket.on(serverConfig.BINARY_STREAM, handleBinaryStream);

    socket.on('disconnect', () => {
        for (const [roomId, streamData] of activeStreams.entries()) {
            if (socket.rooms?.has(`stream:${roomId}`) && streamData.isActive) {
                logger.info(`Cleaning up stream for room ${roomId} due to socket disconnect`);
                if (streamData.process) {
                    try {
                        streamData.process.kill('SIGINT');
                    } catch (e) {
                        logger.error(`Error killing process: ${e}`);
                    }
                }

                if (streamData.healthCheckInterval) {
                    clearInterval(streamData.healthCheckInterval);
                }
                streamData.isActive = false;
                streamData.initialized = false;
                socket.to(roomId).emit(serverConfig.STREAMING_STATUS, { streaming: false });
            }
        }
    });
};

export default streamHandler;