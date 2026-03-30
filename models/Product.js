import db from '../config/database.js';
import logger from '../utils/logger.js';

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
  const [rows] = await db.query(`SELECT * FROM products ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM products ${where}`, params);
  return { products: rows.map(_parseProduct), total, page, limit };
}

export async function findById(productId, country = 'US') {
  let countryMatch = [country];
  if (country === 'US') countryMatch = ['US', 'USA'];
  if (country === 'CA') countryMatch = ['CA', 'CAD'];
  const queryParams = [productId, productId, ...countryMatch];
  let [rows] = await db.query(`SELECT * FROM products WHERE (id = ? OR slug = ?) AND (country IN (${countryMatch.map(() => '?').join(',')}) OR country IS NULL) AND is_active = 1`, queryParams);
  if (!rows.length && country === 'CA' && productId.startsWith('cad-')) {
    const fallbackId = productId.replace('cad-', '');
    [rows] = await db.query(`SELECT * FROM products WHERE (id = ? OR slug = ?) AND (country IN ('CA', 'CAD') OR country IS NULL) AND is_active = 1`, [fallbackId, fallbackId]);
  }
  if (!rows.length) return null;
  return _parseProduct(rows[0]);
}

export async function findBySlug(slug, country = 'US') {
  let dbCountry = country;
  if (dbCountry === 'US') dbCountry = 'USA';
  if (dbCountry === 'CA') dbCountry = 'CAD';
  const [rows] = await db.query(`SELECT * FROM products WHERE slug = ? AND (country = ? OR country IS NULL) AND is_active = 1`, [slug, dbCountry]);
  if (!rows.length) return null;
  return _parseProduct(rows[0]);
}

export async function findBySku(sku) {
  let [rows] = await db.query(`SELECT * FROM products WHERE sku = ? AND is_active = 1 LIMIT 1`, [sku]);
  if (rows.length) return _parseProduct(rows[0]);
  [rows] = await db.query(`SELECT p.* FROM product_color_variants cv JOIN products p ON cv.product_id = p.id WHERE cv.amazon_sku = ? AND cv.is_active = 1 LIMIT 1`, [sku]);
  if (rows.length) return _parseProduct(rows[0]);
  return null;
}

export async function findVariantById(identifier) {
  // 1. Check parent products table first (ID, Slug or SKU)
  let [rows] = await db.query(`SELECT * FROM products WHERE (id = ? OR slug = ? OR sku = ?) AND is_active = 1`, [identifier, identifier, identifier]);
  if (rows.length) {
    const p = _parseProduct(rows[0]);
    // Only use amazon_sku or sku if they exist; do NOT fallback to itemModelNumber as it's often not the Seller SKU
    let amazonSku = p.amazon_sku || p.sku || null;
    return { ...p, product_id: p.id, variant_name: p.name, amazon_sku: amazonSku };
  }

  // 2. Check legacy product_color_variants table
  [rows] = await db.query(`
    SELECT cv.*, p.name as product_name, p.image as product_image 
    FROM product_color_variants cv 
    JOIN products p ON cv.product_id = p.id 
    WHERE (cv.id = ? OR cv.amazon_sku = ?) AND cv.is_active = 1
  `, [identifier, identifier]);

  if (rows.length) {
    const v = rows[0];
    const vName = v.variant_name || v.color_name || 'Default';
    return {
      id: v.id,
      product_id: v.product_id,
      name: `${v.product_name} (${vName})`,
      variant_name: vName,
      price: parseFloat(v.price),
      stock: v.stock,
      sku: v.amazon_sku || v.sku,
      amazon_sku: v.amazon_sku || v.sku,
      country: v.country,
      image: v.image_url || v.product_image
    };
  }

  // 3. Check new product_variants table
  [rows] = await db.query(`
    SELECT v.*, p.name as product_name, p.image as product_image, p.country as p_country 
    FROM product_variants v 
    JOIN products p ON v.product_id = p.id 
    WHERE (v.id = ? OR v.sku = ? OR v.amazon_sku = ?) AND v.is_active = 1
  `, [identifier, identifier, identifier]);

  if (rows.length) {
    const v = rows[0];
    let variantSuffix = v.variant_name || v.sku || '';
    try {
      const attrs = typeof v.attributes === 'string' ? JSON.parse(v.attributes) : v.attributes;
      if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
        const vals = Object.values(attrs).join(' / ');
        if (vals) variantSuffix = vals;
      }
    } catch (e) { }

    return {
      id: v.id,
      product_id: v.product_id,
      name: variantSuffix ? `${v.product_name} (${variantSuffix})` : v.product_name,
      variant_name: variantSuffix,
      price: parseFloat(v.price),
      stock: v.stock,
      sku: v.amazon_sku || v.sku,
      amazon_sku: v.amazon_sku || v.sku,
      country: v.p_country,
      image: v.product_image
    };
  }

  return null;
}

