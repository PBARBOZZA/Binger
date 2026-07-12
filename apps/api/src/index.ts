import 'dotenv/config';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { app } from './app.js';
import { config } from './config.js';
import { configureSocket } from './socket.js';
import { prisma } from './db.js';

const server = createServer(app);
const io = new Server(server, { cors: { origin: config.WEB_ORIGIN, credentials: true }, maxHttpBufferSize: 32_000 });
configureSocket(io);
server.listen(config.PORT, () => console.log(JSON.stringify({ level: 'info', message: 'api_started', port: config.PORT })));
const shutdown = async () => { io.close(); server.close(); await prisma.$disconnect(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
