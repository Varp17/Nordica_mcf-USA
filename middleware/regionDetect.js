import { detectCountryFromRequest } from '../utils/helpers.js';

/**
 * Region Detection Middleware
 * ──────────────────────────
 * Identifies user country from headers and attaches it to the request object.
 * Also sets common defaults like currency.
 */
function regionDetect(req, res, next) {
    const country = detectCountryFromRequest(req);
    
    // Attach to request for use in controllers/models
    req.country = country;
    req.currency = country === 'CA' ? 'CAD' : 'USD';
    
    next();
}

export default regionDetect;