export async function validateCartItems(cartItems, country = 'US') {
  const errors = [];
  const validItems = [];
  for (const cartItem of (cartItems || [])) {
    let idValue = cartItem.variantId || cartItem.id || cartItem.sku;
    let baseProductId = idValue;
    let colorValue = null;
    if (typeof idValue === 'string' && idValue.includes('::')) [baseProductId, colorValue] = idValue.split('::');
    const product = await findVariantById(baseProductId);
    if (!product) {
      logger.warn(`Cart validation failed: Item ${idValue} not found at all (id, sku or amazon_sku checked)`);
      errors.push(`Product ${idValue} not found or inactive`);
      continue;
    }
    // Prioritize amazon_sku (Seller SKU) for US MCF fulfillment, auto-correcting poisoned cache payload
    let sku = null;

    let variantName = product.name;

    // Priority 1: variant-level SKU
    if (colorValue && Array.isArray(product.color_options)) {
      const searchColor = colorValue.trim().toLowerCase();
      const option = product.color_options.find(o =>
        (o.value && o.value.toLowerCase() === searchColor) ||
        (o.name && o.name.toLowerCase() === searchColor) ||
        (o.name && o.name.toLowerCase().includes(searchColor))
      );

      if (option?.amazon_sku) {
        sku = option.amazon_sku;
        variantName = `${product.name} (${option.name})`;
      }
    }

    // Priority 2: product-level SKU (only if valid)
    if (!sku && product.amazon_sku) {
      sku = product.amazon_sku;
    }

    // 🚨 HARD FAIL (NO FALLBACKS)
    if (!sku) {
      logger.error(`❌ No valid amazon_sku found for ${product.name}`);
      errors.push(`Product ${product.name} is unavailable`);
      continue;
    }
    validItems.push({ variantId: idValue, productId: product.id, sku: sku, productName: variantName, quantity: cartItem.quantity || 1, unitPrice: parseFloat(cartItem.price || product.price), weightKg: 0.5, country: product.country });
  }
  return { valid: errors.length === 0, errors, items: validItems };
}

export async function deductStock(items, connection = null) {
  const dbConn = connection || db;
  for (const item of items) {
    const qty = parseInt(item.quantity) || 0;
    if (qty <= 0) continue;

    // 1. Try updating new product_variants table first
    if (item.variantId) {
      const [vRes] = await dbConn.execute(
        `UPDATE product_variants SET stock = GREATEST(0, stock - ?) WHERE id = ? OR sku = ?`,
        [qty, item.variantId, item.sku]
      );
      if (vRes.affectedRows > 0) continue;

      // 2. Try legacy product_color_variants
      const [cvRes] = await dbConn.execute(
        `UPDATE product_color_variants SET stock = GREATEST(0, stock - ?) WHERE id = ? OR amazon_sku = ?`,
        [qty, item.variantId, item.sku]
      );
      if (cvRes.affectedRows > 0) continue;
    }

    // 3. Fallback to main products table
    await dbConn.execute(
      `UPDATE products SET inventory_cache = GREATEST(0, inventory_cache - ?) WHERE id = ? OR slug = ? OR sku = ?`,
      [qty, item.productId || item.variantId, item.productId, item.sku]
    );
  }
}

