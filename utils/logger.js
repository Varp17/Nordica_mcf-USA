import { createLogger, format, transports } from 'winston';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure logs directory exists
const logDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message, ...meta }) => {
          const extra = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
          return `[${timestamp}] ${level}: ${message}${extra}`;
        })
      )
    }),
    new transports.File({ filename: path.join(logDir, 'error.log'),  level: 'error' }),
    new transports.File({ filename: path.join(logDir, 'combined.log') })
  ]
});

export default logger;
