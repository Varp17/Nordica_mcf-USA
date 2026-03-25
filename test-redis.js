'use strict';

require('dotenv').config();
const redisClient = require('./config/redis');
const logger = require('./utils/logger');

async function testRedis() {
  try {
    logger.info('Connecting to Redis...');
    await redisClient.connect();
    
    logger.info('Setting key "foo" to "bar"...');
    await redisClient.set('foo', 'bar');
    
    const result = await redisClient.get('foo');
    logger.info(`Key "foo" value: ${result}`);
    
    if (result === 'bar') {
      logger.info('Redis connection and basic operations successful!');
    } else {
      logger.error(`Redis operation failed: expected "bar", got "${result}"`);
    }
  } catch (err) {
    logger.error(`Redis test failed: ${err.message}`);
  } finally {
    await redisClient.quit();
    process.exit(0);
  }
}

testRedis();
