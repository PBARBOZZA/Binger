import 'dotenv/config';
import { prisma } from './db.js';
import { cleanupPrivateMedia } from './private-media.js';

try {
  const result = await cleanupPrivateMedia();
  console.log(JSON.stringify({ level: 'info', message: 'private_media_cleanup_completed', ...result }));
} catch {
  console.error(JSON.stringify({ level: 'error', message: 'private_media_cleanup_failed' }));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
