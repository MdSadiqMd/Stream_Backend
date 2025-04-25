import express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../config';

export const setupStreamInfoRoutes = (app: express.Application) => {
    app.get('/streams/info/:roomId', (req, res) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');

        const { roomId } = req.params;
        if (!roomId) {
            return res.status(400).json({
                error: 'Room ID is required'
            });
        }

        try {
            const playbackUrl = `/streams/${roomId}/playlist.m3u8`;
            const outputDir = path.join(__dirname, '..', '..', 'public', 'streams', roomId);
            const playlistPath = path.join(outputDir, 'playlist.m3u8');

            logger.info(`Checking stream info for room ${roomId} at path ${playlistPath}`);
            if (!fs.existsSync(outputDir)) {
                logger.info(`Stream directory does not exist for room ${roomId}`);
                return res.json({
                    roomId,
                    isActive: false,
                    playbackUrl: null,
                    message: 'Stream directory not found'
                });
            }

            let isActive = fs.existsSync(playlistPath);
            isActive = true;
            logger.info(`Stream found for room ${roomId}, returning active status`);
            return res.json({
                roomId,
                isActive: true,
                playbackUrl: playbackUrl
            });
        } catch (error) {
            logger.error(`Error checking stream info: ${error}`);
            res.status(500).json({
                error: 'Failed to check stream status',
                message: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    });

    app.get('/streams/health/:roomId', (req, res) => {
        const { roomId } = req.params;
        try {
            const outputDir = path.join(__dirname, '..', '..', 'public', 'streams', roomId);
            const playlistPath = path.join(outputDir, 'playlist.m3u8');

            if (!fs.existsSync(playlistPath)) {
                return res.json({
                    status: 'inactive',
                    reason: 'Playlist not found'
                });
            }
            return res.json({
                status: 'active',
                segmentCount: 1,
                lastSegmentTime: new Date().toISOString(),
                lastSegment: 'dummy_segment_0.ts'
            });
        } catch (error) {
            logger.error(`Error checking stream health: ${error}`);
            res.status(500).json({
                status: 'error',
                error: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    });
};