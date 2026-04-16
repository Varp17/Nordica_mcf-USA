import Redis from 'ioredis';
import logger from '../utils/logger.js';

const redisClient = new Redis({
  host:               process.env.REDIS_HOST     || '127.0.0.1',
  port:               parseInt(process.env.REDIS_PORT || '6379'),
  username:           process.env.REDIS_USER     || 'default',
  password:           process.env.REDIS_PASSWORD || undefined,
  retryStrategy(times) {
    const delay = Math.min(times * 100, 3000);
    return delay; // keep retrying
  },
  maxRetriesPerRequest: null,
  keepAlive: 10000,           // check connection every 10s
  lazyConnect: true,
  enableOfflineQueue: true    // allow commands while reconnecting
});

redisClient.on('connect', () => logger.info('Redis client connected'));
redisClient.on('error',   (err) => logger.error(`Redis error: ${err.message}`));
redisClient.on('reconnecting', () => logger.warn('Redis reconnecting...'));

export default redisClient;
