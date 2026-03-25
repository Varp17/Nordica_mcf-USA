import db from '../config/database.js';
import logger from '../utils/logger.js';

// Real Amazon Seller SKU Mapping provided by User
const MCF_SKU_MAP = {
  "B07ND5F6N8": "1008-4-stickerless",
  "B09CRZD82Q": "DIRT LOCK-SW180 BLACK",
  "B07CKG1VCH": "DLRP-RED-2-stickerless",
  "B09CRX2D31": "DIRT LOCK-SW180 WHITE",
  "B08KTV77ZC": "DIRT LOCK-PWSW-1",
  "B0D66Z4DJB": "DIRT LOCK-SW180 RED",
  "B08FTB19XT": "DIRT LOCK-SAP BLACK",
  "B0FHXV1PRW": "Detail Guardz Hose Guides 2.0_Red",
  "B0FHKTM2YW": "Detail Guardz Hose Guides 2.0_NewBlack",
  "B0FFBC4B67": "Detail Guardz Hose Guides 2.0-Blue",
  "B07P9CWKLJ": "DLRP-G-stickerless",
  "B08KTVWVMJ": "DIRT LOCK-PWS-WHITE-1",
  "B07PBBMSTH": "DLRP-W-stickerless",
  "B07ND4L2ML": "1008-2",
  "B0FHVMVPSV": "Detail Guardz Hose Guides 2.0_Neon",
  "B07CKLPJZR": "DLRP-BLUE-3-stickerless",
  "B08FTK9PJJ": "DIRT LOCK-SAP WHITE",
  "B0FHKV4JZT": "Detail Guardz Hose Guides 2.0_Yellow",
  "B07VGMKW7S": "DIRT LOCK-PW5BL",
  "B07XL4CL1T": "DIRT LOCK-PWS-BLACK",
  "B07CKC4M9D": "DLRP-BLACK-1-stickerless",
  
  // FNSKU fallbacks
  "X002D8MK2D": "DIRT LOCK-PWSW-1",
  "X002D8MDE3": "DIRT LOCK-PWS-WHITE-1",
  "X0021B93NH": "1008-2",
  "X0028XRPQZ": "DIRT LOCK-PW5BL",
  "X00286Q00N": "DIRT LOCK-PWS-BLACK",
  "DG-DL-BLU": "DLRP-BLUE-3-stickerless",
  "DG-DL-SW180-WHT": "DIRT LOCK-SW180 WHITE",
  "DG-DL-SW180-BLK": "DIRT LOCK-SW180 BLACK"
};

/**
 * Resolves a potential ASIN or internal ID to a real Amazon Seller SKU
 */
function resolveMcfSku(id) {
  if (!id) return id;
  // If we have a direct mapping for this identifier (ASIN/FNSKU)
  if (MCF_SKU_MAP[id]) return MCF_SKU_MAP[id];
  return id;
}

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
    return { ...p, product_id: p.id, variant_name: p.name, amazon_sku: p.amazon_sku || p.sku || p.specifications?.asin || p.specifications?.itemModelNumber };
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
    } catch (e) {}

    return { 
      id: v.id, 
      product_id: v.product_id, 
      name: variantSuffix ? `${v.product_name} (${variantSuffix})` : v.product_name, 
      variant_name: variantSuffix, 
      price: parseFloat(v.price), 
      stock: v.stock, 
      sku: v.amazon_sku || v.sku, 
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
    // Prioritize amazon_sku (Seller SKU) for US MCF fulfillment
    let sku = product.amazon_sku || product.sku || product.specifications?.asin || product.specifications?.itemModelNumber || product.id;
    
    // Resolve via real mapping layer
    sku = resolveMcfSku(sku);
    
    // Final check: if it still looks like an ASIN (B0...) and we didn't map it, try itemModelNumber
    if (sku && sku.startsWith('B0') && product.specifications?.itemModelNumber) {
      sku = resolveMcfSku(product.specifications.itemModelNumber);
    }
    let variantName = product.name;
    if (colorValue) {
      const [vRows] = await db.query(`SELECT price, variant_name, amazon_sku, stock FROM product_color_variants WHERE product_id = ? AND (color = ? OR variant_name = ?) AND is_active = 1 LIMIT 1`, [product.id, colorValue, colorValue]);
      if (vRows.length) { 
        if (vRows[0].amazon_sku) {
          sku = resolveMcfSku(vRows[0].amazon_sku);
        }
        if (vRows[0].variant_name) variantName = `${product.name} (${vRows[0].variant_name})`; 
      }
    }
    validItems.push({ variantId: idValue, productId: product.id, sku: sku, productName: variantName, quantity: cartItem.quantity || 1, unitPrice: parseFloat(cartItem.price || product.price), weightKg: 0.5, country: product.country });
  }
  return { valid: errors.length === 0, errors, items: validItems };
}

function _parseProduct(p) {
  if (!p) return p;
  const jsonFields = ['images', 'variant_images', 'features', 'compatibility', 'about_section', 'specifications', 'color_options', 'videos', 'reviews', 'rating_breakdown', 'sizes'];
  jsonFields.forEach(field => {
    if (p[field] && typeof p[field] === 'string') {
      try { p[field] = JSON.parse(p[field]); } catch (err) { if (p[field].startsWith('{') || p[field].startsWith('[')) logger.warn(`Failed to parse JSON for product ${p.id} field ${field}: ${err.message}`); }
    }
  });
  if (p.about_section) p.aboutSection = p.about_section;
  if (p.variant_images) p.variantImages = p.variant_images;
  if (p.color_options) p.colorOptions = p.color_options;
  if (p.review_count) p.reviewCount = p.review_count;
  if (p.original_price) p.originalPrice = parseFloat(p.original_price);
  if (p.price) p.price = parseFloat(p.price);
  if (p.rating) p.rating = parseFloat(p.rating);
  if (p.stock === undefined && p.inventory_cache !== undefined) p.stock = p.inventory_cache;
  return p;
}

export default { findAll, findById, findBySlug, findBySku, findVariantById, validateCartItems };
