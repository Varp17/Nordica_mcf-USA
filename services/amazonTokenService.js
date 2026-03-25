import axios from 'axios';
import NodeCache from 'node-cache';
import logger from '../utils/logger.js';
import { maskSecret } from '../utils/helpers.js';

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const CACHE_KEY     = 'amz_lwa_access_token';

// TTL managed manually — we set it from expires_in returned by Amazon
const tokenCache = new NodeCache({ useClones: false });

// Simple mutex to prevent thundering herd on expiry
let refreshInFlight = null;

/**
 * Returns a valid LWA access token.
 * Serves from cache if still fresh; otherwise refreshes automatically.
 */
export async function getAccessToken() {
  // 1. Serve from cache
  const cached = tokenCache.get(CACHE_KEY);
  if (cached) return cached;

  // 2. Deduplicate concurrent refresh calls
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = _refreshToken().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

async function _refreshToken() {
  logger.debug('LWA: Refreshing access token...');

  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: process.env.LWA_REFRESH_TOKEN,
    client_id:     process.env.LWA_CLIENT_ID,
    client_secret: process.env.LWA_CLIENT_SECRET
  });

  const response = await axios.post(LWA_TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30000
  });

  const { access_token, expires_in } = response.data;

  if (!access_token) {
    throw new Error('LWA token refresh returned no access_token');
  }

  // Cache for (expires_in - 60) seconds to ensure we never use an expired token
  const ttl = (expires_in || 3600) - 60;
  tokenCache.set(CACHE_KEY, access_token, ttl);

  logger.debug(`LWA: Token refreshed. Expires in ${ttl}s. Token: ${maskSecret(access_token)}`);
  return access_token;
}

/**
 * Force-clear the cached token (call this when you receive a 401 from SP-API)
 */
export function clearTokenCache() {
  tokenCache.del(CACHE_KEY);
  logger.warn('LWA: Token cache cleared — will re-fetch on next request');
}

export default { getAccessToken, clearTokenCache };
