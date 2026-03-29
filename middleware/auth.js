import jwt from 'jsonwebtoken';
import logger from '../utils/logger.js';

/**
 * requireAuth middleware
 * ──────────────────────
 * Validates the Bearer JWT in the Authorization header.
 * Attaches decoded payload to req.user.
 */
export function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Authorization header missing or invalid' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Normalize user ID and role for consistency across all routes
    req.user = {
      ...decoded,
      id: decoded.id || decoded.userId,
      role: decoded.role || 'customer'
    };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token expired' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }
    logger.error(`Auth middleware error: ${err.message}`);
    return res.status(500).json({ success: false, message: 'Token verification failed' });
  }
}

/**
 * requireRole middleware (use after requireAuth)
 * e.g. router.get('/admin', requireAuth, requireRole('admin'), handler)
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    if (!roles.includes(req.user.role)) {
      logger.warn(`Auth failure: UID ${req.user.id} has role '${req.user.role}', but expected '${roles.join(' or ')}' for ${req.method} ${req.originalUrl}`);
      return res.status(403).json({ success: false, message: 'Insufficient permissions' });
    }
    next();
  };
}

/**
 * optionalAuth — attaches user if token present, does not block if absent
 */
export function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  const token = authHeader.split(' ')[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    req.user = null;
  }
  next();
}

/** Legacy aliases **/
export const authenticateToken = requireAuth;
export const requireAdmin = requireRole('admin', 'superadmin');

export default { requireAuth, requireRole, optionalAuth };
