import express from "express";
import { v4 as uuidv4 } from "uuid";
import Joi from "joi";
import db from "../config/database.js";
import { formatImageUrl, deepFormatImages } from '../utils/helpers.js';
import { authenticateToken, requireAdmin } from "../middleware/auth.js";
import logger from "../utils/logger.js";

const _log = logger.child({ module: "products" });

const normalizeCountryCode = (val) => {
  if (!val) return 'CA';
  const upper = String(val).trim().toUpperCase();
  if (upper === 'CA' || upper === 'CAD' || upper === 'CAN') return 'CA';
  if (upper === 'US' || upper === 'USA') return 'US';
  return 'CA';
};

const router = express.Router()

const productSchema = Joi.object({
  name: Joi.string().required(),
  name_ar: Joi.string().allow(null, "").optional(), // Added
  price: Joi.number().positive().required(),
  original_price: Joi.number().positive().allow(null, "").optional(),
  description: Joi.string().allow(null, "").optional(), // Made optional
  description_ar: Joi.string().allow(null, "").optional(), // Added
  image: Joi.string().allow(null, "").optional(), // Made optional, renamed from image_url
  sku: Joi.string().allow(null, "").optional(),
  in_stock: Joi.number().integer().min(0).required(),
  category_id: Joi.string().required(),
  brand_id: Joi.string().required(),
  key_features: Joi.array().items(Joi.string()).optional(),
  specifications: Joi.object().optional(),
  category: Joi.string().required(),
  brand: Joi.string().required(),
});

// GET /api/products/banners - Public route for storefront to fetch active banners
router.get("/banners", async (req, res) => {
  try {
    const { page_location = 'home', device_type } = req.query;
    
    let query = "SELECT * FROM banners WHERE is_active = 1 AND page_location = ?";
    const params = [page_location];

    if (device_type && device_type !== 'both') {
      query += " AND (device_type = ? OR device_type = 'both')";
      params.push(device_type);
    }

    query += " ORDER BY sort_order ASC, created_at DESC";

    const [banners] = await db.query(query, params);
    res.json({ success: true, banners: deepFormatImages(banners) });
  } catch (error) {
    console.error("Public get banners error:", error);
    res.status(500).json({ error: "Failed to fetch banners" });
  }
});

