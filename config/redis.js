import Redis from 'ioredis';
import logger from '../utils/logger.js';

const redisClient = new Redis({
  host:               process.env.REDIS_HOST     || '127.0.0.1',
  port:               parseInt(process.env.REDIS_PORT || '6379'),
  username:           process.env.REDIS_USER     || 'default',
  password:           process.env.REDIS_PASSWORD || undefined,
  retryStrategy(times) {
    if (times > 3) return null; // stop retrying after 3 attempts
    const delay = Math.min(times * 100, 3000);
    return delay;
  },
  maxRetriesPerRequest: null,
  lazyConnect: true,          // don't auto-connect on require()
  enableOfflineQueue: false
});

redisClient.on('connect', () => logger.info('Redis client connected'));
redisClient.on('error',   (err) => logger.error(`Redis error: ${err.message}`));
redisClient.on('reconnecting', () => logger.warn('Redis reconnecting...'));

export default redisClient;
