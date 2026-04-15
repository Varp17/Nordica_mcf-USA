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
  name_ar: Joi.string().allow(null, "").optional(),
  price: Joi.number().positive().required(),
  original_price: Joi.number().positive().allow(null, "").optional(),
  description: Joi.string().allow(null, "").optional(),
  description_ar: Joi.string().allow(null, "").optional(),
  image: Joi.string().allow(null, "").optional(),
  sku: Joi.string().allow(null, "").optional(),
  amazon_sku: Joi.string().allow(null, "").optional(),
  asin: Joi.string().allow(null, "").optional(),
  weight_kg: Joi.number().allow(null).optional(),
  dimensions: Joi.string().allow(null, "").optional(),
  in_stock: Joi.number().integer().min(0).required(),
  category_id: Joi.string().required(),
  brand_id: Joi.string().required(),
  key_features: Joi.array().items(Joi.string()).optional(),
  specifications: Joi.object().optional(),
  category: Joi.string().required(),
  brand: Joi.string().required(),
  target_country: Joi.string().valid('us', 'canada', 'both').default('both')
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
    const safeParse = (str) => {
      if (!str) return [];
      if (typeof str === 'object') return str;
      try { return JSON.parse(str); } catch (e) { return []; }
    };

    const formattedProducts = products.map((product) => ({
      ...product,
      images: safeParse(product.images),
      features: safeParse(product.features),
      specifications: safeParse(product.specifications),
      about_section: safeParse(product.about_section),
      color_options: safeParse(product.color_options),
      originalPrice: product.original_price,
      imageUrl: product.image,
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

    // --- Region Filtering (target_country: us, canada, both) ---
    const userCountry = normalizeCountryCode(req.query.country || req.country || 'CA');
    _log.debug("Fetching products for country:", { userCountry, queryCountry: req.query.country, reqCountry: req.country });
    
    // If user is CA, show 'canada' or 'both'
    // If user is US, show 'us' or 'both'
    const countryTarget = userCountry === 'CA' ? ['canada', 'both'] : ['us', 'both'];
    whereConditions.push(`p.target_country IN (${countryTarget.map(() => '?').join(',')})`);
    queryParams.push(...countryTarget);

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
    const countryTarget = userCountry === 'CA' ? ['canada', 'both'] : ['us', 'both'];
    const countryCondition = `p.target_country IN (${countryTarget.map(() => '?').join(',')})`;

    const [products] = await db.execute(
      `SELECT p.*, c.name as cat_name, b.name as br_name
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       LEFT JOIN brands b ON p.brand_id = b.id
       WHERE p.slug = ? AND ${countryCondition}`,
      [req.params.slug, ...countryTarget],
    )

    if (products.length === 0) {
      return res.status(404).json({ error: "Product not found" })
    }

    const product = products[0];
    
    // Fetch variants for this product with their images
    const [variants] = await db.execute(
      `SELECT v.*, MAX(pi.image_url) as image
       FROM product_color_variants v
       LEFT JOIN product_images pi ON v.id = pi.color_variant_id AND (pi.image_type = 'color_variant' OR pi.is_primary = 1)
       WHERE v.product_id = ? AND v.is_active = 1
       GROUP BY v.id`,
      [product.id]
    );

    // Fetch all variant-specific images to provide full local gallery for each variant
    const [allVariantImages] = await db.execute(
      `SELECT color_variant_id, image_url FROM product_images WHERE product_id = ? AND color_variant_id IS NOT NULL ORDER BY sort_order ASC`,
      [product.id]
    );

    const variantsWithGalleries = variants.map(v => {
      const vImgs = allVariantImages.filter(vi => vi.color_variant_id === v.id).map(vi => vi.image_url);
      return { 
        ...v, 
        images: vImgs.length > 0 ? vImgs : (v.image ? [v.image] : [])
      };
    });

    // Fetch all product-wide images (gallery)
    const [allImages] = await db.execute(
      `SELECT id, image_url, image_type, is_primary, color_variant_id FROM product_images WHERE product_id = ? ORDER BY sort_order ASC`,
      [product.id]
    );

    const formattedProduct = {
      ...product,
      category: product.cat_name || product.category || 'Uncategorized',
      brand: product.br_name || product.brand || 'Generic',
      color_options: typeof product.color_options === "string" ? JSON.parse(product.color_options) : (product.color_options || []),
      variants: variantsWithGalleries && variantsWithGalleries.length > 0 ? variantsWithGalleries : (typeof product.color_options === "string" ? JSON.parse(product.color_options) : (product.color_options || [])),
      keyFeatures: typeof product.key_features === "string" ? JSON.parse(product.key_features) : (product.key_features || []),
      specifications: typeof product.specifications === "string" ? JSON.parse(product.specifications) : (product.specifications || {}),
      compatibility: typeof product.compatibility === "string" ? JSON.parse(product.compatibility) : (product.compatibility || []),
      aboutSection: typeof product.about_section === "string" ? JSON.parse(product.about_section) : (product.about_section || {}),
      videos: typeof product.videos === "string" ? JSON.parse(product.videos) : (product.videos || {}),
      images: [
        ...(allImages || []),
        ...((typeof product.images === "string" ? JSON.parse(product.images) : (product.images || []))
            .filter((img) => {
              const url = typeof img === 'string' ? img : img.image_url;
              return !(allImages || []).some((ai) => ai.image_url === url);
            }))
      ],
      variantImages: typeof product.variant_images === "string" ? JSON.parse(product.variant_images) : (product.variant_images || {}),
      reviews: typeof product.reviews === "string" ? JSON.parse(product.reviews) : (product.reviews || []),
      ratingBreakdown: typeof product.rating_breakdown === "string" ? JSON.parse(product.rating_breakdown) : (product.rating_breakdown || []),
      sizes: typeof product.sizes === "string" ? JSON.parse(product.sizes) : (product.sizes || []),
      originalPrice: product.original_price,
      imageUrl: product.image, // Standardized to match table column 'image'
      createdAt: product.created_at,
    }

    // --- ENRICHMENT LOGIC ---
    // If aboutSection is empty or missing hero/features, try to find them by name in the gallery
    if (formattedProduct.images && formattedProduct.images.length > 0) {
      const getUrl = (img) => typeof img === 'string' ? img : img.image_url;
      
      // 1. Try to find Hero Image
      if (!formattedProduct.aboutSection.heroImage || formattedProduct.aboutSection.heroImage === product.image) {
        const heroImg = formattedProduct.images.find(img => getUrl(img).toLowerCase().includes('1. hero image'));
        if (heroImg) formattedProduct.aboutSection.heroImage = getUrl(heroImg);
      }
      
      // 2. Try to find/add detail features if aboutSection features are missing
      const existingFeatures = formattedProduct.aboutSection.features || [];
      if (existingFeatures.length === 0) {
        const featureImgs = formattedProduct.images.filter(img => {
          const url = getUrl(img).toLowerCase();
          return url.includes('product features') || url.includes('how it works') || url.includes('product uses') || url.includes('dimensions');
        });
        
        if (featureImgs.length > 0) {
          formattedProduct.aboutSection.features = featureImgs.map(img => ({
            title: "", // Title could be extracted from filename but keeping it clean
            description: "",
            image: getUrl(img)
          }));
        }
      }
    }

    // --- VARIANT GALLERY ENRICHMENT ---
    // Extract full galleries from variantImages JSON blob and attach them directly to variants
    if (formattedProduct.variantImages && formattedProduct.variants) {
      formattedProduct.variants = formattedProduct.variants.map(v => {
        // Respect already populated galleries from the images table
        if (v.images && Array.isArray(v.images) && v.images.length > 1) return v;
        
        const vName = (v.variant_name || v.name || "").toLowerCase();
        if (!vName) return v;

        // Find match in the legacy variantImages JSON blob (case-insensitive fuzzy match)
        const matchedKey = Object.keys(formattedProduct.variantImages).find(k => {
          const lowerK = k.toLowerCase();
          return lowerK === vName || vName.includes(lowerK) || lowerK.includes(vName);
        });

        if (matchedKey && formattedProduct.variantImages[matchedKey]) {
          return { 
            ...v, 
            images: formattedProduct.variantImages[matchedKey] 
          };
        }
        return v;
      });
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
    const countryTarget = userCountry === 'CA' ? ['canada', 'both'] : ['us', 'both'];
    const countryCondition = `p.target_country IN (${countryTarget.map(() => '?').join(',')})`;

    const [products] = await db.execute(
      `SELECT p.*, c.name as cat_name, b.name as br_name
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       LEFT JOIN brands b ON p.brand_id = b.id
       WHERE (p.id = ? OR p.slug = ?) AND ${countryCondition}`,
      [req.params.id, req.params.id, ...countryTarget],
    )

    if (products.length === 0) {
      return res.status(404).json({ error: "Product not found" })
    }

    const product = products[0]
    
    // Fetch variants for this product with their primary images
    const [variants] = await db.execute(
      `SELECT v.*, MAX(pi.image_url) as image
       FROM product_color_variants v
       LEFT JOIN product_images pi ON v.id = pi.color_variant_id AND (pi.image_type = 'color_variant' OR pi.is_primary = 1)
       WHERE v.product_id = ? AND v.is_active = 1
       GROUP BY v.id`,
      [product.id]
    );

    // Fetch all variant-specific images to provide full local gallery for each variant
    const [allVariantImages] = await db.execute(
      `SELECT color_variant_id, image_url FROM product_images WHERE product_id = ? AND color_variant_id IS NOT NULL ORDER BY sort_order ASC`,
      [product.id]
    );

    const variantsWithGalleries = variants.map(v => {
      const vImgs = allVariantImages.filter(vi => vi.color_variant_id === v.id).map(vi => vi.image_url);
      return { 
        ...v, 
        images: vImgs.length > 0 ? vImgs : (v.image ? [v.image] : [])
      };
    });

    // Fetch all product-wide images (gallery)
    const [allImages] = await db.execute(
      `SELECT id, image_url, image_type, is_primary, color_variant_id FROM product_images WHERE product_id = ? ORDER BY sort_order ASC`,
      [product.id]
    );

    const formattedProduct = {
      ...product,
      category: product.cat_name || product.category || 'Uncategorized',
      brand: product.br_name || product.brand || 'Generic',
      color_options: typeof product.color_options === "string" ? JSON.parse(product.color_options) : (product.color_options || []),
      variants: variantsWithGalleries && variantsWithGalleries.length > 0 ? variantsWithGalleries : (typeof product.color_options === "string" ? JSON.parse(product.color_options) : (product.color_options || [])),
      keyFeatures: typeof product.key_features === "string" ? JSON.parse(product.key_features) : (product.key_features || []),
      specifications: typeof product.specifications === "string" ? JSON.parse(product.specifications) : (product.specifications || {}),
      compatibility: typeof product.compatibility === "string" ? JSON.parse(product.compatibility) : (product.compatibility || []),
      aboutSection: typeof product.about_section === "string" ? JSON.parse(product.about_section) : (product.about_section || {}),
      videos: typeof product.videos === "string" ? JSON.parse(product.videos) : (product.videos || {}),
      images: allImages.length > 0 ? allImages : (typeof product.images === "string" ? JSON.parse(product.images) : (product.images || [])),
      variantImages: typeof product.variant_images === "string" ? JSON.parse(product.variant_images) : (product.variant_images || {}),
      reviews: typeof product.reviews === "string" ? JSON.parse(product.reviews) : (product.reviews || []),
      ratingBreakdown: typeof product.rating_breakdown === "string" ? JSON.parse(product.rating_breakdown) : (product.rating_breakdown || []),
      sizes: typeof product.sizes === "string" ? JSON.parse(product.sizes) : (product.sizes || []),
      originalPrice: product.original_price,
      imageUrl: product.image, // Changed from image_url to match table column 'image'
      createdAt: product.created_at,
    }

    // --- ENRICHMENT LOGIC ---
    // If aboutSection is empty or missing hero/features, try to find them by name in the gallery
    if (formattedProduct.images && formattedProduct.images.length > 0) {
      const getUrl = (img) => typeof img === 'string' ? img : img.image_url;
      
      // 1. Try to find Hero Image
      if (!formattedProduct.aboutSection.heroImage || formattedProduct.aboutSection.heroImage === product.image) {
        const heroImg = formattedProduct.images.find(img => getUrl(img).toLowerCase().includes('1. hero image'));
        if (heroImg) formattedProduct.aboutSection.heroImage = getUrl(heroImg);
      }
      
      // 2. Try to find/add detail features if aboutSection features are missing
      const existingFeatures = formattedProduct.aboutSection.features || [];
      if (existingFeatures.length === 0) {
        const featureImgs = formattedProduct.images.filter(img => {
          const url = getUrl(img).toLowerCase();
          return url.includes('product features') || url.includes('how it works') || url.includes('product uses') || url.includes('dimensions');
        });
        
        if (featureImgs.length > 0) {
          formattedProduct.aboutSection.features = featureImgs.map(img => ({
            title: "", // Title could be extracted from filename but keeping it clean
            description: "",
            image: getUrl(img)
          }));
        }
      }
    }

    // --- VARIANT GALLERY ENRICHMENT ---
    // Extract full galleries from variantImages JSON blob and attach them directly to variants
    if (formattedProduct.variantImages && formattedProduct.variants) {
      formattedProduct.variants = formattedProduct.variants.map(v => {
        // Respect already populated galleries from the images table
        if (v.images && Array.isArray(v.images) && v.images.length > 1) return v;
        
        const vName = (v.variant_name || v.name || "").toLowerCase();
        if (!vName) return v;

        // Find match in the legacy variantImages JSON blob (case-insensitive fuzzy match)
        const matchedKey = Object.keys(formattedProduct.variantImages).find(k => {
          const lowerK = k.toLowerCase();
          return lowerK === vName || vName.includes(lowerK) || lowerK.includes(vName);
        });

        if (matchedKey && formattedProduct.variantImages[matchedKey]) {
          return { 
            ...v, 
            images: formattedProduct.variantImages[matchedKey] 
          };
        }
        return v;
      });
    }

    res.json({ success: true, product: deepFormatImages(formattedProduct) })
  } catch (error) {
    console.error("Get product error:", error)
    res.status(500).json({ error: "Failed to fetch product" })
  }
})

router.post("/", authenticateToken, requireAdmin, async (req, res) => {
  const { error, value } = productSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details[0].message });
  }

  let { 
    name, name_ar, price, original_price, description, description_ar, image, sku, amazon_sku,
    weight_kg, dimensions, in_stock, category, brand, category_id, brand_id, target_country 
  } = value;

  try {
    const newProductId = uuidv4();
    const stockCount = parseInt(in_stock, 10) || 0;
    const availability = stockCount > 0 ? "In Stock" : "Out of Stock";

    if(image && !image.startsWith('http')) {
      image = image.startsWith('/') 
        ? (image.startsWith('/assets/') ? image : `/assets${image}`)
        : `/assets/${image}`;
    }

    const sql = `
      INSERT INTO products (
        id, name, name_ar, price, original_price, description, description_ar, image, images, sku, amazon_sku,
        weight_kg, dimensions, in_stock, availability, category_id, brand_id, category, brand, target_country
      ) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    await db.execute(sql, [
      newProductId, name, name_ar || null, parseFloat(price), original_price ? parseFloat(original_price) : null,
      description || null, description_ar || null, image || null, JSON.stringify([]), sku || null, amazon_sku || null,
      weight_kg || null, dimensions || null, stockCount, availability, category_id, brand_id, category, brand, target_country || 'both'
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

    const { 
      name, name_ar, price, original_price, description, description_ar, image, brand, category, 
      sku, amazon_sku, weight_kg, dimensions, key_features, specifications, target_country 
    } = value;

    // Get category and brand IDs
    const [categories] = await db.execute("SELECT id FROM categories WHERE name = ?", [category])
    const [brands] = await db.execute("SELECT id FROM brands WHERE name = ?", [brand])

    const categoryId = categories.length > 0 ? categories[0].id : null
    const brandId = brands.length > 0 ? brands[0].id : null

    const [result] = await db.execute(
      `UPDATE products SET 
       name = ?, name_ar = ?, price = ?, original_price = ?, description = ?, description_ar = ?, 
       image = ?, brand = ?, category = ?, category_id = ?, brand_id = ?, sku = ?, amazon_sku = ?,
       weight_kg = ?, dimensions = ?, key_features = ?, specifications = ?, target_country = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        name,
        name_ar || null,
        price,
        original_price || null,
        description,
        description_ar || null,
        image || null,
        brand,
        category,
        categoryId,
        brandId,
        sku || null,
        amazon_sku || null,
        weight_kg || null,
        dimensions || null,
        key_features ? JSON.stringify(key_features) : null,
        specifications ? JSON.stringify(specifications) : null,
        target_country || 'both',
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
  // FIX- [x] Implement Guest OTP verification in `auth.js`
  // - [x] Update `orderRoutes.js` to support guest orders with OTP check
  // - [x] Create `restock_subscriptions` table and `notify-me` endpoint
  // - [/] Improve Email Templates in `emailService.js`
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


// POST /api/products/notify-me - Subscribe to restock alerts
router.post("/notify-me", async (req, res) => {
  try {
    const { email, productId, variantId } = req.body;
    if (!email || !productId) {
      return res.status(400).json({ success: false, message: "Email and Product ID are required" });
    }

    // Check if subscription already exists
    const [existing] = await db.execute(
      "SELECT id FROM restock_subscriptions WHERE email = ? AND product_id = ? AND (variant_id = ? OR (variant_id IS NULL AND ? IS NULL))",
      [email, productId, variantId || null, variantId || null]
    );

    if (existing.length > 0) {
      return res.json({ success: true, message: "You are already subscribed to this product's restock alerts." });
    }

    await db.execute(
      "INSERT INTO restock_subscriptions (email, product_id, variant_id) VALUES (?, ?, ?)",
      [email, productId, variantId || null]
    );

    res.json({ success: true, message: "Subscription successful! We will notify you when this item is back in stock." });
  } catch (error) {
    _log.error("Notify-me error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;