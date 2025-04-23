import { Socket } from 'socket.io';
import { v4 as UUIDv4 } from 'uuid';

import { logger, serverConfig } from '../config';
import { IRoomParams } from '../types/IRoomParams.types';

const rooms: Record<string, string[]> = {};

const roomHandler = (socket: Socket) => {
    const createRoom = () => {
        const roomId = UUIDv4();
        socket.join(roomId);
        rooms[roomId] = [];

        socket.emit(serverConfig.ROOM_SOCKET, { roomId });
        logger.info(`Room Created withId: ${roomId}`);
    };

    const joinedRoom = ({ roomId, peerId }: IRoomParams) => {
        if (rooms[roomId]) {
            rooms[roomId].push(peerId);
            socket.join(roomId);

            logger.info(`A New User with userId: ${peerId} Joined with SocketId: ${socket.id} in Room: ${roomId}`);

            socket.data.peerId = peerId;
            socket.data.roomId = roomId;
            socket.on(serverConfig.READY_SOCKET, () => {
                logger.info(`User ${peerId} is ready in room ${roomId}`);
                socket.to(roomId).emit(serverConfig.USER_JOINED_SOCKET, { peerId });
            });

            socket.emit(serverConfig.USERS_SOCKET, {
                roomId,
                participants: rooms[roomId]
            });
        } else {
            logger.warn(`User ${peerId} tried to join non-existent room ${roomId}`);
            socket.emit('error', { message: 'Room not found' });
        }
    };

    const handleSignal = (data: any) => {
        const { to, from, type } = data;
        logger.info(`Signal: ${type} from ${from} to ${to}`);
        socket.to(data.to).emit(serverConfig.SIGNAL_SOCKET, data);
    };

    const handleDisconnect = () => {
        const { roomId, peerId } = socket.data;

        if (roomId && peerId && rooms[roomId]) {
            logger.info(`User ${peerId} disconnected from room ${roomId}`);

            rooms[roomId] = rooms[roomId].filter(id => id !== peerId);
            socket.to(roomId).emit(serverConfig.PEER_DISCONNECT, { peerId });
            if (rooms[roomId].length === 0) {
                logger.info(`Room ${roomId} is now empty. Cleaning up.`);
                delete rooms[roomId];
            }
        }
    };
    socket.on(serverConfig.CREATE_SOCKET, createRoom);
    socket.on(serverConfig.JOINED_SOCKET, joinedRoom);
    socket.on(serverConfig.SIGNAL_SOCKET, handleSignal);
    socket.on('disconnect', handleDisconnect);
};

export default roomHandler;