// GET /api/products/categories - Public route for storefront categories
router.get("/categories", async (req, res) => {
  try {
    const [categories] = await db.query("SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order ASC, name ASC");
    res.json({ success: true, categories });
  } catch (error) {
    console.error("Public get categories error:", error);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

// GET /api/products/brands - Public route for storefront brands
router.get("/brands", async (req, res) => {
  try {
    const [brands] = await db.query("SELECT * FROM brands WHERE is_active = 1 ORDER BY name ASC");
    res.json({ success: true, brands });
  } catch (error) {
    console.error("Public get brands error:", error);
    res.status(500).json({ error: "Failed to fetch brands" });
  }
});

router.get("/full_text_search", async (req, res) => {
  try {
    const {
      search, limit = 5,
    } = req.query;
    _log.debug("Full text search query:", {search, limit});
    const [products] = await db.execute(
        `SELECT p.id,p.name,p.original_price,p.price,p.image,p.availability,p.in_stock,p.rating,p.created_at, MATCH(name,category,brand,description) AGAINST(? IN NATURAL LANGUAGE MODE) AS score
         FROM products p
         WHERE p.is_active = 1 and MATCH(name,category,brand,description) AGAINST(? IN NATURAL LANGUAGE MODE)
         ORDER BY score DESC LIMIT ?;`,
        [search,search, limit],
    )
    _log.debug("Full text search results:", {count: products.length});

    if (products.length === 0) {
      return res.status(404).json({ error: "Product not found" })
    }
    const formattedProducts = products.map((product) => ({
      ...product,
      variants: variants,
      originalPrice: product.original_price,
      imageUrl: product.image_url,
      createdAt: product.created_at,
    }));

    res.json({
      products: formattedProducts
    });

  } catch (error) {
    _log.error("Get products error:", error);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

router.get("/", async (req, res) => {
  try {
    const {
      page = 1,
      limit = 12,
      category,
      brand,
      minPrice,
      maxPrice,
      search,
      sortBy, // We no longer need a default here, the switch will handle it
    } = req.query;

    const limitNum = Number.parseInt(limit);
    const offsetNum = (Number.parseInt(page) - 1) * limitNum;

    let orderByClause;
    switch (sortBy) {
      case "price_asc":
        orderByClause = "ORDER BY p.price ASC";
        break;
      case "price_desc":
        orderByClause = "ORDER BY p.price DESC";
        break;
      case "newest":
        orderByClause = "ORDER BY p.created_at DESC";
        break;
      case "featured":
        // "Featured" will show the newest products. This is a common default.
        orderByClause = "ORDER BY p.created_at DESC";
        break;
      default:
        // A safe fallback for any unexpected value or when sortBy is not provided.
        orderByClause = "ORDER BY p.created_at DESC";
        break;
    }

    // --- FIX #2: Update filtering logic to handle multiple IDs ---
    const whereConditions = ["p.is_active = TRUE"]; // Base condition for soft deletes
    const queryParams = [];

    // Country filtering
    const userCountry = normalizeCountryCode(req.query.country || req.country || 'CA');
    _log.debug("Fetching products for country:", { userCountry, queryCountry: req.query.country, reqCountry: req.country });
    const countryMatch = userCountry === 'CA' ? ['CA', 'CAD'] : ['US', 'USA'];
    whereConditions.push(`(p.country IN (${countryMatch.map(() => '?').join(',')}) OR p.country IS NULL)`);
    queryParams.push(...countryMatch);

    if (req.query.categoryIds) {
      const categoryIds = req.query.categoryIds.split(',').map(id => id.trim());
      whereConditions.push(`p.category_id IN (${categoryIds.map(() => '?').join(',')})`);
      queryParams.push(...categoryIds);
    } else if (category) {
      whereConditions.push("p.category_id = ?");
      queryParams.push(category);
    }

    if (req.query.brandIds) {
      const brandIds = req.query.brandIds.split(',').map(id => id.trim());
      whereConditions.push(`p.brand_id IN (${brandIds.map(() => '?').join(',')})`);
      queryParams.push(...brandIds);
    } else if (brand) {
      // backward compatibility
      const brandIds = brand.split(',').map(id => id.trim());
      whereConditions.push(`p.brand_id IN (${brandIds.map(() => '?').join(',')})`);
      queryParams.push(...brandIds);
    }


    if (minPrice) {
      whereConditions.push("p.price >= ?");
      queryParams.push(Number.parseFloat(minPrice));
    }
    if (maxPrice) {
      whereConditions.push("p.price <= ?");
      queryParams.push(Number.parseFloat(maxPrice));
    }
    if (search) {
      // whereConditions.push("(p.name LIKE ? OR p.description LIKE ?)");
      // queryParams.push(`%${search}%`, `%${search}%`);
      whereConditions.push("(p.name LIKE ? OR p.description LIKE ? OR p.name_ar LIKE ? OR p.description_ar LIKE ?)");
      const searchTerm = `%${search}%`;
      queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";

    // Count total matching products (Optimized: No longer needs JOINs)
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM products p
      ${whereClause}
    `;
    const [countResult] = await db.execute(countQuery, queryParams);
    const total = countResult[0].total;

    // Get products with the safe ORDER BY clause and your preferred LIMIT/OFFSET syntax
    const productsQuery = `
      SELECT p.*, c.name as cat_name, b.name as br_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN brands b ON p.brand_id = b.id
      ${whereClause}
      ${orderByClause}
      LIMIT ${limitNum} OFFSET ${offsetNum}
    `;
    const [products] = await db.execute(productsQuery, queryParams);

    const formattedProducts = products.map((product) => ({
      ...product,
      category: product.cat_name || product.category || 'Uncategorized',
      brand: product.br_name || product.brand || 'None',
      keyFeatures: typeof product.key_features === "string" ? JSON.parse(product.key_features) : (product.key_features || []),
      specifications: typeof product.specifications === "string" ? JSON.parse(product.specifications) : (product.specifications || {}),
      aboutSection: typeof product.about_section === "string" ? JSON.parse(product.about_section) : (product.about_section || {}),
      videos: typeof product.videos === "string" ? JSON.parse(product.videos) : (product.videos || {}),
      images: typeof product.images === "string" ? JSON.parse(product.images) : (product.images || []),
      variantImages: typeof product.variant_images === "string" ? JSON.parse(product.variant_images) : (product.variant_images || {}),
      reviews: typeof product.reviews === "string" ? JSON.parse(product.reviews) : (product.reviews || []),
      ratingBreakdown: typeof product.rating_breakdown === "string" ? JSON.parse(product.rating_breakdown) : (product.rating_breakdown || []),
      colorOptions: typeof product.color_options === "string" ? JSON.parse(product.color_options) : (product.color_options || []),
      sizes: typeof product.sizes === "string" ? JSON.parse(product.sizes) : (product.sizes || []),
      originalPrice: product.original_price,
      imageUrl: product.image, // Changed from image_url to match table column 'image'
      createdAt: product.created_at,
    }));

    res.json({
      success: true,
      products: deepFormatImages(formattedProducts),
      pagination: {
        page: Number.parseInt(page),
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error("Get products error:", error);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// Get single product by slug
router.get("/slug/:slug", async (req, res) => {
  _log.debug("GET /slug/:slug request:", { slug: req.params.slug, country: req.query.country });
  try {
    const userCountry = normalizeCountryCode(req.query.country || req.country || 'CA');
    const countryMatch = userCountry === 'CA' ? ['CA', 'CAD'] : ['US', 'USA'];
    const countryCondition = `(p.country IN (${countryMatch.map(() => '?').join(',')}) OR p.country IS NULL)`;

    const [products] = await db.execute(
      `SELECT p.*, c.name as cat_name, b.name as br_name
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       LEFT JOIN brands b ON p.brand_id = b.id
       WHERE p.slug = ? AND ${countryCondition}`,
      [req.params.slug, ...countryMatch],
    )

    if (products.length === 0) {
      return res.status(404).json({ error: "Product not found" })
    }

    const product = products[0];
    
    // Fetch variants for this product
    const [variants] = await db.execute(
      `SELECT * FROM product_color_variants WHERE product_id = ? AND is_active = 1`,
      [product.id]
    );
    const formattedProduct = {
      ...product,
      category: product.cat_name || product.category || 'Uncategorized',
      brand: product.br_name || product.brand || 'Generic',
      color_options: typeof product.color_options === "string" ? JSON.parse(product.color_options) : (product.color_options || []),
      variants: variants && variants.length > 0 ? variants : (typeof product.color_options === "string" ? JSON.parse(product.color_options) : (product.color_options || [])),
      keyFeatures: typeof product.key_features === "string" ? JSON.parse(product.key_features) : (product.key_features || []),
      specifications: typeof product.specifications === "string" ? JSON.parse(product.specifications) : (product.specifications || {}),
      aboutSection: typeof product.about_section === "string" ? JSON.parse(product.about_section) : (product.about_section || {}),
      videos: typeof product.videos === "string" ? JSON.parse(product.videos) : (product.videos || {}),
      images: typeof product.images === "string" ? JSON.parse(product.images) : (product.images || []),
      variantImages: typeof product.variant_images === "string" ? JSON.parse(product.variant_images) : (product.variant_images || {}),
      reviews: typeof product.reviews === "string" ? JSON.parse(product.reviews) : (product.reviews || []),
      ratingBreakdown: typeof product.rating_breakdown === "string" ? JSON.parse(product.rating_breakdown) : (product.rating_breakdown || []),
      sizes: typeof product.sizes === "string" ? JSON.parse(product.sizes) : (product.sizes || []),
      originalPrice: product.original_price,
      imageUrl: product.image, // Standardized to match table column 'image'
      createdAt: product.created_at,
    }

    res.json({ success: true, product: deepFormatImages(formattedProduct) })
  } catch (error) {
    console.error("Get product by slug error:", error)
    res.status(500).json({ error: "Failed to fetch product" })
  }
});

// Get single product
router.get("/:id", async (req, res) => {
  try {
    const userCountry = normalizeCountryCode(req.query.country || req.country || 'CA');
    const countryMatch = userCountry === 'CA' ? ['CA', 'CAD'] : ['US', 'USA'];
    const countryCondition = `(p.country IN (${countryMatch.map(() => '?').join(',')}) OR p.country IS NULL)`;

    const [products] = await db.execute(
      `SELECT p.*, c.name as cat_name, b.name as br_name
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       LEFT JOIN brands b ON p.brand_id = b.id
       WHERE (p.id = ? OR p.slug = ?) AND ${countryCondition}`,
      [req.params.id, req.params.id, ...countryMatch],
    )

    if (products.length === 0) {
      return res.status(404).json({ error: "Product not found" })
    }

    const product = products[0]
    
    // Fetch variants for this product
    const [variants] = await db.execute(
      `SELECT * FROM product_color_variants WHERE product_id = ? AND is_active = 1`,
      [product.id]
    );

    const formattedProduct = {
      ...product,
      category: product.cat_name || product.category || 'Uncategorized',
      brand: product.br_name || product.brand || 'Generic',
      color_options: typeof product.color_options === "string" ? JSON.parse(product.color_options) : (product.color_options || []),
      variants: variants && variants.length > 0 ? variants : (typeof product.color_options === "string" ? JSON.parse(product.color_options) : (product.color_options || [])),
      keyFeatures: typeof product.key_features === "string" ? JSON.parse(product.key_features) : (product.key_features || []),
      specifications: typeof product.specifications === "string" ? JSON.parse(product.specifications) : (product.specifications || {}),
      aboutSection: typeof product.about_section === "string" ? JSON.parse(product.about_section) : (product.about_section || {}),
      videos: typeof product.videos === "string" ? JSON.parse(product.videos) : (product.videos || {}),
      images: typeof product.images === "string" ? JSON.parse(product.images) : (product.images || []),
      variantImages: typeof product.variant_images === "string" ? JSON.parse(product.variant_images) : (product.variant_images || {}),
      reviews: typeof product.reviews === "string" ? JSON.parse(product.reviews) : (product.reviews || []),
      ratingBreakdown: typeof product.rating_breakdown === "string" ? JSON.parse(product.rating_breakdown) : (product.rating_breakdown || []),
      sizes: typeof product.sizes === "string" ? JSON.parse(product.sizes) : (product.sizes || []),
      originalPrice: product.original_price,
      imageUrl: product.image, // Changed from image_url to match table column 'image'
      createdAt: product.created_at,
    }

    res.json({ success: true, product: deepFormatImages(formattedProduct) })
  } catch (error) {
    console.error("Get product error:", error)
    res.status(500).json({ error: "Failed to fetch product" })
  }
})

router.post("/", authenticateToken, requireAdmin, async (req, res) => {
  let { name, name_ar, price, originalPrice, description, description_ar, imageUrl, sku, in_stock, category: category, brand: brand } = req.body;
  console.log(name, price, originalPrice, description, description_ar, imageUrl, sku, in_stock, category, brand);

  if (!name || !price || !category || !brand) {
    return res.status(400).json({ message: "Name, price, category, and brand are required." });
  }

  try {
    const newProductId = uuidv4();
    const stockCount = parseInt(in_stock, 10) || 0;
    const availability = stockCount > 0 ? "In Stock" : "Out of Stock";

    const [[categoryResult]] = await db.execute('SELECT id FROM categories WHERE name = ?', [category]);
    const [[brandResult]] = await db.execute('SELECT id FROM brands WHERE name = ?', [brand]);

    if (!categoryResult || !brandResult) {
      return res.status(400).json({ message: "Invalid Category or Brand ID provided." });
    }

    if(imageUrl && !imageUrl.startsWith('http')) {
      // Ensure path starts with /assets/ as per the database schema in create_tables.sql
      imageUrl = imageUrl.startsWith('/') 
        ? (imageUrl.startsWith('/assets/') ? imageUrl : `/assets${imageUrl}`)
        : `/assets/${imageUrl}`;
    }

    const sql = `
        id, name, name_ar, price, original_price, description, description_ar, image, sku, 
        in_stock, availability, category_id, brand_id, category, brand
      ) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
    await db.execute(sql, [
      newProductId, name, name_ar || null, parseFloat(price), originalPrice ? parseFloat(originalPrice) : null,
      description || null, description_ar || null, imageUrl || null, sku || null, stockCount, availability,
      categoryResult.id, brandResult.id, category, brand
    ]);

    res.status(201).json({ message: "Product created successfully", productId: newProductId });
  } catch (error) {
    console.error("Admin create product error:", error);
    res.status(500).json({ message: "Server error while creating product." });
  }
});

// GET /api/admin/products - Get all products for the admin table
router.get("/products", authenticateToken, requireAdmin, async (req, res) => {
  // This logic is for the admin table, so it's simpler
  const { page = 1, limit = 10, search = '' } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  let whereClause = search ? 'WHERE p.name LIKE ? OR p.sku LIKE ? OR p.name_ar LIKE ?' : '';
  const queryParams = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];

  const productsQuery = `SELECT p.* FROM products p ${whereClause} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`;
  const [products] = await db.execute(productsQuery, [...queryParams, Number(limit), offset]);

  const countQuery = `SELECT COUNT(*) as total FROM products p ${whereClause}`;
  const [countResult] = await db.execute(countQuery, queryParams);

  res.json({
    products,
    pagination: {
      total: countResult[0].total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(countResult[0].total / Number(limit))
    }
  });
});

router.put("/:id", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { error, value } = productSchema.validate(req.body)
    if (error) {
      return res.status(400).json({ error: error.details[0].message })
    }

    const { name, name_ar, price, original_price, description, description_ar, image_url, brand, category, sku, key_features, specifications } =
      value

    // Get category and brand IDs
    const [categories] = await db.execute("SELECT id FROM categories WHERE name = ?", [category])
    const [brands] = await db.execute("SELECT id FROM brands WHERE name = ?", [brand])

    const categoryId = categories.length > 0 ? categories[0].id : null
    const brandId = brands.length > 0 ? brands[0].id : null

    const [result] = await db.execute(
      `UPDATE products SET 
       name = ?, name_ar = ?, price = ?, original_price = ?, description = ?, description_ar = ?, 
       image = ?, brand = ?, category = ?, category_id = ?, brand_id = ?, sku = ?,
       key_features = ?, specifications = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        name,
        name_ar || null,
        price,
        original_price || null,
        description,
        description_ar || null,
        image || null, // Renamed from image_url
        brand,
        category,
        categoryId,
        brandId,
        sku || null,
        key_features ? JSON.stringify(key_features) : null,
        specifications ? JSON.stringify(specifications) : null,
        req.params.id,
      ],
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Product not found" })
    }

    res.json({ message: "Product updated successfully" })
  } catch (error) {
    console.error("Update product error:", error)
    res.status(500).json({ error: "Failed to update product" })
  }
})

router.delete("/:id", authenticateToken, requireAdmin, async (req, res) => {
  // FIX #2: Implement soft delete instead of a hard delete.
  try {
    const [result] = await db.execute(
      "UPDATE products SET is_active = FALSE WHERE id = ?",
      [req.params.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json({ message: "Product archived successfully" });
  } catch (error) {
    console.error("Archive product error:", error);
    res.status(500).json({ error: "Failed to archive product" });
  }
});


export default router;