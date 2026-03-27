import { v4 as uuidv4 } from 'uuid';

/**
 * Generate a unique order number  e.g. "ORD-20240115-A3F9"
 */
export function generateOrderNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).toUpperCase().substring(2, 6);
  return `ORD-${date}-${rand}`;
}

/**
 * Generate a unique fulfillment order ID for Amazon MCF
 * Must be unique per seller — we embed the orderId + timestamp
 */
export function generateMCFOrderId(orderId) {
  const ts = Date.now().toString(36).toUpperCase();
  return `MCF-${orderId.slice(0, 8)}-${ts}`;
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
  if (url.startsWith('http')) return url;
  
  const s3Base = process.env.ASSETS_S3_BASE_URL?.replace(/\/$/, '') || 'https://detailguardz.s3.us-east-1.amazonaws.com';
  
  // Clean up leading slashes to avoid double slashes
  const cleanPath = url.startsWith('/') ? url : `/${url}`;
  
  // Ensure the URL starts with /assets if it's a relative path in our system
  let finalPath = cleanPath;
  if (!finalPath.startsWith('/assets/')) {
    finalPath = `/assets${cleanPath}`;
  }
  
  // URL-encode each segment of the path while keeping slashes
  const encodedPath = finalPath.split('/').map(segment => encodeURIComponent(segment)).join('/');
  
  return `${s3Base}${encodedPath}`;
}

/**
 * Deeply format all image URLs in an object or array
 */
export function deepFormatImages(data) {
  if (!data) return data;
  
  if (Array.isArray(data)) {
    return data.map(item => deepFormatImages(item));
  }
  
  if (typeof data === 'string' && (data.startsWith('/assets/') || data.startsWith('assets/'))) {
    return formatImageUrl(data);
  }
  
  if (typeof data === 'object') {
    const formatted = { ...data };
    for (const key in formatted) {
      if (['image', 'image_url', 'imageUrl', 'thumbnail', 'heroImage', 'banner_url', 'logo_url'].includes(key) || key.toLowerCase().endsWith('image')) {
        formatted[key] = formatImageUrl(formatted[key]);
      } else if (typeof formatted[key] === 'object' || typeof formatted[key] === 'string') {
        formatted[key] = deepFormatImages(formatted[key]);
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
  isValidUSZip,
  maskSecret,
  formatImageUrl,
  deepFormatImages
};
