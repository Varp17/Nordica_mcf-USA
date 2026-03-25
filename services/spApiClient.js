import axios from 'axios';
import aws4 from 'aws4';
import { URL } from 'url';
import logger from '../utils/logger.js';
import { getAccessToken, clearTokenCache } from './amazonTokenService.js';
import { sleep } from '../utils/helpers.js';

const ENDPOINTS = {
  production: 'https://sellingpartnerapi-na.amazon.com',
  sandbox:    'https://sandbox.sellingpartnerapi-na.amazon.com'
};

function getEndpoint() {
  return process.env.AMAZON_SANDBOX === 'true'
    ? ENDPOINTS.sandbox
    : ENDPOINTS.production;
}

export async function spApiRequest(method, path, body = null, query = {}, retries = 0) {
  const endpoint  = getEndpoint();
  const parsedUrl = new URL(endpoint + path);

  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null) parsedUrl.searchParams.set(k, v);
  });

  const fullPath = parsedUrl.pathname + parsedUrl.search;
  const accessToken = await getAccessToken();
  const bodyString = body ? JSON.stringify(body) : undefined;

  const opts = {
    host:    parsedUrl.hostname,
    path:    fullPath,
    method:  method.toUpperCase(),
    service: 'execute-api',
    region:  process.env.AWS_REGION || 'us-east-1',
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type':       'application/json',
      'Accept':             'application/json'
    }
  };

  if (bodyString) {
    opts.body = bodyString;
    opts.headers['Content-Length'] = Buffer.byteLength(bodyString).toString();
  }

  aws4.sign(opts, {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  });

  try {
    const response = await axios({
      method:  opts.method,
      url:     parsedUrl.href,
      headers: opts.headers,
      data:    body || undefined,
      timeout: 30000
    });

    return response;

  } catch (err) {
    const status  = err.response?.status;
    const errData = err.response?.data;

    if (status === 401 && retries === 0) {
      logger.warn('SP-API 401 received — clearing token cache and retrying');
      clearTokenCache();
      return spApiRequest(method, path, body, query, 1);
    }

    if (status === 429 && retries < 4) {
      const delay = Math.pow(2, retries) * 1000 + Math.random() * 500;
      logger.warn(`SP-API 429 Rate Limited — retrying in ${Math.round(delay)}ms (attempt ${retries + 1})`);
      await sleep(delay);
      return spApiRequest(method, path, body, query, retries + 1);
    }

    if (status === 503 && retries < 3) {
      const delay = Math.pow(2, retries) * 2000;
      logger.warn(`SP-API 503 Unavailable — retrying in ${delay}ms`);
      await sleep(delay);
      return spApiRequest(method, path, body, query, retries + 1);
    }

    logger.error('SP-API request failed', {
      method,
      path,
      status,
      error: errData || err.message
    });

    err.spApiError  = errData;
    err.spApiStatus = status;
    throw err;
  }
}
