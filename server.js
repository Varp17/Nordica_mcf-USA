import 'dotenv/config';
import dns from 'dns';
// Force IPv4 as priority to prevent connectivity issues with local/remote services
dns.setDefaultResultOrder('ipv4first');

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
// COMMENTED: axios is not used directly in server.js
// import axios from 'axios';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';

import logger from './utils/logger.js';
import db from './config/database.js';
import redisClient from './config/redis.js';
import regionDetect from './middleware/regionDetect.js';
import { initializeDatabase } from './utils/dbInit.js';

// Get __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Routes ────────────────────────────────────────────────────────────────────
import orderRoutes from './routes/orderRoutes.js';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import cartRoutes from './routes/cart.js';
import wishlistRoutes from './routes/wishlist.js';
import productRoutes from './routes/products.js';
import fulfillmentRoutes from './routes/fulfillment.js';
import invoiceRoutes from './routes/invoices.js';
import shippoAdminRoutes from './routes/shippo.js';
import shippoWebhookRoutes from './routes/shippoWebhook.js';
import trackingRoutes from './routes/tracking.js';
import debugRoutes from './routes/debug.js';
import paypalWebhookRoutes from './routes/paypalWebhook.js';
import stockRoutes from './routes/stock.js';
import paymentRoutes from './routes/payment.js';
import addressRoutes from './routes/addresses.js';
import adminOrderRoutes from './routes/adminOrders.js';

// ── Background Jobs ───────────────────────────────────────────────────────────
import trackingPoller from './jobs/trackingPoller.js';
import inventorySync from './jobs/inventorySync.js';
import stockRecovery from './jobs/stockRecovery.js';
import retryFailedFulfillments from './jobs/retryFailedFulfillments.js';
import { startStockMonitoring } from './services/stockService.js';

const app = express();
app.set('trust proxy', 1); 
const PORT = process.env.PORT || 5000;

// Security Middlewares
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false, 
}));

const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(o => o.trim())
  .filter(o => !!o);

app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
}));

// ── Rate Limiting ─────────────────────────────────────────────────────────────
const isDev = process.env.NODE_ENV === 'development';

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: isDev ? 10000 : 500,
  message: { success: false, message: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false
});

const orderLimiter = rateLimit({
  windowMs: 60 * 1000, 
  max: isDev ? 200 : 30,
  message: { success: false, message: 'Too many order requests.' }
});

app.use('/api/', apiLimiter);

// ── Body Parsing ──────────────────────────────────────────────────────────────
app.use('/api/webhooks', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(compression());
app.use(regionDetect);

// Static Assets
app.use('/assets', express.static(path.join(__dirname, 'assets'), {
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));

app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));

app.use(morgan('combined', {
  stream: { write: (message) => logger.http(message.trim()) }
}));

// Health Check
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/payment', orderLimiter, paymentRoutes);
app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/orders-manage', adminOrderRoutes);
app.use('/api/admin/shippo', shippoAdminRoutes);
app.use('/api/orders', orderLimiter, orderRoutes);
app.use('/api/fulfillment', fulfillmentRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/webhooks/shippo', shippoWebhookRoutes);
app.use('/api/webhooks/paypal', paypalWebhookRoutes);
app.use('/api/admin/invoices', invoiceRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/stock', stockRoutes);

// Debug routes — disabled in production for security
if (process.env.NODE_ENV !== 'production') {
  app.use('/api/debug', debugRoutes);
}

// ── Additional Utility Routes ────────────────────────────────────────────────
app.get('/api/geoip', async (req, res) => {
  try {
    // Basic geoip detection or fallback to CA
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    res.json({
      success: true,
      country: 'CA', // Default for this store
      ip: ip,
      source: 'fallback'
    });
  } catch (err) {
    res.json({ success: true, country: 'CA' });
  }
});

// Error handling
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.url} not found.` });
});

app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

/**
 * PRODUCTION-LEVEL ENVIRONMENT VALIDATION
 */
const validateEnv = () => {
  const isProd = process.env.NODE_ENV === 'production';
  const required = [
    'JWT_SECRET', 'FRONTEND_URL', 'AMAZON_SELLER_ID',
    'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'
  ];
  
  // Amazon LWA can use either prefix
  const hasAmzId = process.env.AMAZON_CLIENT_ID || process.env.LWA_CLIENT_ID;
  const hasAmzSecret = process.env.AMAZON_CLIENT_SECRET || process.env.LWA_CLIENT_SECRET;
  const hasAmzToken = process.env.AMAZON_REFRESH_TOKEN || process.env.LWA_REFRESH_TOKEN;

  if (!hasAmzId) required.push('AMAZON_CLIENT_ID or LWA_CLIENT_ID');
  if (!hasAmzSecret) required.push('AMAZON_CLIENT_SECRET or LWA_CLIENT_SECRET');
  if (!hasAmzToken) required.push('AMAZON_REFRESH_TOKEN or LWA_REFRESH_TOKEN');

  if (!process.env.DATABASE_URL && !process.env.DB_HOST) {
    required.push('DB_HOST');
  }

  const missing = required.filter(key => {
    if (key.includes(' or ')) return false; // Handled above
    return !process.env[key];
  });

  if (missing.length > 0) {
    const msg = `❌ Missing environment variables: ${missing.join(', ')}`;
    if (isProd) {
      console.error(msg);
      process.exit(1);
    } else {
      logger.warn(`${msg} (Non-fatal in dev)`);
    }
  }

  // Final check for Amazon keys specifically for prod
  if (isProd && (!hasAmzId || !hasAmzSecret || !hasAmzToken)) {
      console.error('❌ Missing Amazon LWA credentials (AMAZON_CLIENT_ID/SECRET/REFRESH_TOKEN)');
      process.exit(1);
  }
};

// ── Boot ──────────────────────────────────────────────────────────────────────
async function startServer() {
  try {
    validateEnv();
    await db.query('SELECT 1');
    logger.info('✅ MySQL database connected');

    await initializeDatabase(db);
    
    try {
      await redisClient.connect();
      logger.info('✅ Redis connected');
    } catch (redisErr) {
      logger.warn(`⚠️ Redis unavailable: ${redisErr.message}`);
    }

    // Start background jobs
    trackingPoller.startPolling();
    retryFailedFulfillments.startRetryJob();
    inventorySync.startInventorySync();
    stockRecovery.start();
    startStockMonitoring();
    
    const server = app.listen(PORT, () => {
      logger.info(`✅ Server running on port ${PORT}`);
      logger.info(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    });

    // ── Graceful Shutdown (critical for AWS ECS/Fargate/EC2) ──────────────
    const shutdown = async (signal) => {
      logger.info(`\n⏳ ${signal} received — graceful shutdown starting...`);
      
      // 1. Stop accepting new connections
      server.close(() => logger.info('   HTTP server closed'));
      
      // 2. Stop background jobs
      trackingPoller.stop();
      retryFailedFulfillments.stop();
      inventorySync.stop();
      stockRecovery.stop?.();
      
      // 3. Close database pool
      try { await db.end(); } catch (e) { logger.error(`DB close error: ${e.message}`); }
      
      // 4. Close Redis
      try { await redisClient.quit(); } catch (e) { /* May already be closed */ }
      
      logger.info('✅ Graceful shutdown complete');
      process.exit(0);
    };
    
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

  } catch (err) {
    logger.error(`❌ Server startup failed: ${err.message}`);
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled Promise Rejection: ${reason}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}`, { stack: err.stack });
  process.exit(1);
});

startServer();