export async function restoreStock(items, connection = null) {
  const dbConn = connection || db;
  for (const item of items) {
    const qty = parseInt(item.quantity) || 0;
    if (qty <= 0) continue;

    if (item.variantId || item.product_variant_id) {
      const vId = item.variantId || item.product_variant_id;
      const [vRes] = await dbConn.execute(
        `UPDATE product_variants SET stock = stock + ? WHERE id = ? OR sku = ?`,
        [qty, vId, item.sku]
      );
      if (vRes.affectedRows > 0) continue;

      const [cvRes] = await dbConn.execute(
        `UPDATE product_color_variants SET stock = stock + ? WHERE id = ? OR amazon_sku = ?`,
        [qty, vId, item.sku]
      );
      if (cvRes.affectedRows > 0) continue;
    }

    const pId = item.product_id || item.productId || item.variantId || item.product_variant_id || null;
    const sku = item.sku || null;

    await dbConn.execute(
      `UPDATE products SET inventory_cache = inventory_cache + ? WHERE id = ? OR slug = ? OR sku = ?`,
      [qty, pId, pId, sku]
    );
  }
}

function _parseProduct(p) {
  if (!p) return null;
  const parseJSON = (val) => {
    if (typeof val === 'string') {
      try { return JSON.parse(val); } catch (e) { return []; }
    }
    return val || [];
  };
  const parseJSONObject = (val) => {
    if (typeof val === 'string') {
      try { return JSON.parse(val); } catch (e) { return {}; }
    }
    return val || {};
  };

  return {
    ...p,
    price: parseFloat(p.price || 0),
    original_price: p.original_price ? parseFloat(p.original_price) : null,
    rating: parseFloat(p.rating || 0),
    review_count: parseInt(p.review_count || 0),
    in_stock: parseInt(p.in_stock || 0),
    images: parseJSON(p.images),
    variant_images: parseJSONObject(p.variant_images),
    videos: parseJSONObject(p.videos),
    features: parseJSON(p.features),
    compatibility: parseJSON(p.compatibility),
    specifications: parseJSONObject(p.specifications),
    about_section: parseJSONObject(p.about_section),
    color_options: parseJSON(p.color_options),
    reviews: parseJSON(p.reviews),
    rating_breakdown: parseJSONObject(p.rating_breakdown),
    tags: parseJSON(p.tags),
    sizes: parseJSON(p.sizes)
  };
}

export async function checkStock(identifier, quantity = 1) {
  let baseId = identifier;
  let colorName = null;
  if (typeof identifier === 'string' && identifier.includes('::')) {
    [baseId, colorName] = identifier.split('::');
  }

  const product = await findVariantById(baseId);
  if (!product) return { available: false, currentStock: 0, error: 'Product not found' };

  let currentStock = product.inventory_cache !== undefined ? product.inventory_cache : (product.stock || 0);

  // If color was specified, find stock in color_options JSON
  if (colorName && Array.isArray(product.color_options)) {
    const searchColor = colorName.trim().toLowerCase();
    const option = product.color_options.find(o => 
      (o.value && o.value.toLowerCase() === searchColor) || 
      (o.name && o.name.toLowerCase() === searchColor)
    );
    if (option) {
      currentStock = option.stock !== undefined ? option.stock : (option.inventory_cache || 0);
    }
  }

  return {
    available: currentStock >= quantity,
    currentStock,
    name: product.name
  };
}

export default { findAll, findById, findBySlug, findBySku, findVariantById, validateCartItems, deductStock, restoreStock, checkStock };
