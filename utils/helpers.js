import { v4 as uuidv4 } from 'uuid';

/**
 * Generate a unique order number  e.g. "ORD-20240115-A3F9"
 */
export function generateOrderNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).toUpperCase().substring(2, 8); // Increased to 6 chars
  return `ORD-${date}-${rand}`;
}

/**
 * Generate a unique fulfillment order ID for Amazon MCF
 * Must be unique per seller — we base it on the order number for idempotency
 */
export function generateMCFOrderId(orderNumber) {
  // Amazon prefers no spaces, only Alphanumeric and hyphens
  const cleanNumber = orderNumber.replace(/[^a-zA-Z0-9-]/g, '');
  return `MCF-${cleanNumber}`;
}

/**
 * Generate a UUID v4
 */
export function generateUUID() {
  return uuidv4();
}

/**
 * Sleep for n milliseconds (used for retry backoff)
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff retry wrapper
 * @param {Function} fn       - async function to retry
 * @param {number}   retries  - max retry attempts
 * @param {number}   baseMs   - base delay in ms
 */
export async function retryWithBackoff(fn, retries = 3, baseMs = 500) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        const delay = baseMs * Math.pow(2, attempt) + Math.random() * 100;
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

/**
 * Safely parse JSON — returns null on failure
 */
export function safeJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

/**
 * Format currency for display
 */
export function formatCurrency(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}

/**
 * Detect country from IP address using request headers
 * (Assumes your reverse proxy / CDN sets X-Country-Code header)
 * Falls back to a simple IP lookup
 */
export function detectCountryFromRequest(req) {
  // Check CDN/proxy header first (Cloudflare, AWS CloudFront, etc.)
  const cfCountry     = req.headers['cf-ipcountry'];
  const cloudfrontCC  = req.headers['cloudfront-viewer-country'];
  const xCountry      = req.headers['x-country-code'];

  return (cfCountry || cloudfrontCC || xCountry || 'CA').toUpperCase();
}

/**
 * Validate Canadian postal code format  e.g. "M5H 2N2"
 */
export function isValidCanadianPostalCode(code) {
  return /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/.test(code);
}

/**
 * Validate US ZIP code format  e.g. "10001" or "10001-1234"
 */
export function isValidUSZip(zip) {
  return /^\d{5}(-\d{4})?$/.test(zip);
}

/**
 * Mask sensitive strings for logging  e.g. "Atzr|XXXXXX...XXX"
 */
export function maskSecret(str, visibleChars = 6) {
  if (!str || str.length <= visibleChars) return '***';
  return str.slice(0, visibleChars) + '...' + str.slice(-4);
}

/**
 * Format a single image URL to use the S3 base URL if it's not already absolute
 */
export function formatImageUrl(url) {
  if (!url) return url;
  if (typeof url !== 'string') return url;
  if (url.startsWith('http') || url.startsWith('data:')) return url;
  
  const s3Base = process.env.ASSETS_S3_BASE_URL?.replace(/\/$/, '') || 'https://detailguardz.s3.us-east-1.amazonaws.com';
  
  // Clean up path
  let cleanPath = url.trim();
  if (!cleanPath.startsWith('/')) {
    cleanPath = '/' + cleanPath;
  }
  
  // Ensure the URL starts with /assets if it's a relative path in our system
  // (unless it already seems to have a path structure that shouldn't be prefixed)
  let finalPath = cleanPath;
  if (!finalPath.startsWith('/assets/')) {
    finalPath = `/assets${cleanPath}`;
  }
  
  // URL-encode segments, but be careful with existing encoding
  try {
    const segments = finalPath.split('/');
    const encodedSegments = segments.map(seg => {
      // If it already looks encoded (contains %), don't double encode
      if (seg.includes('%')) return seg;
      
      // Standard encodeURIComponent + manual handle for parentheses
      // Note: We avoid replacing %20 with + here to stay consistent with frontend %20
      return encodeURIComponent(decodeURIComponent(seg))
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29');
    });
    return `${s3Base}${encodedSegments.join('/')}`;
  } catch (e) {
    return `${s3Base}${finalPath}`;
  }
}

/**
 * Deeply format all image URLs in an object or array
 */
export function deepFormatImages(data) {
  if (!data) return data;
  
  if (Array.isArray(data)) {
    return data.map(item => deepFormatImages(item));
  }
  
  if (typeof data === 'object') {
    const formatted = { ...data };
    for (const key in formatted) {
      const val = formatted[key];
      if (!val) continue;

      const isImageKey = ['image', 'image_url', 'imageUrl', 'thumbnail', 'heroImage', 'banner_url', 'logo_url'].includes(key) || 
                         key.toLowerCase().endsWith('image') ||
                         key.toLowerCase().endsWith('images');

      if (isImageKey) {
        if (typeof val === 'string') {
          formatted[key] = formatImageUrl(val);
        } else if (Array.isArray(val)) {
          formatted[key] = val.map(v => typeof v === 'string' ? formatImageUrl(v) : deepFormatImages(v));
        }
      } else if (typeof val === 'object') {
        formatted[key] = deepFormatImages(val);
      }
    }
    return formatted;
  }
  
  return data;
}

export default {
  generateOrderNumber,
  generateMCFOrderId,
  generateUUID,
  sleep,
  retryWithBackoff,
  safeJSON,
  formatCurrency,
  detectCountryFromRequest,
  isValidCanadianPostalCode,
  isValidUSZip,
  maskSecret,
  formatImageUrl,
  deepFormatImages
};
