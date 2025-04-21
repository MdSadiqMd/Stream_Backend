export const serverConfig = {
    PORT: process.env.PORT || 4000,
    ROOM_SOCKET: 'room-created',
    USERS_SOCKET: 'get-users',
    CREATE_SOCKET: 'create-room',
    JOINED_SOCKET: 'joined-room',
    USER_JOINED_SOCKET: 'user-joined',
    READY_SOCKET: 'ready',
    START_YOUTUBE_STREAM: 'start-youtube-stream',
    STOP_YOUTUBE_STREAM: 'stop-youtube-stream',
    STREAMING_STATUS: 'streaming-status',
    BINARY_STREAM: 'binarystream',
};