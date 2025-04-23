export const serverConfig = {
    PORT: process.env.PORT || 4000,
    CREATE_SOCKET: 'create:room',
    ROOM_SOCKET: 'room:created',
    JOINED_SOCKET: 'joined:room',
    USERS_SOCKET: 'room:users',
    USER_JOINED_SOCKET: 'user:joined',
    READY_SOCKET: 'user:ready',
    START_HLS_STREAM: 'stream:start:hls',
    STOP_HLS_STREAM: 'stream:stop:hls',
    BINARY_STREAM: 'stream:binary',
    STREAMING_STATUS: 'stream:status',
    SIGNAL_SOCKET: 'signal',
    PEER_DISCONNECT: 'peer:disconnect'
};