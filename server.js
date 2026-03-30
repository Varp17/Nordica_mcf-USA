import dns from 'dns';
dns.setDefaultResultOrder('ipv4first'); // Force IPv4 on Render (no outbound IPv6 support)

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import axios from 'axios';
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
// Fixing routes by importing from existing files in routes directory
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


// Missing routes stub (can be implemented later)
const webhookRoutes = express.Router();
const customerAuthRoutes = express.Router();
import paymentRoutes from './routes/payment.js';
import addressRoutes from './routes/addresses.js';
const crmRoutes = express.Router();

// ── Background Jobs ───────────────────────────────────────────────────────────
import trackingPoller from './jobs/trackingPoller.js';
import inventorySync from './jobs/inventorySync.js';
import stockRecovery from './jobs/stockRecovery.js';
import { startStockMonitoring } from './services/stockService.js';

const app = express();
app.set('trust proxy', 1); // Enable trusting headers from Render proxy
const PORT = process.env.PORT || 5000;

const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
  : '*';

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
}));

// ── Rate Limiting ─────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 200,
  message: { success: false, message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

const orderLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 30,
  message: { success: false, message: 'Too many order requests.' }
});

app.use('/api/', apiLimiter);

// ── Body Parsing ──────────────────────────────────────────────────────────────
// Raw body for webhook signature validation (must be before json middleware for these routes)
app.use('/api/webhooks', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(compression());
app.use(regionDetect);

// Static Assets
app.use('/assets', (req, res, next) => {
  try {
    if (process.env.ASSETS_S3_BASE_URL) {
      // Robust S3 URL construction
      const pathPart = req.path.startsWith('/') ? req.path : `/${req.path}`;
      const s3Base = process.env.ASSETS_S3_BASE_URL.replace(/\/$/, '');
      const s3Url = `${s3Base}/assets${pathPart}`;
      
      logger.debug(`Redirecting asset request to S3: ${req.path} -> ${s3Url}`);
      return res.redirect(s3Url);
    }
  } catch (e) {
    logger.error(`S3 Redirect Error: ${e.message} for path ${req.path}`);
  }
  next();
},
  express.static(path.join(__dirname, 'assets'), {
    setHeaders: (res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
  }));

app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}));

app.use(morgan('combined', {
  stream: { write: (message) => logger.http(message.trim()) }
}));

// Health Check
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: { database: 'connected', server: 'running' }
    });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'disconnected', error: err.message });
  }
});

app.get('/api/geoip', async (req, res) => {
  let country = req.country;

  // Enhance detection: If running locally or no region headers detected, 
  // do a server-side lookup to bypass CORS and ad-blockers.
  if (!country || country === 'CA') {
    try {
      const geoRes = await axios.get('https://ipapi.co/json/', { timeout: 2000 });
      if (geoRes.data?.country_code) {
        country = geoRes.data.country_code;
      }
    } catch (err) {
      logger.warn(`Server-side GeoIP lookup failed: ${err.message}`);
    }
  }

  res.json({ success: true, country: country || 'CA' });
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/auth/customer', authRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/shippo', shippoAdminRoutes);
app.use('/api/orders', orderLimiter, orderRoutes);
app.use('/api/fulfillment', fulfillmentRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/webhooks/shippo', shippoWebhookRoutes);
app.use('/api/webhooks/paypal', paypalWebhookRoutes);
app.use('/api/admin', invoiceRoutes);
app.get('/api/admin/recover-stock', async (req, res) => {
  try {
     await stockRecovery.runNow();
     res.json({ success: true, message: 'Stock recovery job executed successfully.' });
  } catch (err) {
     res.status(500).json({ success: false, error: err.message });
  }
});
app.use('/api/admin', crmRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/debug', debugRoutes);


// Error handling
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.url} not found.` });
});

app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`, { stack: err.stack, url: req.url });
  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

/**
 * PRODUCTION-LEVEL ENVIRONMENT VALIDATION
 * Ensure all critical keys are present before starting
 */
function validateEnv() {
  const required = [
    'JWT_SECRET', 'DATABASE_URL' || 'DB_HOST', 
    'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS',
    'AMAZON_SELLER_ID', 'LWA_CLIENT_ID', 'LWA_CLIENT_SECRET', 'LWA_REFRESH_TOKEN',
    'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'
  ];
  
  const missing = required.filter(key => {
    if (key === 'DATABASE_URL' || key === 'DB_HOST') {
      return !process.env.DATABASE_URL && !process.env.DB_HOST;
    }
    return !process.env[key];
  });

  if (missing.length > 0) {
    logger.error(`❌ CRITICAL: Missing environment variables: ${missing.join(', ')}`);
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function startServer() {
  try {
    validateEnv();
    await db.query('SELECT 1');
    logger.info('✅ MySQL database connected');

    // Perform Schema Initialization and Admin Seeding
    await initializeDatabase(db);
    logger.info('✅ Database schema and admin synchronized.');

    // 2. Test Redis connection (Used for tracking poller, NOT required for inventorySync anymore)
    try {
      await redisClient.connect();
      await redisClient.ping();
      logger.info('✅ Redis connected');
    } catch (redisErr) {
      logger.warn(`⚠️  Redis unavailable: ${redisErr.message}. Tracking poller may not work, but stock sync will continue without it.`);
      // Redis is no longer mandatory — inventorySync now uses setInterval instead of Bull
    }

    // Start background jobs (inventorySync runs independently of Redis)
    trackingPoller.startPolling();
    inventorySync.startInventorySync();
    stockRecovery.start();
    startStockMonitoring();
    logger.info('✅ Background jobs started (1-hour stock sync, stock monitoring, stock recovery)');

    app.listen(PORT, () => {
      logger.info(`✅ Server running on port ${PORT}`);
    });

  } catch (err) {
    logger.error(`❌ Server startup failed: ${err.message}`);
    process.exit(1);
  }
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down gracefully');
  try {
    await trackingPoller.stop();
    await inventorySync.stop();
    await db.end();
    await redisClient.quit();
  } catch (err) {
    logger.error(`Shutdown error: ${err.message}`);
  }
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled Promise Rejection: ${reason}`);
});

startServer();
