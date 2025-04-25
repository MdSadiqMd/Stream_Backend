# Stream_Backend

### 🔧 Prerequisites

- Node.js (v20.14.0 recommended)
- npm
- Docker & Docker Compose (for containerized setup)

## 🚀 Local Development Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Run the backend server**

   Open **Terminal 1**:

   ```bash
   npm start
   ```

3. **Start PeerJS server**

   Open **Terminal 2**:

   ```bash
   peerjs --port 9000 --key peerjs --path /myapp
   ```

4. The server should now be running at: `http://localhost:4000` (or your configured port)  
   PeerJS will be running at: `http://localhost:9000/myapp`

## 🐳 Running with Docker

1. **Build and start containers**

   ```bash
   docker-compose up --build
   ```

2. The backend and PeerJS services will be available at:

   - **API**: `http://localhost:4000`
   - **PeerJS**: `http://localhost:9000/myapp`

3. To stop the services:

   ```bash
   docker-compose down
   ```

---

### 🐞 Development Tips

- To auto-reload on file changes, ensure `nodemon` is configured correctly.
- Logs are managed using a custom logger (see `src/config/logger.config.ts`).
