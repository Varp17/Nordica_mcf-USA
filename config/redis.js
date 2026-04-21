import logger from '../utils/logger.js';

// MOCK REDIS CLIENT (DISABLED)
const redisClient = {
  on: (event, callback) => {
    // logger.debug(`Redis Mock: event ${event} registered`);
  },
  connect: async () => {
    logger.info('Redis (Mock) connected');
    return Promise.resolve();
  },
  quit: async () => Promise.resolve(),
  get: async () => null,
  set: async () => 'OK',
  del: async () => 0,
  exists: async () => 0,
  // Add other methods as needed by the app
};

export default redisClient;

