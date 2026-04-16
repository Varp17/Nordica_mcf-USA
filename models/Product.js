import db from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * Product Model — Core logic for listing, finding, and stock management.
 */

/**
 * Find all active products with filters and pagination.
 */
export async function findAll({ country = 'US', page = 1, limit = 50, category = null, search = null } = {}) {
  const conditions = ['is_active = 1'];
  const params = [];
  
  let countryMatch = [country];
  if (country === 'US') countryMatch = ['US', 'USA'];
  if (country === 'CA') countryMatch = ['CA', 'CAD'];
  
  if (country && country !== 'ALL') {
    conditions.push(`(country IN (${countryMatch.map(() => '?').join(',')}) OR country IS NULL)`);
    params.push(...countryMatch);
  }
  
  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }
  
  if (search) {
    conditions.push('(name LIKE ? OR description LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const offset = (page - 1) * limit;

  const [rows] = await db.query(
    `SELECT id, slug, name, price, original_price, image, images, rating, review_count, in_stock, availability, country, category, tags
     FROM products ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, 
    [...params, limit, offset]
  );
  
  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM products ${where}`, params);
  
  return { products: rows.map(_parseProduct), total, page, limit };
}

/**
 * Detailed product lookup by ID or slug.
 */
export async function findById(productId, country = 'US') {
  let countryMatch = [country];
  if (country === 'US') countryMatch = ['US', 'USA'];
  if (country === 'CA') countryMatch = ['CA', 'CAD'];
  
  const [rows] = await db.query(
    `SELECT * FROM products 
     WHERE (id = ? OR slug = ? OR sku = ?) 
     AND (country IN (${countryMatch.map(() => '?').join(',')}) OR country IS NULL) 
     AND is_active = 1`, 
    [productId, productId, productId, ...countryMatch]
  );
  
  return rows.length ? _parseProduct(rows[0]) : null;
}

/**
 * Unified variant/product lookup for fulfillment.
 * Resolves SKUs and Amazon SKUs across tables.
 */
export async function findVariantById(identifier, connection = null) {
  const dbConn = connection || db;

  // 0. Handle legacy composite IDs (slug::color) from older frontend state
  if (typeof identifier === 'string' && identifier.includes('::')) {
    const [slug, color] = identifier.split('::');
    const [pRows] = await dbConn.query(`SELECT * FROM products WHERE slug = ? AND is_active = 1`, [slug]);
    if (pRows.length) {
      const p = pRows[0];
      const [vRows] = await dbConn.query(
        `SELECT * FROM product_color_variants WHERE product_id = ? AND (LOWER(color_name) = LOWER(?) OR LOWER(variant_name) = LOWER(?)) AND is_active = 1`,
        [p.id, color, color]
      );
      if (vRows.length) {
        const v = vRows[0];
        return {
          id: v.id, product_id: v.product_id, name: `${p.name} (${v.color_name || v.variant_name})`,
          price: parseFloat(v.price), stock: v.stock, sku: v.sku || v.amazon_sku, amazon_sku: v.amazon_sku || v.sku,
          country: v.country, image: v.image_url, weight_kg: v.weight_kg, dimensions: v.dimensions
        };
      }
    }
  }
  
  // 1. Parent product check
  let [rows] = await dbConn.query(`SELECT * FROM products WHERE (id = ? OR slug = ? OR sku = ? OR amazon_sku = ?) AND is_active = 1`, [identifier, identifier, identifier, identifier]);
  if (rows.length) {
    const p = _parseProduct(rows[0]);
    return { ...p, product_id: p.id, variant_name: 'Default', sku: p.sku || p.amazon_sku, amazon_sku: p.amazon_sku || p.sku };
  }

  // 2. New product_variants table (Prefer modern table)
  [rows] = await dbConn.query(`
    SELECT v.*, p.name as product_name, p.image as product_image, p.country as p_country 
    FROM product_variants v 
    JOIN products p ON v.product_id = p.id 
    WHERE (v.id = ? OR v.sku = ? OR v.amazon_sku = ?) AND v.is_active = 1
  `, [identifier, identifier, identifier]);

  if (rows.length) {
    const v = rows[0];
    return {
      id: v.id, product_id: v.product_id, name: `${v.product_name} (${v.variant_name || v.sku})`,
      price: parseFloat(v.price), stock: v.stock, sku: v.sku || v.amazon_sku, amazon_sku: v.amazon_sku || v.sku,
      country: v.p_country, image: v.product_image, inventory_sync_enabled: v.inventory_sync_enabled ?? 1
    };
  }

  // 3. Legacy product_color_variants
  [rows] = await dbConn.query(`
    SELECT cv.*, p.name as product_name FROM product_color_variants cv 
    JOIN products p ON cv.product_id = p.id 
    WHERE (cv.id = ? OR cv.amazon_sku = ? OR cv.sku = ?) AND cv.is_active = 1
  `, [identifier, identifier, identifier]);

  if (rows.length) {
    const v = rows[0];
    return {
      id: v.id, product_id: v.product_id, name: `${v.product_name} (${v.color_name || v.variant_name})`,
      price: parseFloat(v.price), stock: v.stock, sku: v.sku || v.amazon_sku, amazon_sku: v.amazon_sku || v.sku,
      country: v.country, image: v.image_url, weight_kg: v.weight_kg, dimensions: v.dimensions
    };
  }

  // 4. EDGE CASE REPAIR: JSON Fallback
  // If not in tables, search in color_options JSON as a last resort
  const [jsonRows] = await dbConn.query(`
    SELECT id, name, color_options, target_country FROM products 
    WHERE (color_options LIKE ? OR amazon_sku = ? OR sku = ?) AND is_active = 1
  `, [`%${identifier}%`, identifier, identifier]);

  if (jsonRows.length) {
    for (const p of jsonRows) {
      try {
        const colors = typeof p.color_options === 'string' ? JSON.parse(p.color_options) : p.color_options;
        if (Array.isArray(colors)) {
          // Check for exact SKU match (or normalized BBLK typo)
          const normalizedId = identifier.replace('-BBLK', '-BLK');
          const c = colors.find(v => v.id === identifier || v.amazon_sku === identifier || v.sku === identifier || v.amazon_sku === normalizedId);
          
          if (c) {
            logger.info(`🛠️ JIT Repair: Found variant ${identifier} in JSON for ${p.name}. Syncing to table.`);
            const newVId = (c.id && c.id.length === 36) ? c.id : (identifier.length === 36 ? identifier : null);
            
            // JIT Insert into product_color_variants to prevent future misses
            const finalId = newVId || identifier; // Use identifier as ID if it's a UUID, else we'll need a new one
            
            // Note: We use a try-catch in case another process just did this
            try {
              await dbConn.execute(
                "INSERT IGNORE INTO product_color_variants (id, product_id, sku, color_name, amazon_sku, target_country, stock, price, is_active) VALUES (?,?,?,?,?,?,?,?,1)",
                [
                  finalId.length === 36 ? finalId : (c.id || identifier), 
                  p.id, 
                  c.sku || null, 
                  c.name || 'Default', 
                  c.amazon_sku || null, 
                  p.target_country || 'us', 
                  parseInt(c.stock) || 0, 
                  parseFloat(c.price) || 0
                ]
              );
            } catch (err) { /* ignore duplicate errors */ }

            return {
              id: finalId, product_id: p.id, name: `${p.name} (${c.name || 'Default'})`,
              price: parseFloat(c.price || 0), stock: parseInt(c.stock || 0), 
              sku: c.sku || c.amazon_sku, amazon_sku: c.amazon_sku || c.sku,
              country: p.target_country, image: p.image, is_jit: true
            };
          }
        }
      } catch (e) { logger.warn(`JSON parse error in JIT repair: ${e.message}`); }
    }
  }

  return null;
}

/**
 * Atomic stock deduction.
 * EDGE CASE #26: Prevents overselling using SQL-level checks.
 * EDGE CASE #89: Respects inventory_sync_enabled flag.
 */
export async function deductStock(items, connection = null) {
  const dbConn = connection || db;
  for (const item of items) {
    const qty = Math.max(0, parseInt(item.quantity) || 0);
    if (qty === 0) continue;

    const variant = await findVariantById(item.variantId || item.productId || item.sku, dbConn);
    if (!variant) continue;

    // Respect sync flag
    if (variant.inventory_sync_enabled === 0) {
      logger.info(`Stock deduction skipped for ${variant.name} (sync disabled)`);
      continue;
    }

    let affected = 0;
    
    // Try updating product_variants
    const [vRes] = await dbConn.execute(
      `UPDATE product_variants SET stock = stock - ? WHERE id = ? AND stock >= ?`,
      [qty, variant.id, qty]
    );
    affected += vRes.affectedRows;

    if (affected === 0) {
      // Try updating product_color_variants
      const [cvRes] = await dbConn.execute(
        `UPDATE product_color_variants SET stock = stock - ? WHERE id = ? AND stock >= ?`,
        [qty, variant.id, qty]
      );
      affected += cvRes.affectedRows;
    }

    if (affected === 0 && variant.id === variant.product_id) {
      // Try updating products
      const [pRes] = await dbConn.execute(
        `UPDATE products SET inventory_cache = inventory_cache - ? WHERE id = ? AND inventory_cache >= ?`,
        [qty, variant.product_id, qty]
      );
      affected += pRes.affectedRows;
    }

    if (affected === 0) {
      throw new Error(`Insufficient stock for ${variant.name} (Requested: ${qty})`);
    }
  }
}

/**
 * Stock Restoration (for cancelled/failed orders)
 */
export async function restoreStock(items, connection = null) {
  const dbConn = connection || db;
  for (const item of items) {
    const qty = Math.max(0, parseInt(item.quantity) || 0);
    if (qty === 0) continue;

    const variant = await findVariantById(item.variantId || item.productId || item.sku, dbConn);
    if (!variant || variant.inventory_sync_enabled === 0) continue;

    await dbConn.execute(`UPDATE product_variants SET stock = stock + ? WHERE id = ?`, [qty, variant.id]);
    await dbConn.execute(`UPDATE product_color_variants SET stock = stock + ? WHERE id = ?`, [qty, variant.id]);
    if (variant.id === variant.product_id) {
       await dbConn.execute(`UPDATE products SET inventory_cache = inventory_cache + ? WHERE id = ?`, [qty, variant.product_id]);
    }
  }
}

/**
 * Stock check with optional lock.
 * EDGE CASE #93: Added connection param for transactional locks.
 */
export async function checkStock(identifier, quantity = 1, connection = null) {
  const dbConn = connection || db;
  const product = await findVariantById(identifier, dbConn);
  if (!product) return { valid: false, currentStock: 0, name: 'Unknown' };

  const currentStock = product.stock !== undefined ? product.stock : (product.inventory_cache || 0);
  
  return {
    valid: currentStock >= quantity,
    currentStock,
    name: product.name
  };
}

/**
 * Parses raw DB record into clean product object.
 */
function _parseProduct(p) {
  if (!p) return null;
  const safeParse = (v, defaultVal = []) => {
    try { return typeof v === 'string' ? JSON.parse(v) : (v || defaultVal); } catch (e) { return defaultVal; }
  };

  return {
    ...p,
    price: parseFloat(p.price || 0),
    original_price: p.original_price ? parseFloat(p.original_price) : null,
    rating: parseFloat(p.rating || 0),
    in_stock: !!p.in_stock,
    images: safeParse(p.images),
    features: safeParse(p.features),
    attributes: safeParse(p.attributes, {}),
    color_options: safeParse(p.color_options)
  };
}


/**
 * ── Regional Cart Validation ───────────────────────────────────────────────────
 */
export async function validateCartItems(cartItems, country = 'US') {
  const errors = [];
  const validItems = [];

  for (const cartItem of (cartItems || [])) {
    const identifier = cartItem.variantId || cartItem.id || cartItem.sku;
    const quantity = Math.max(1, parseInt(cartItem.quantity) || 1);

    const product = await findVariantById(identifier);
    if (!product) {
      errors.push(`Product not found: ${identifier}`);
      continue;
    }

    // Region restriction
    let isCaRestriction = (country === 'US' && product.country === 'CA');
    let isUsRestriction = (country === 'CA' && (product.country === 'US' || product.country === 'USA'));

    if (isCaRestriction) {
      errors.push(`"${product.name}" is only available for Canadian customers.`);
      continue;
    }
    if (isUsRestriction) {
      errors.push(`"${product.name}" is only available for US customers.`);
      continue;
    }

    // Stock check
    const stockStatus = await checkStock(identifier, quantity);
    if (!stockStatus.valid) {
      errors.push(`"${product.name}" is out of stock or quantity exceeds availability.`);
      continue;
    }

    // US needs Amazon SKU
    if (country === 'US' && !product.amazon_sku) {
      errors.push(`"${product.name}" is currently unavailable for US fulfillment.`);
      continue;
    }
    validItems.push({
      variantId: identifier,
      productId: product.product_id,
      sku: product.sku,
      sellerSku: product.amazon_sku || product.sku,
      productName: product.name,
      quantity,
      unitPrice: product.price,
      weight_kg: product.weight_kg || 0.5,
      dimensions: product.dimensions || '20x15x10',
      country
    });
  }

  const subtotal = validItems.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
  return { valid: errors.length === 0, errors, items: validItems, subtotal: parseFloat(subtotal.toFixed(2)) };
}

export default { findAll, findById, findVariantById, validateCartItems, deductStock, restoreStock, checkStock };
