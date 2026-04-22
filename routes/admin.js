import express from "express";
import db from "../config/database.js";
import { authenticateToken, requireAdmin } from "../middleware/auth.js";
import { v4 as uuidv4 } from "uuid";
import json2xls from "json2xls";
import path from "path";
import { upload as s3Upload } from "../services/s3Service.js";
import { shippoClient } from "./shippo.js";
import fetch from "node-fetch";
import { deepFormatImages } from "../utils/helpers.js";
import logger from "../utils/logger.js";
import { calculateMCFShipping } from "../utils/shippingCalculator.js";


const router = express.Router();

router.use(json2xls.middleware);


router.get("/analytics", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { country, range = "LAST_30", startDate, endDate, _cb } = req.query;

    console.log(
      `📊 Analytics request: ${country || "ALL"}/${range}${_cb ? " (FORCE FRESH)" : ""
      }`
    );

    // -------- Date filter ----------
    let dateWhere = "1=1";
    const dateParams = [];

    if (range === "TODAY") {
      dateWhere = "DATE(o.created_at) = CURDATE()";
    } else if (range === "LAST_7") {
      dateWhere = "o.created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)";
    } else if (range === "LAST_30") {
      dateWhere = "o.created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)";
    } else if (range === "CUSTOM" && startDate && endDate) {
      dateWhere = "DATE(o.created_at) BETWEEN ? AND ?";
      dateParams.push(startDate, endDate);
    }

    // -------- Country filter ----------
    let countryWhere = "1=1";
    if (country === "US" || country === "CA") {
      countryWhere =
        "JSON_VALID(o.shipping_address) AND JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.country')) = ?";
      dateParams.push(country);
    }

    const baseWhere = `WHERE ${dateWhere} AND ${countryWhere}`;

    // -------- Stats -------    // Total Sales
    const [salesResult] = await db.query(
      `SELECT SUM(total) as totalSales FROM orders WHERE payment_status = 'paid'`
    );
    const totalSales = salesResult[0].totalSales || 0;

    // Total Orders
    const [ordersResult] = await db.query('SELECT COUNT(*) as totalOrders FROM orders');
    const totalOrders = ordersResult[0].totalOrders || 0;

    // Total Customers
    const [customersResult] = await db.query(
      `SELECT COUNT(*) as totalCustomers FROM users WHERE role = 'customer'`
    );
    const totalCustomers = customersResult[0].totalCustomers || 0;

    // Recent Orders
    const [recentOrders] = await db.query(`
      SELECT o.id, o.order_number, o.total, o.status, o.created_at, u.first_name, u.last_name
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      ORDER BY o.created_at DESC
      LIMIT 5
    `);
    const [orderCount] = await db.execute(
      `SELECT COUNT(*) as count 
       FROM orders o 
       ${baseWhere}`,
      dateParams
    );

    const [revenue] = await db.execute(
      `SELECT COALESCE(SUM(o.total), 0) as total 
       FROM orders o 
       ${baseWhere} AND o.payment_status = 'paid'`,
      dateParams
    );

    const [productCount] = await db.execute(
      `SELECT COUNT(*) as count FROM products WHERE is_active = 1`
    );

    const [pendingOrdersCount] = await db.execute(
      `SELECT COUNT(*) as count 
       FROM orders o 
       ${baseWhere} AND o.status = 'pending'`,
      dateParams
    );

    const [cancelledOrdersCount] = await db.execute(
      `SELECT COUNT(*) as count 
       FROM orders o 
       ${baseWhere} AND o.status = 'cancelled'`,
      dateParams
    );

    const [shippedOrdersCount] = await db.execute(
      `SELECT COUNT(*) as count 
       FROM orders o 
       ${baseWhere} AND o.status = 'shipped'`,
      dateParams
    );

    const [deliveredOrdersCount] = await db.execute(
      `SELECT COUNT(*) as count 
       FROM orders o 
       ${baseWhere} AND o.status = 'delivered'`,
      dateParams
    );

    // Regional inventory breakdown for dashboard tabs
    const [inventoryResults] = await db.query(
      `SELECT target_country, COUNT(*) as count FROM products WHERE is_active = 1 GROUP BY target_country`
    );

    const inventoryByRegion = { us: 0, canada: 0, both: 0, total: 0 };
    inventoryResults.forEach(r => {
      const tc = (r.target_country || '').toLowerCase().trim();
      const count = Number(r.count || 0);
      if (tc === 'us') inventoryByRegion.us += count;
      else if (tc === 'canada') inventoryByRegion.canada += count;
      else if (tc === 'both' || tc === '') inventoryByRegion.both += count;
      inventoryByRegion.total += count;
    });

    const stats = {
      totalUsers: Number(customersResult[0].totalCustomers),
      totalOrders: Number(ordersResult[0].totalOrders),
      totalRevenue: Number(salesResult[0].totalSales || 0),
      totalProducts: inventoryByRegion.total,
      pendingOrders: Number(pendingOrdersCount[0].count),
      cancelledOrders: Number(cancelledOrdersCount[0].count),
      shippedOrders: Number(shippedOrdersCount[0].count),
      deliveredOrders: Number(deliveredOrdersCount[0].count),
      inventoryByRegion: {
        ...inventoryByRegion,
        usMarket: inventoryByRegion.us + inventoryByRegion.both,
        canadaMarket: inventoryByRegion.canada + inventoryByRegion.both,
      }
    };

    // -------- Payment revenue breakdown ----------
    const [paymentRevenue] = await db.execute(
      `SELECT o.payment_status, SUM(o.total) as revenue 
       FROM orders o 
       ${baseWhere} 
       GROUP BY o.payment_status`,
      dateParams
    );

    // -------- Sales by region ----------
    const regionParams =
      range === "CUSTOM" && startDate && endDate ? [startDate, endDate] : [];
    const [salesByRegion] = await db.execute(
      `SELECT
         JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.country')) as country,
         SUM(o.total) as total_sales,
         COUNT(o.id) as total_orders
       FROM orders o
       WHERE o.shipping_address IS NOT NULL 
         AND JSON_VALID(o.shipping_address)
         AND ${dateWhere}
        GROUP BY JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.country'))
        ORDER BY total_sales DESC
       LIMIT 5`,
      regionParams
    );

    // -------- Recent orders ----------
    const [orders] = await db.execute(
      `SELECT o.id, o.order_number, o.created_at as order_date, o.total as total_amount, o.status, o.payment_status,
              u.first_name, u.last_name, u.email
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       ${baseWhere}
       ORDER BY o.created_at DESC
       LIMIT 10`,
      dateParams
    );

    // -------- Monthly / daily sales ----------
    let groupExpr = "DATE(o.created_at)";
    let orderExpr = "date";

    if (range === "LAST_30" || range === "LAST_7" || range === "TODAY") {
      groupExpr = "DATE(o.created_at)";
      orderExpr = "date";
    } else {
      groupExpr = "DATE_FORMAT(o.created_at, '%Y-%m')";
      orderExpr = "date";
    }

    const [monthlySalesRaw] = await db.execute(
      `SELECT 
         ${groupExpr} as date,
         SUM(o.total) as revenue,
         COUNT(*) as orders
       FROM orders o
       ${baseWhere}
       GROUP BY ${groupExpr}
       ORDER BY ${orderExpr}`,
      dateParams
    );

    let monthlySales = monthlySalesRaw;

    // -------- Country split (US / CA) --------
    let countrySplit = null;
    if (!country || country === "ALL") {
      const [splitRows] = await db.execute(
        `SELECT 
           JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.country')) as country,
           SUM(o.total) as revenue,
           COUNT(o.id) as orders
         FROM orders o
         WHERE o.shipping_address IS NOT NULL 
           AND JSON_VALID(o.shipping_address)
           AND ${dateWhere}
         GROUP BY JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.country'))`,
        regionParams
      );

      const usRow =
        splitRows.find((r) => r.country === "US") || {
          revenue: 0,
          orders: 0,
        };
      const caRow =
        splitRows.find((r) => r.country === "CA") || {
          revenue: 0,
          orders: 0,
        };

      countrySplit = {
        usRevenue: usRow.revenue || 0,
        caRevenue: caRow.revenue || 0,
        usOrders: usRow.orders || 0,
        caOrders: caRow.orders || 0,
      };

      const [trendSplit] = await db.execute(
        `SELECT 
           ${groupExpr} as date,
           JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.country')) as country,
           SUM(o.total) as revenue
         FROM orders o
         WHERE o.shipping_address IS NOT NULL 
           AND JSON_VALID(o.shipping_address)
           AND ${dateWhere}
         GROUP BY ${groupExpr}, JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.country'))
         ORDER BY ${orderExpr}`,
        regionParams
      );

      const map = {};
      monthlySalesRaw.forEach((row) => {
        map[row.date] = { ...row, revenue_us: 0, revenue_ca: 0 };
      });

      trendSplit.forEach((row) => {
        if (!map[row.date]) {
          map[row.date] = {
            date: row.date,
            revenue: 0,
            orders: 0,
            revenue_us: 0,
            revenue_ca: 0,
          };
        }
        if (row.country === "US") map[row.date].revenue_us = row.revenue || 0;
        if (row.country === "CA") map[row.date].revenue_ca = row.revenue || 0;
      });

      const datesOrdered = monthlySalesRaw.map((r) => r.date);
      monthlySales = datesOrdered.map((d) => map[d]);
    }

    // -------- Failed payments ----------
    const [failedPayments] = await db.execute(
      `SELECT 
         o.id,
         o.created_at,
         o.total as amount,
         JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.country')) as country
       FROM orders o
       WHERE ${dateWhere}
         AND o.payment_status = 'failed'
       ORDER BY o.total DESC
       LIMIT 20`,
      regionParams
    );

    // -------- Top products ----------
    const [topProducts] = await db.execute(
      `SELECT 
         p.id, p.name, p.price, p.image,
         COALESCE(SUM(oi.quantity), 0) as total_sold,
         COALESCE(SUM(oi.quantity * oi.unit_price), 0) as revenue
       FROM products p
       LEFT JOIN order_items oi ON p.id = oi.product_id
       WHERE p.is_active = 1
       GROUP BY p.id, p.name, p.price, p.image
       ORDER BY total_sold DESC, p.id DESC
       LIMIT 10`
    );

    console.log(
      `🏆 Top products: ${topProducts.length} found, products total: ${productCount[0].count}`
    );

    // -------- Sustainability Metrics --------
    const [sustainabilityData] = await db.query(
      `SELECT 
         SUM(actual_shipping_cost) as totalActualShipping, 
         SUM(shipping_profit_loss) as totalShippingProfitLoss 
       FROM orders WHERE payment_status = 'paid'`
    );

    res.json({
      stats: {
        ...stats,
        sustainability: {
          totalActualShipping: Number(sustainabilityData[0].totalActualShipping || 0),
          totalShippingProfitLoss: Number(sustainabilityData[0].totalShippingProfitLoss || 0)
        }
      },
      paymentRevenue,
      recentOrders: orders,
      monthlySales,
      topProducts: topProducts.map(p => ({ ...p, image_url: p.image })),
      salesByRegion,
      failedPayments,
      countrySplit,
    });
  } catch (error) {
    console.error("❌ Analytics error:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch analytics", details: error.message });
  }
});


// GET /inventory - Dedicated Warehouse/SKU view
router.get("/inventory", authenticateToken, requireAdmin, async (req, res) => {
  try {
    // 1. Get legacy variants
    const [legacySkus] = await db.execute(`
      SELECT 
        pcv.id,
        pcv.product_id,
        p.name as product_name,
        pcv.variant_name,
        pcv.color_name,
        pcv.amazon_sku,
        pcv.sku,
        pcv.stock,
        pcv.price,
        pcv.updated_at,
        p.target_country,
        COALESCE(SUM(oi.quantity), 0) as units_sold_all_time,
        ANY_VALUE(pi.image_url) as image,
        'legacy' as table_source
      FROM product_color_variants pcv
      JOIN products p ON pcv.product_id = p.id
      LEFT JOIN product_images pi ON pcv.id = pi.color_variant_id AND (pi.image_type = 'color_variant' OR pi.is_primary = 1)
      LEFT JOIN order_items oi ON oi.product_variant_id = pcv.id
      WHERE pcv.is_active = 1 AND p.is_active = 1
      GROUP BY pcv.id
    `);

    // 2. Get modern variants
    const [modernSkus] = await db.execute(`
      SELECT 
        pv.id,
        pv.product_id,
        p.name as product_name,
        pv.variant_name,
        pv.variant_name as color_name,
        pv.amazon_sku,
        pv.sku,
        pv.stock,
        pv.price,
        pv.updated_at,
        p.target_country,
        COALESCE(SUM(oi.quantity), 0) as units_sold_all_time,
        ANY_VALUE(pi.image_url) as image,
        'modern' as table_source
      FROM product_variants pv
      JOIN products p ON pv.product_id = p.id
      LEFT JOIN product_images pi ON pv.id = pi.color_variant_id AND (pi.image_type = 'color_variant' OR pi.is_primary = 1)
      LEFT JOIN order_items oi ON oi.product_variant_id = pv.id
      WHERE pv.is_active = 1 AND p.is_active = 1
      GROUP BY pv.id
    `);

    // 3. Get simple products (no variants)
    const [simpleSkus] = await db.execute(`
      SELECT 
        p.id,
        p.id as product_id,
        p.name as product_name,
        'Default' as variant_name,
        'Default' as color_name,
        p.amazon_sku,
        p.sku,
        p.in_stock as stock,
        p.price,
        p.updated_at,
        p.target_country,
        COALESCE(SUM(oi.quantity), 0) as units_sold_all_time,
        p.image as image,
        'product' as table_source
      FROM products p
      LEFT JOIN order_items oi ON oi.product_id = p.id
      WHERE p.is_active = 1 
        AND NOT EXISTS (SELECT 1 FROM product_color_variants pcv WHERE pcv.product_id = p.id AND pcv.is_active = 1)
        AND NOT EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active = 1)
      GROUP BY p.id
    `);

    const allSkus = [...legacySkus, ...modernSkus, ...simpleSkus].sort((a, b) => {
      if (a.stock !== b.stock) return a.stock - b.stock;
      return String(a.product_name).localeCompare(String(b.product_name));
    });

    res.json({ success: true, skus: deepFormatImages(allSkus) });
  } catch (error) {
    console.error("Inventory list error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});


// List products
router.get("/products", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = "", category, country } = req.query;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const offset = (pageNum - 1) * limitNum;

    let whereClause = "WHERE p.is_active = 1";
    const params = [];

    if (search) {
      whereClause +=
        " AND (p.name LIKE ? OR p.brand LIKE ? OR p.category LIKE ? OR p.sku LIKE ?)";
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (category && category !== "all") {
      whereClause += " AND p.category = ?";
      params.push(category);
    }
    if (country && country !== "all") {
      whereClause += " AND (LOWER(p.target_country) = ? OR LOWER(p.target_country) = 'both')";
      params.push(country.toLowerCase());
    }

    const [productsResult] = await db.query(`
        SELECT p.*, c.name as category_name 
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
        ${whereClause}
        ORDER BY p.created_at DESC
        LIMIT ? OFFSET ?
      `, [...params, limitNum, offset]);

    const [countResults] = await db.execute(`
        SELECT COUNT(*) as total FROM products p ${whereClause}
      `, params);

    const total = countResults[0]?.total || 0;

    res.json({
      products: productsResult.map(p => {
        const safeParse = (str) => {
          if (!str) return [];
          if (typeof str === 'object') return str;
          try { return JSON.parse(str); } catch (e) { return []; }
        };
        return {
          ...p,
          image_url: p.image, // compatibility
          images: safeParse(p.images),
          features: safeParse(p.key_features || p.features),
          specifications: safeParse(p.specifications),
          tags: safeParse(p.tags),
          shipping_sustainability: p.target_country === 'canada' ? null : (() => {
            const estFee = calculateMCFShipping([{ 
                weightLb: p.weight_lb || (p.weight_kg ? p.weight_kg * 2.20462 : 1.1), 
                dimensionsImperial: p.dimensions_imperial || '10x10x1' 
            }]);
            return {
                est_fee: estFee,
                margin_std: 5.00 - estFee,
                margin_exp: 7.00 - estFee
            };
          })()
        };
      }),
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum)
      }
    });

  } catch (error) {
    console.error("Get products error:", error);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// GET single product detail for admin
router.get(
  "/products/:id",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const [products] = await db.execute(
        `SELECT * FROM products WHERE id = ?`,
        [id]
      );

      if (products.length === 0) {
        return res.status(404).json({ error: "Product not found" });
      }

      const product = products[0];

      // Parse JSON fields
      try { product.features = typeof product.features === 'string' ? JSON.parse(product.features) : (product.features || []); } catch (e) { product.features = []; }
      try { product.specifications = typeof product.specifications === 'string' ? JSON.parse(product.specifications) : (product.specifications || {}); } catch (e) { product.specifications = {}; }
      try { product.images = typeof product.images === 'string' ? JSON.parse(product.images) : (product.images || []); } catch (e) { product.images = []; }
      try { product.tags = typeof product.tags === 'string' ? JSON.parse(product.tags) : (product.tags || []); } catch (e) { product.tags = []; }

      // 1. Get legacy variants
      const [legacyVariants] = await db.execute(
        "SELECT * FROM product_color_variants WHERE product_id = ? AND is_active = 1 ORDER BY sort_order ASC",
        [id]
      );

      // 2. Get modern variants
      const [modernVariantsRaw] = await db.execute(
        "SELECT *, variant_name as color_name FROM product_variants WHERE product_id = ? AND is_active = 1",
        [id]
      );
      const modernVariants = modernVariantsRaw;

      let allVariants = [...legacyVariants, ...modernVariants];

      // 3. Merge with legacy color_options JSON to ensure no variants are "hidden" 
      // due to partial migration.
      if (product.color_options) {
        try {
          const legacyColors = typeof product.color_options === 'string'
            ? JSON.parse(product.color_options)
            : product.color_options;

          if (Array.isArray(legacyColors)) {
            for (const c of legacyColors) {
               const variantSku = c.amazon_sku || c.sku;
               // Check if this variant is already in our table results
               const exists = allVariants.find(v => 
                 (v.amazon_sku && v.amazon_sku === c.amazon_sku) || 
                 (v.sku && v.sku === c.sku) ||
                 (v.color_name && v.color_name.toLowerCase() === (c.name || c.color_name || '').toLowerCase())
               );

               if (!exists) {
                 allVariants.push({
                   id: `legacy-${Math.random().toString(36).substr(2, 9)}`,
                   color_name: c.title || c.name || c.color_name || c.value,
                   color_code: c.color || c.color_code || "#CCCCCC",
                   amazon_sku: c.amazon_sku || null,
                   sku: c.sku || null,
                   stock: c.stock || 0,
                   price: c.price || product.price,
                   updated_at: c.updated_at || null,
                   is_active: 1,
                   is_json_fallback: true,
                   images: c.image ? [{ image_url: c.image, is_primary: 1 }] : []
                 });
               }
            }
          }
        } catch (e) { console.error("Legacy color merge error:", e); }
      }

      // Fetch images for all variants found in tables (if they don't have images from JSON already)
      for (let v of allVariants) {
        if (!v.images || v.images.length === 0) {
          const [vImgs] = await db.execute(
            "SELECT id, image_url, is_primary FROM product_images WHERE color_variant_id = ? ORDER BY sort_order ASC",
            [v.id]
          );
          v.images = vImgs;
        }
      }
      
      product.color_variants = allVariants;

      res.json(product);
    } catch (error) {
      console.error("Admin get product detail error:", error);
      res.status(500).json({ error: "Failed to fetch product details" });
    }
  }
);

// REPLACE image for a specific variant
router.post(
  "/products/:id/variants/:variantId/image",
  authenticateToken,
  requireAdmin,
  s3Upload.single('image'),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const { id, variantId } = req.params;

      if (!req.file) {
        throw new Error("No image file provided.");
      }

      const imageUrl = req.file.location;

      // Check if primary image exists for this variant
      const [existing] = await connection.execute(
        "SELECT id FROM product_images WHERE color_variant_id = ? AND is_primary = 1 LIMIT 1",
        [variantId]
      );

      if (existing.length > 0) {
        // Update existing primary
        await connection.execute(
          "UPDATE product_images SET image_url = ?, alt_text = ? WHERE id = ?",
          [imageUrl, `Product variant image`, existing[0].id]
        );
      } else {
        // Insert new
        await connection.execute(
          "INSERT INTO product_images (id, product_id, color_variant_id, image_url, image_type, is_primary, created_at) VALUES (?,?,?,?,?,?,NOW())",
          [uuidv4(), id, variantId, imageUrl, 'color_variant', 1]
        );
      }

      await connection.commit();
      res.json({ success: true, imageUrl });
    } catch (error) {
      await connection.rollback();
      console.error("❌ Replace variant image error:", error);
      res.status(500).json({ error: "Failed to replace image", details: error.message });
    } finally {
      connection.release();
    }
  }
);

// GENERIC Upload for Gallery / Other Assets
router.post(
  "/products/:id/upload",
  authenticateToken,
  requireAdmin,
  s3Upload.single('image'),
  async (req, res) => {
    try {
      if (!req.file) throw new Error("No file uploaded");
      res.json({ success: true, url: req.file.location });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// PURE GENERIC Upload (for new products without ID)
router.post(
  "/upload",
  authenticateToken,
  requireAdmin,
  s3Upload.single('image'),
  async (req, res) => {
    try {
      if (!req.file) throw new Error("No file uploaded");
      res.json({ success: true, url: req.file.location });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// Create product - RICH CONTENT SUPPORT
router.post(
  "/products",
  authenticateToken,
  requireAdmin,
  s3Upload.any(),
  async (req, res) => {
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      // Process S3 Files if any
      const filesByField = {};
      if (req.files) {
        req.files.forEach(f => {
          if (!filesByField[f.fieldname]) filesByField[f.fieldname] = [];
          filesByField[f.fieldname].push(f.location);
        });
      }

      const {
        name, name_ar, price, original_price, discount,
        short_description, description, description_ar, full_description,
        brand, category, sku, canada_sku, amazon_sku_ca, in_stock, target_country, amazon_url,
        youtube_url, image, images, videos, aboutSection, specifications,
        color_variants, features
      } = req.body;

      // Handle category/brand creation
      let categoryId = null;
      if (category) {
        const [existing] = await connection.execute("SELECT id FROM categories WHERE LOWER(name) = LOWER(?)", [category]);
        if (existing.length > 0) categoryId = existing[0].id;
        else {
          categoryId = uuidv4();
          await connection.execute("INSERT INTO categories (id, name, is_active, created_at) VALUES (?, ?, 1, NOW())", [categoryId, category]);
        }
      }

      let brandId = null;
      if (brand) {
        const [existing] = await connection.execute("SELECT id FROM brands WHERE LOWER(name) = LOWER(?)", [brand]);
        if (existing.length > 0) brandId = existing[0].id;
        else {
          brandId = uuidv4();
          await connection.execute("INSERT INTO brands (id, name, is_active, created_at) VALUES (?, ?, 1, NOW())", [brandId, brand]);
        }
      }

      const stock = parseInt(in_stock) || 0;
      const availability = stock > 0 ? "In Stock" : "Out of Stock";
      const validCountries = ['us', 'canada'];
      let targetCountry = (target_country && validCountries.includes(target_country.toLowerCase())) ? target_country.toLowerCase() : 'us';

      const productId = uuidv4();
      
      // JSON data normalization
      const gallery = typeof images === 'string' ? images : JSON.stringify(images || []);
      const videosJson = typeof videos === 'string' ? videos : JSON.stringify(videos || { main: { url: "", title: "" }, additional: [] });
      const aboutJson = typeof aboutSection === 'string' ? aboutSection : JSON.stringify(aboutSection || { heroImage: "", heroImageAlt: "", description: "", features: [] });
      const specsJson = typeof specifications === 'string' ? specifications : JSON.stringify(specifications || []);
      const featuresJson = typeof features === 'string' ? features : JSON.stringify(features || []);

      await connection.execute(
        `INSERT INTO products (
          id, name, name_ar, price, original_price, discount,
          short_description, description, description_ar, long_description,
          image, images, youtube_url, videos,
          brand, category, category_id, brand_id,
          availability, sku, canada_sku, amazon_sku, amazon_sku_ca, in_stock, inventory_cache,
          about_section, specifications, features,
          target_country, amazon_url, is_active, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())`,
        [
          productId, name, name_ar || null, parseFloat(price),
          original_price ? parseFloat(original_price) : null,
          discount ? parseFloat(discount) : null,
          short_description || null, description || "", description_ar || null, full_description || description || "",
          image || null, gallery, youtube_url || null, videosJson,
          brand, category, categoryId, brandId,
          availability, sku || null, canada_sku || null, req.body.amazon_sku || null, amazon_sku_ca || null, stock, stock,
          aboutJson, specsJson, featuresJson,
          targetCountry, amazon_url || null
        ]
      );

      // 2. Handle Variants & Aggregate Logic
      const variants = typeof color_variants === 'string' ? JSON.parse(color_variants) : (color_variants || []);
      const colorOptionsList = [];
      let aggregateStock = 0;

      for (const v of variants) {
        const vStock = parseInt(v.stock) || 0;
        aggregateStock += vStock;
        const vId = uuidv4();

        await connection.execute(
          "INSERT INTO product_color_variants (id, product_id, sku, canada_sku, color_name, color_code, stock, price, amazon_sku, target_country, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())",
          [vId, productId, v.sku || null, v.canada_sku || null, v.color_name || v.color, v.color_code || v.colorCode || '#000000', vStock, v.price || price, v.amazon_sku || null, targetCountry]
        );

        colorOptionsList.push({
          id: vId,
          name: v.color_name || v.color,
          color: v.color_code || v.colorCode || '#000000',
          stock: vStock,
          amazon_sku: v.amazon_sku || null,
          in_stock: vStock > 0 ? 1 : 0,
          price: parseFloat(v.price) || parseFloat(price) || 0
        });
      }

      // 3. Final Sync for Storefront
      if (colorOptionsList.length > 0) {
        await connection.execute(
          "UPDATE products SET color_options = ?, in_stock = ?, inventory_cache = ? WHERE id = ?",
          [JSON.stringify(colorOptionsList), aggregateStock > 0 ? 1 : 0, aggregateStock, productId]
        );
      }

      await connection.commit();
      res.status(201).json({ success: true, productId, target_country: targetCountry });
    } catch (error) {
      await connection.rollback();
      logger.error("❌ Create product error:", error);
      res.status(500).json({ error: "Failed to create product", details: error.message });
    } finally {
      connection.release();
    }
  }
);

// Consolidated Update Product — Robust & Non-Destructive
router.put(
  "/products/:id",
  authenticateToken,
  requireAdmin,
  s3Upload.any(),
  async (req, res) => {
    const connection = await db.getConnection();
    const { id } = req.params;

    try {
      await connection.beginTransaction();

      // Extract all possible fields from body
      const {
        name, name_ar, price, original_price, discount,
        short_description, description, description_ar, full_description,
        brand, category, in_stock, amazon_url,
        youtube_url, image, images, about_section, aboutSection, 
        specifications, features, weight_kg, weight_lb, dimensions, 
        dimensions_imperial, material, warranty, return_policy,
        color_variants, colorVariants, videos, tags,
        sku, canada_sku, amazon_sku, amazon_sku_ca, target_country
      } = req.body;

      const updates = {};
      const setUpdate = (val, col) => { 
        if (val !== undefined) {
          // If it's a SKU field and it's an empty string, set it to NULL to avoid constraint violations
          if (['sku', 'canada_sku', 'amazon_sku', 'amazon_sku_ca'].includes(col) && val === "") {
            updates[col] = null;
          } else {
            updates[col] = val;
          }
        }
      };

      setUpdate(name, 'name');
      setUpdate(name_ar, 'name_ar');
      if (price !== undefined) setUpdate(parseFloat(price) || 0, 'price');
      setUpdate(original_price ? parseFloat(original_price) : null, 'original_price');
      setUpdate(discount ? parseFloat(discount) : null, 'discount');
      setUpdate(short_description, 'short_description');
      setUpdate(description, 'description');
      setUpdate(description_ar, 'description_ar');
      setUpdate(full_description || description, 'long_description');
      setUpdate(youtube_url, 'youtube_url');
      setUpdate(brand, 'brand');
      setUpdate(category, 'category');
      setUpdate(amazon_url, 'amazon_url');
      setUpdate(sku, 'sku');
      setUpdate(canada_sku, 'canada_sku');
      setUpdate(amazon_sku, 'amazon_sku');
      setUpdate(amazon_sku_ca, 'amazon_sku_ca');
      setUpdate(target_country, 'target_country');
      
      const parseNum = (val) => (val === "" || val === null || val === undefined) ? null : parseFloat(val);
      const parseStock = (val) => (val === "" || val === null || val === undefined) ? 0 : parseInt(val);

      setUpdate(parseNum(weight_kg), 'weight_kg');
      setUpdate(parseNum(weight_lb), 'weight_lb');
      setUpdate(dimensions, 'dimensions');
      setUpdate(dimensions_imperial, 'dimensions_imperial');
      setUpdate(material, 'material');
      setUpdate(warranty, 'warranty');
      setUpdate(return_policy, 'return_policy');
      
      // For simple products (no variants), update in_stock/inventory_cache directly
      if (in_stock !== undefined) {
        const stock = parseStock(in_stock);
        setUpdate(stock, 'in_stock');
        setUpdate(stock, 'inventory_cache');
        setUpdate(stock > 0 ? 'In Stock' : 'Out of Stock', 'availability');
      }


      // Handle standard JSON fields
      const processJson = (val) => (typeof val === 'string' ? val : JSON.stringify(val || null));
      if (images !== undefined) updates.images = processJson(images);
      if (videos !== undefined) updates.videos = processJson(videos);
      if (tags !== undefined) updates.tags = processJson(tags);
      
      const about = about_section || aboutSection;
      if (about !== undefined) updates.about_section = processJson(about);
      
      if (specifications !== undefined) updates.specifications = processJson(specifications);
      if (features !== undefined) updates.features = processJson(features);

      // Handle Image Uploads (Field image or file)
      const filesByField = {};
      if (req.files) {
        req.files.forEach(f => {
          if (!filesByField[f.fieldname]) filesByField[f.fieldname] = [];
          filesByField[f.fieldname].push(f.location || `/uploads/${f.filename}`);
        });
      }

      if (filesByField.image || filesByField.heroImage) {
        updates.image = filesByField.image?.[0] || filesByField.heroImage?.[0];
      } else if (image) {
        updates.image = image;
      }

      // 1. Sync Categories & Brands
      if (category) {
        const catSlug = category.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const [cats] = await connection.execute("SELECT id FROM categories WHERE slug = ?", [catSlug]);
        if (cats.length > 0) {
          updates.category_id = cats[0].id;
        } else {
          const nid = uuidv4();
          await connection.execute("INSERT INTO categories (id, name, slug, is_active) VALUES (?, ?, ?, 1)", [nid, category, catSlug]);
          updates.category_id = nid;
        }
      }

      if (brand) {
        const brandSlug = brand.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const [brs] = await connection.execute("SELECT id FROM brands WHERE slug = ?", [brandSlug]);
        if (brs.length > 0) {
          updates.brand_id = brs[0].id;
        } else {
          const nid = uuidv4();
          await connection.execute("INSERT INTO brands (id, name, slug, is_active) VALUES (?, ?, ?, 1)", [nid, brand, brandSlug]);
          updates.brand_id = nid;
        }
      }

      // 2. Perform Product Update
      if (Object.keys(updates).length > 0) {
        const fields = Object.keys(updates).map(k => `${k} = ?`).join(", ");
        await connection.execute(`UPDATE products SET ${fields}, updated_at = NOW() WHERE id = ?`, [...Object.values(updates), id]);
      }

      // 3. SURGICAL VARIANT SYNC (Non-Destructive)
      const incomingVariants = color_variants || colorVariants;
      if (incomingVariants) {
        const variants = typeof incomingVariants === 'string' ? JSON.parse(incomingVariants) : incomingVariants;
        
        // Fetch existing variants to identify deletions
        const [existing] = await connection.execute("SELECT id FROM product_color_variants WHERE product_id = ?", [id]);
        const existingIds = existing.map(v => v.id);
        const incomingIds = variants.filter(v => v.id && !v.id.startsWith('new-')).map(v => v.id);
        
        // Deactivate variants not in the incoming list (or hard delete if preferred, but deactivation is safer)
        const toRemove = existingIds.filter(eid => !incomingIds.includes(eid));
        if (toRemove.length > 0) {
          await connection.execute(`UPDATE product_color_variants SET is_active = 0 WHERE id IN (?)`, [toRemove]);
        }

        const colorOptionsList = []; // For syncing products.color_options JSON

        for (let i = 0; i < variants.length; i++) {
          const v = variants[i];
          let vId = v.id;
          const isNew = !vId || vId.startsWith('new-') || vId.startsWith('legacy-');

          if (isNew) {
            vId = uuidv4();
            await connection.execute(
              "INSERT INTO product_color_variants (id, product_id, sku, canada_sku, color_name, color_code, amazon_sku, target_country, stock, price, is_active) VALUES (?,?,?,?,?,?,?,?,?,?,1)",
              [vId, id, v.sku || null, v.canada_sku || null, v.color_name || v.color, v.color_code || v.colorCode || '#000000', v.amazon_sku || null, (v.amazon_sku ? 'us' : 'canada'), parseInt(v.stock) || 0, parseFloat(v.price) || 0]
            );
          } else {
            // Fetch existing variant to check for Amazon SKU and preserve it
            const [vRows] = await connection.execute("SELECT amazon_sku, sku, canada_sku, stock, target_country FROM product_color_variants WHERE id = ?", [vId]);
            const existingV = vRows[0];
            
            // If it's an amazon variant, we NEVER update its stock or SKUs manually
            const finalStock = (existingV && existingV.amazon_sku) ? existingV.stock : (parseInt(v.stock) || 0);
            
            // Allow updating SKUs if they change in the payload
            const finalSku = v.sku || existingV.sku;
            const finalCanadaSku = v.canada_sku || existingV.canada_sku;
            const finalAmazonSku = v.amazon_sku || existingV.amazon_sku;

            await connection.execute(
              "UPDATE product_color_variants SET color_name=?, color_code=?, stock=?, price=?, sku=?, canada_sku=?, amazon_sku=?, is_active=1 WHERE id=?",
              [
                v.color_name || v.color, 
                v.color_code || v.colorCode || '#000000', 
                finalStock, 
                parseFloat(v.price) || 0,
                finalSku || null,
                finalCanadaSku || null,
                finalAmazonSku || null,
                vId
              ]
            );
          }

          // Handle variant-specific images if uploaded
          const vFiles = filesByField[`colorVariantImages_${i}`] || [];
          let variantImageUrl = v.image || (v.images?.[0]?.image_url);

          if (vFiles.length > 0) {
             // For simplicity, we replace variant images if new ones are uploaded
             await connection.execute("DELETE FROM product_images WHERE color_variant_id = ?", [vId]);
             for (let j = 0; j < vFiles.length; j++) {
               await connection.execute(
                 "INSERT INTO product_images (id, product_id, image_url, image_type, color_variant_id, sort_order) VALUES (?,?,?,?,?,?)",
                 [uuidv4(), id, vFiles[j], 'color_variant', vId, j + 1]
               );
             }
             variantImageUrl = vFiles[0];
          } else if (isNew && variantImageUrl) {
             // If it's a migrated legacy variant, preserve its primary image in the images table
             await connection.execute(
               "INSERT IGNORE INTO product_images (id, product_id, image_url, image_type, color_variant_id, sort_order) VALUES (?,?,?,?,?,?)",
               [uuidv4(), id, variantImageUrl, 'color_variant', vId, 1]
             );
          }

          colorOptionsList.push({
            id: vId,
            name: v.color_name || v.color,
            color: v.color_code || v.colorCode || '#000000',
            stock: parseInt(v.stock) || 0,
            sku: v.sku || null,
            amazon_sku: v.amazon_sku || null,
            in_stock: (parseInt(v.stock) || 0) > 0 ? 1 : 0,
            price: parseFloat(v.price) || 0,
            image: variantImageUrl || null
          });
        }

        // 4. Update Aggregate Stock and JSON in parent product
        const aggregateStock = colorOptionsList.reduce((sum, v) => sum + v.stock, 0);
        const availability = aggregateStock > 0 ? "In Stock" : "Out of Stock";
        
        await connection.execute(
          "UPDATE products SET color_options = ?, in_stock = ?, inventory_cache = ?, availability = ? WHERE id = ?",
          [
            JSON.stringify(colorOptionsList),
            aggregateStock,
            aggregateStock,
            availability,
            id
          ]
        );
      }

      await connection.commit();
      res.json({ success: true, message: "Product updated successfully" });
    } catch (error) {
      await connection.rollback();
      logger.error("❌ Update product error:", error);
      res.status(500).json({ error: "Failed to update product", details: error.message });
    } finally {
      connection.release();
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// SHIPPING INFO — Weight & Dimensions (used by Shippo for label/rate calc)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PATCH /api/admin/products/:id/shipping-info
 * Update weight and dimensions for a Canada product.
 * Handles:
 *   - Auto-conversion KG ↔ LB (whichever is provided converts the other)
 *   - Dimension string "LxWxH" parsed + stored as both CM and IN
 *   - Returns shippo_parcel preview so admin can see exactly what Shippo will use
 *
 * Body (all optional, at least one required):
 *   { weight_kg?, weight_lb?, dimensions?, dimensions_imperial? }
 */
router.patch("/products/:id/shipping-info", authenticateToken, requireAdmin, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const { id } = req.params;
    let { weight_kg, weight_lb, dimensions, dimensions_imperial } = req.body;

    // ── 1. Validate product exists ──────────────────────────────────────────
    const [rows] = await connection.execute(
      "SELECT id, name, weight_kg, weight_lb, dimensions, dimensions_imperial, target_country FROM products WHERE id = ? AND is_active = 1",
      [id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: "Product not found" });
    const product = rows[0];

    const updates = {};

    // ── 2. Weight handling with auto-conversion ──────────────────────────────
    // Conversion constants
    const KG_TO_LB = 2.20462;
    const LB_TO_KG = 0.453592;

    if (weight_kg !== undefined && weight_kg !== null && weight_kg !== "") {
      const kg = parseFloat(weight_kg);
      if (isNaN(kg) || kg < 0) {
        return res.status(400).json({ success: false, error: "weight_kg must be a non-negative number" });
      }
      updates.weight_kg = parseFloat(kg.toFixed(4));
      // Auto-derive LB if not explicitly provided
      if (weight_lb === undefined || weight_lb === "" || weight_lb === null) {
        updates.weight_lb = parseFloat((kg * KG_TO_LB).toFixed(4));
      }
    }

    if (weight_lb !== undefined && weight_lb !== null && weight_lb !== "") {
      const lb = parseFloat(weight_lb);
      if (isNaN(lb) || lb < 0) {
        return res.status(400).json({ success: false, error: "weight_lb must be a non-negative number" });
      }
      updates.weight_lb = parseFloat(lb.toFixed(4));
      // Auto-derive KG if not explicitly provided
      if (weight_kg === undefined || weight_kg === "" || weight_kg === null) {
        updates.weight_kg = parseFloat((lb * LB_TO_KG).toFixed(4));
      }
    }

    // ── 3. Dimensions handling (format: "LxWxH" or "L x W x H") ───────────
    const CM_TO_IN = 0.393701;
    const IN_TO_CM = 2.54;

    /**
     * Parse "20x15x10" or "20 x 15 x 10" → { length, width, height } numbers
     * Returns null if unparseable.
     */
    const parseDimStr = (str) => {
      if (!str) return null;
      const parts = String(str).trim().split(/[\s]*[xX×]\s*/);
      if (parts.length !== 3) return null;
      const [l, w, h] = parts.map(p => parseFloat(p));
      if ([l, w, h].some(n => isNaN(n) || n <= 0)) return null;
      return { l, w, h };
    };

    /**
     * Format { l, w, h } back to "L x W x H" string (rounded to 2 decimals)
     */
    const fmtDim = ({ l, w, h }) =>
      `${parseFloat(l.toFixed(2))}x${parseFloat(w.toFixed(2))}x${parseFloat(h.toFixed(2))}`;

    if (dimensions !== undefined && dimensions !== null && dimensions !== "") {
      const parsed = parseDimStr(dimensions);
      if (!parsed) {
        return res.status(400).json({
          success: false,
          error: "dimensions must be in format LxWxH (e.g. 20x15x10). Values must be > 0.",
        });
      }
      updates.dimensions = fmtDim(parsed);
      // Auto-derive inches if not explicitly provided
      if (dimensions_imperial === undefined || dimensions_imperial === "" || dimensions_imperial === null) {
        updates.dimensions_imperial = fmtDim({
          l: parsed.l * CM_TO_IN,
          w: parsed.w * CM_TO_IN,
          h: parsed.h * CM_TO_IN,
        });
      }
    }

    if (dimensions_imperial !== undefined && dimensions_imperial !== null && dimensions_imperial !== "") {
      const parsed = parseDimStr(dimensions_imperial);
      if (!parsed) {
        return res.status(400).json({
          success: false,
          error: "dimensions_imperial must be in format LxWxH (e.g. 8x6x4). Values must be > 0.",
        });
      }
      updates.dimensions_imperial = fmtDim(parsed);
      // Auto-derive CM if not explicitly provided
      if (dimensions === undefined || dimensions === "" || dimensions === null) {
        updates.dimensions = fmtDim({
          l: parsed.l * IN_TO_CM,
          w: parsed.w * IN_TO_CM,
          h: parsed.h * IN_TO_CM,
        });
      }
    }

    // ── 4. Require at least one field ────────────────────────────────────────
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        error: "Provide at least one of: weight_kg, weight_lb, dimensions, dimensions_imperial",
      });
    }

    // ── 5. Validate Shippo minimum sizes (avoid useless API calls later) ─────
    const finalKg = updates.weight_kg ?? parseFloat(product.weight_kg) ?? null;
    const finalDimStr = updates.dimensions ?? product.dimensions ?? null;
    const warnings = [];

    if (finalKg !== null && finalKg < 0.01) {
      warnings.push("weight_kg is very low (< 10g) — Shippo may reject this parcel");
    }
    if (finalKg !== null && finalKg > 30) {
      warnings.push("weight_kg exceeds 30kg — Canada Post may not accept this");
    }
    if (finalDimStr) {
      const d = parseDimStr(finalDimStr);
      if (d) {
        if (Math.min(d.l, d.w, d.h) < 0.5) {
          warnings.push("One or more dimensions < 0.5cm — may be rejected by carrier");
        }
        if (d.l + 2 * (d.w + d.h) > 300) {
          warnings.push("Girth + length > 300cm — exceeds Canada Post maximum");
        }
      }
    }

    // ── 6. Persist ───────────────────────────────────────────────────────────
    const fields = Object.keys(updates).map(k => `${k} = ?`).join(", ");
    await connection.execute(
      `UPDATE products SET ${fields}, updated_at = NOW() WHERE id = ?`,
      [...Object.values(updates), id]
    );

    await connection.commit();

    // ── 7. Build Shippo parcel preview for the response ─────────────────────
    const resultKg = updates.weight_kg ?? parseFloat(product.weight_kg) ?? 1;
    const resultDimCm = parseDimStr(updates.dimensions ?? product.dimensions ?? "30x20x15") ?? { l: 30, w: 20, h: 15 };
    const shippo_parcel_preview = {
      length: String(parseFloat(resultDimCm.l.toFixed(2))),
      width:  String(parseFloat(resultDimCm.w.toFixed(2))),
      height: String(parseFloat(resultDimCm.h.toFixed(2))),
      distance_unit: "cm",
      weight: String(parseFloat(resultKg.toFixed(4))),
      mass_unit: "kg",
    };

    logger.info(`[SHIPPING] ${product.name} — dims: ${updates.dimensions ?? 'unchanged'}, weight: ${updates.weight_kg ?? 'unchanged'}kg`);

    res.json({
      success: true,
      productId: id,
      updated: updates,
      shippo_parcel_preview,
      warnings: warnings.length ? warnings : undefined,
    });
  } catch (err) {
    await connection.rollback();
    logger.error(`PATCH /products/:id/shipping-info error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    connection.release();
  }
});



/**
 * PATCH /api/admin/products/:id/stock
 * Update base product stock (in_stock / inventory_cache).
 * Body: { stock: number, reason?: string }
 */
router.patch("/products/:id/stock", authenticateToken, requireAdmin, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const { id } = req.params;
    const stock = parseInt(req.body.stock);
    const reason = req.body.reason || 'Admin CRM update';

    if (isNaN(stock) || stock < 0) {
      return res.status(400).json({ success: false, error: 'stock must be a non-negative integer' });
    }

    // Verify product exists
    const [rows] = await connection.execute("SELECT id, name, in_stock FROM products WHERE id = ? AND is_active = 1", [id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Product not found' });

    const prev = rows[0].in_stock;
    const availability = stock > 0 ? 'In Stock' : 'Out of Stock';

    await connection.execute(
      "UPDATE products SET in_stock = ?, inventory_cache = ?, availability = ?, updated_at = NOW() WHERE id = ?",
      [stock, stock, availability, id]
    );

    await connection.commit();
    logger.info(`[STOCK] ${rows[0].name} base stock: ${prev} → ${stock} (${reason})`);

    res.json({ success: true, productId: id, stock, availability, previous: prev });
  } catch (err) {
    await connection.rollback();
    logger.error(`PATCH /products/:id/stock error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    connection.release();
  }
});

/**
 * PATCH /api/admin/products/:id/variants/stock
 * Bulk update multiple variant stocks in a single atomic transaction.
 * Body: { variants: [{ id, stock, price?, color_name?, amazon_sku? }] }
 * After update: recalculates and syncs parent product in_stock aggregate.
 */
router.patch("/products/:id/variants/stock", authenticateToken, requireAdmin, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const { id } = req.params;
    const { variants } = req.body;

    if (!Array.isArray(variants) || variants.length === 0) {
      return res.status(400).json({ success: false, error: 'variants must be a non-empty array' });
    }

    // Verify product exists
    const [pRows] = await connection.execute("SELECT id, name FROM products WHERE id = ? AND is_active = 1", [id]);
    if (pRows.length === 0) return res.status(404).json({ success: false, error: 'Product not found' });

    const results = [];

    for (const v of variants) {
      const stock = parseInt(v.stock);
      if (isNaN(stock) || stock < 0) {
        throw new Error(`Invalid stock value for variant ${v.id}: ${v.stock}`);
      }

      // 1. Try legacy table
      const legacyFields = ['stock = ?', 'is_active = 1', 'updated_at = NOW()'];
      const legacyValues = [stock];
      if (v.price !== undefined) { legacyFields.push('price = ?'); legacyValues.push(parseFloat(v.price) || 0); }
      if (v.color_name !== undefined) { legacyFields.push('color_name = ?'); legacyValues.push(v.color_name); }
      if (v.color_code !== undefined) { legacyFields.push('color_code = ?'); legacyValues.push(v.color_code); }
      if (v.amazon_sku !== undefined) { legacyFields.push('amazon_sku = ?'); legacyValues.push(v.amazon_sku || null); }
      if (v.sku !== undefined) { legacyFields.push('sku = ?'); legacyValues.push(v.sku || null); }

      legacyValues.push(v.id, id);

      let [upd] = await connection.execute(
        `UPDATE product_color_variants SET ${legacyFields.join(', ')} WHERE id = ? AND product_id = ?`,
        legacyValues
      );

      // 2. Try modern table if not found
      if (upd.affectedRows === 0) {
        const modernFields = ['stock = ?', 'is_active = 1', 'updated_at = NOW()'];
        const modernValues = [stock];
        if (v.price !== undefined) { modernFields.push('price = ?'); modernValues.push(parseFloat(v.price) || 0); }
        if (v.variant_name !== undefined || v.color_name !== undefined) { 
          modernFields.push('variant_name = ?'); 
          modernValues.push(v.variant_name || v.color_name); 
        }
        if (v.amazon_sku !== undefined) { modernFields.push('amazon_sku = ?'); modernValues.push(v.amazon_sku || null); }
        if (v.sku !== undefined) { modernFields.push('sku = ?'); modernValues.push(v.sku || null); }

        modernValues.push(v.id, id);

        [upd] = await connection.execute(
          `UPDATE product_variants SET ${modernFields.join(', ')} WHERE id = ? AND product_id = ?`,
          modernValues
        );
      }

      if (upd.affectedRows === 0) {
        logger.warn(`[STOCK] Variant ${v.id} not found for product ${id}, skipped`);
        results.push({ variantId: v.id, status: 'not_found' });
      } else {
        results.push({ variantId: v.id, stock, status: 'updated' });
      }
    }

    // 3. Re-aggregate total stock and sync JSON color_options
    const [legacyVariants] = await connection.execute(
      "SELECT id, sku, color_name, color_code, amazon_sku, stock, price FROM product_color_variants WHERE product_id = ? AND is_active = 1", [id]
    );
    const [modernVariants] = await connection.execute(
      "SELECT id, sku, variant_name as color_name, variant_name as color_code, amazon_sku, stock, price FROM product_variants WHERE product_id = ? AND is_active = 1", [id]
    );

    const allVariants = [...legacyVariants, ...modernVariants];
    
    if (allVariants.length > 0) {
      const aggregateStock = allVariants.reduce((sum, v) => sum + (parseInt(v.stock) || 0), 0);
      const colorOptionsList = allVariants.map(v => ({
        id: v.id,
        name: v.color_name,
        color: v.color_code || '#CCCCCC',
        stock: parseInt(v.stock) || 0,
        sku: v.sku || null,
        amazon_sku: v.amazon_sku || null,
        in_stock: (parseInt(v.stock) || 0) > 0 ? 1 : 0,
        price: v.price || 0
      }));

      await connection.execute(
        "UPDATE products SET color_options = ?, in_stock = ?, inventory_cache = ?, availability = ?, updated_at = NOW() WHERE id = ?",
        [
          JSON.stringify(colorOptionsList),
          aggregateStock,
          aggregateStock,
          aggregateStock > 0 ? 'In Stock' : 'Out of Stock',
          id
        ]
      );
    }

    await connection.commit();
    res.json({ success: true, productId: id, results });
  } catch (err) {
    await connection.rollback();
    logger.error(`PATCH /products/:id/variants/stock error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    connection.release();
  }
});

/**
 * PATCH /api/admin/products/:id/variants/:variantId/stock
 * Update a single variant's stock — for inline CRM row edits.
 * Handles both legacy and modern variant tables automatically.
 */
router.patch("/products/:id/variants/:variantId/stock", authenticateToken, requireAdmin, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const { id, variantId } = req.params;
    const stock = parseInt(req.body.stock);

    if (isNaN(stock) || stock < 0) {
      return res.status(400).json({ success: false, error: 'stock must be a non-negative integer' });
    }

    // 1. Try legacy table first
    let [upd] = await connection.execute(
      "UPDATE product_color_variants SET stock = ?, is_active = 1, updated_at = NOW() WHERE id = ? AND product_id = ?",
      [stock, variantId, id]
    );

    // 2. Try modern table if not found in legacy
    if (upd.affectedRows === 0) {
      [upd] = await connection.execute(
        "UPDATE product_variants SET stock = ?, is_active = 1, updated_at = NOW() WHERE id = ? AND product_id = ?",
        [stock, variantId, id]
      );
    }

    // 3. If it's a simple product (id == variantId), update the products table directly
    if (upd.affectedRows === 0 && id === variantId) {
      [upd] = await connection.execute(
        "UPDATE products SET in_stock = ?, inventory_cache = ?, availability = ?, updated_at = NOW() WHERE id = ?",
        [stock, stock, stock > 0 ? 'In Stock' : 'Out of Stock', id]
      );
    }

    if (upd.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, error: 'Variant or Product not found' });
    }

    // 4. Sync aggregate stock and color_options JSON if it has variants
    const [legacyVariants] = await connection.execute(
      "SELECT id, sku, color_name, color_code, amazon_sku, stock, price FROM product_color_variants WHERE product_id = ? AND is_active = 1", [id]
    );
    const [modernVariants] = await connection.execute(
      "SELECT id, sku, variant_name as color_name, variant_name as color_code, amazon_sku, stock, price FROM product_variants WHERE product_id = ? AND is_active = 1", [id]
    );

    const allVariants = [...legacyVariants, ...modernVariants];
    
    if (allVariants.length > 0) {
      const aggregateStock = allVariants.reduce((sum, v) => sum + (parseInt(v.stock) || 0), 0);
      const colorOptionsList = allVariants.map(v => ({
        id: v.id,
        name: v.color_name,
        color: v.color_code || '#CCCCCC',
        stock: parseInt(v.stock) || 0,
        sku: v.sku || null,
        amazon_sku: v.amazon_sku || null,
        in_stock: (parseInt(v.stock) || 0) > 0 ? 1 : 0,
        price: v.price || 0
      }));

      await connection.execute(
        "UPDATE products SET color_options = ?, in_stock = ?, inventory_cache = ?, availability = ?, updated_at = NOW() WHERE id = ?",
        [
          JSON.stringify(colorOptionsList),
          aggregateStock,
          aggregateStock,
          aggregateStock > 0 ? 'In Stock' : 'Out of Stock',
          id
        ]
      );
    }

    await connection.commit();
    logger.info(`[STOCK] Variant/Product ${variantId} update to ${stock}`);

    res.json({ success: true, variantId, stock, productId: id });
  } catch (err) {
    await connection.rollback();
    logger.error(`PATCH /products/:id/variants/:variantId/stock error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    connection.release();
  }
});

// Delete product (soft delete)

router.delete(
  "/products/:id",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const [result] = await db.execute(
        "UPDATE products SET is_active = 0, updated_at = NOW() WHERE id = ?",
        [req.params.id]
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: "Product not found" });
      }
      res.json({ message: "Product deleted (soft)" });
    } catch (error) {
      console.error("Delete product error:", error);
      res.status(500).json({ error: "Failed to delete product" });
    }
  }
);

router.get("/orders", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, country } = req.query;
    const offset =
      Number.parseInt(page, 10) - 1 >= 0
        ? (Number.parseInt(page, 10) - 1) * Number.parseInt(limit, 10)
        : 0;
    const limitNum = Number.parseInt(limit, 10);

    const conditions = [];
    const queryParams = [];

    if (status) {
      conditions.push("o.status = ?");
      queryParams.push(status);
    }

    if (country && country !== 'ALL') {
      conditions.push("JSON_VALID(o.shipping_address) AND JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.country')) = ?");
      queryParams.push(country);
    }

    const whereClause = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

    const query = `
      SELECT 
        o.id,
        o.order_number,
        o.created_at AS order_date,
        o.total AS total_amount,
        o.currency,
        o.status,
        o.payment_status,
        JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.country')) AS shipping_country,
        o.customer_email AS email,
        COALESCE(u.first_name, o.shipping_first_name) AS first_name,
        COALESCE(u.last_name, o.shipping_last_name) AS last_name,
        o.actual_shipping_cost,
        o.shipping_cost,
        o.shipping_profit_loss,
        (SELECT JSON_ARRAYAGG(
          JSON_OBJECT(
            'name', oi.product_name_at_purchase,
            'image', COALESCE(oi.image_url_at_purchase, p.image),
            'price', oi.price_at_purchase,
            'qty', oi.quantity
          )
        ) FROM order_items oi 
          LEFT JOIN products p ON oi.product_id = p.id
          WHERE oi.order_id = o.id) as items
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    const [orders] = await db.execute(query, queryParams);

    const countQuery = `SELECT COUNT(*) as total FROM orders o ${whereClause}`;
    const [countResult] = await db.execute(countQuery, queryParams);

    res.json({
      orders,
      pagination: {
        page: Number.parseInt(page, 10),
        limit: limitNum,
        total: countResult[0].total,
        pages: Math.ceil(countResult[0].total / limitNum),
      },
    });
  } catch (error) {
    console.error("Get admin orders error:", error);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// Update order status + payment_status
router.put(
  "/orders/:id/status",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const { status, payment_status } = req.body;
      const validStatuses = [
        "pending",
        "processing",
        "shipped",
        "delivered",
        "cancelled",
      ];
      const validPayments = ["pending", "paid", "failed", "refunded"];

      if (status && !validStatuses.includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      if (payment_status && !validPayments.includes(payment_status)) {
        return res.status(400).json({ error: "Invalid payment status" });
      }

      const updates = {};
      if (status) updates.status = status;
      if (payment_status) updates.payment_status = payment_status;

      const fields = Object.keys(updates)
        .map((k) => `${k} = ?`)
        .join(", ");
      const values = [...Object.values(updates), req.params.id];

      const [result] = await db.execute(
        `UPDATE orders SET ${fields}, updated_at = NOW() WHERE id = ?`,
        values
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: "Order not found" });
      }
      res.json({ message: "Order updated" });
    } catch (error) {
      console.error("Update order error:", error);
      res.status(500).json({ error: "Failed to update order" });
    }
  }
);





/**
 * CUSTOMERS
 */

// Customers list
router.get("/customers", authenticateToken, requireAdmin, async (req, res) => {
  try {
    let { page = 1, limit = 20, search = "" } = req.query;

    page = parseInt(page, 10);
    limit = parseInt(limit, 10);

    if (isNaN(page) || page < 1) page = 1;
    if (isNaN(limit) || limit < 1) limit = 20;

    const offset = (page - 1) * limit;

    let whereClause = `WHERE u.role = 'customer'`;
    const queryParams = [];

    if (search) {
      whereClause +=
        ` AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)`;
      queryParams.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const query = `
      SELECT 
        u.id, u.email, u.first_name, u.last_name, u.phone,
        u.created_at as member_since, u.last_login_at as last_login, u.is_email_verified,
        COUNT(o.id) as total_orders,
        COALESCE(SUM(o.total), 0) as total_spent
      FROM users u
      LEFT JOIN orders o ON u.id = o.user_id
      ${whereClause}
      GROUP BY u.id
      ORDER BY u.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [customers] = await db.execute(query, queryParams);

    const countQuery = `SELECT COUNT(*) as total FROM users u ${whereClause}`;
    const [countResult] = await db.execute(countQuery, queryParams);

    res.json({
      customers,
      pagination: {
        page,
        limit,
        total: countResult[0].total,
        pages: Math.ceil(countResult[0].total / limit),
      },
    });
  } catch (error) {
    console.error("Get customers error:", error);
    res.status(500).json({ error: "Failed to fetch customers" });
  }
});

// Single customer details + last 5 orders
router.get(
  "/customers/:id",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;

      const customerQuery = `
        SELECT u.id, u.email, u.first_name, u.last_name, u.phone,
               u.created_at as member_since, u.last_login_at as last_login, u.is_email_verified, u.role,
               COUNT(o.id) as total_orders,
               COALESCE(SUM(o.total), 0) as total_spent
        FROM users u
        LEFT JOIN orders o ON u.id = o.user_id
        WHERE u.id = ? AND u.role = 'customer'
        GROUP BY u.id
      `;
      const [customers] = await db.execute(customerQuery, [id]);

      if (customers.length === 0) {
        return res.status(404).json({ message: "Customer not found." });
      }
      const customer = customers[0];

      const ordersQuery = `
        SELECT id, order_number, created_at AS order_date, total as total_amount, status
        FROM orders
        WHERE user_id = ?
        ORDER BY created_at DESC
      `;
      const [recentOrders] = await db.execute(ordersQuery, [id]);

      res.json({
        ...customer,
        recentOrders,
      });
    } catch (error) {
      console.error("Get single customer error:", error);
      res.status(500).json({ error: "Failed to fetch customer details." });
    }
  }
);

// router.post(
//   "/orders/:id/shippo-create",
//   authenticateToken,
//   requireAdmin,
//   async (req, res) => {
//     try {
//       const orderId = req.params.id;
//       const { carrier } = req.body || {};

//       if (!carrier) {
//         return res.status(400).json({ error: "carrier is required" });
//       }

//       // Load order with shipping address + user info
//       const [rows] = await db.execute(
//         `
//         SELECT 
//           o.*,
//           u.first_name,
//           u.last_name,
//           u.email
//         FROM orders o
//         JOIN users u ON o.user_id = u.id
//         WHERE o.id = ?
//         `,
//         [orderId]
//       );

//       if (!rows.length) {
//         return res.status(404).json({ error: "Order not found" });
//       }

//       const order = rows[0];

//       // Handle MySQL JSON column safely
//       let shippingAddress = null;
//       if (order.shipping_address) {
//         if (typeof order.shipping_address === "string") {
//           try {
//             shippingAddress = JSON.parse(order.shipping_address);
//           } catch (e) {
//             console.error("Failed to parse shipping_address JSON:", e);
//             shippingAddress = null;
//           }
//         } else {
//           shippingAddress = order.shipping_address;
//         }
//       }

//       const shippingCountry =
//         shippingAddress?.country || shippingAddress?.Country || null;

//       if (!shippingCountry || String(shippingCountry).toUpperCase() !== "CA") {
//         return res.status(400).json({
//           error: "Shippo integration only allowed for Canada orders",
//         });
//       }

//       if (order.payment_status !== "paid") {
//         return res.status(400).json({
//           error: "Shippo shipment can only be created for paid orders",
//         });
//       }

//       if (order.shippo_tracking_number && order.shippo_carrier) {
//         return res.status(400).json({
//           error: "Shippo shipment already exists for this order",
//         });
//       }

//       // Build Shippo addresses (plain JS objects)
//       const toAddress = {
//         name:
//           `${order.first_name || ""} ${order.last_name || ""}`.trim() ||
//           shippingAddress?.name ||
//           "Customer",
//         email: order.email || shippingAddress?.email || undefined,
//         street1: shippingAddress?.address1 || shippingAddress?.line1,
//         street2: shippingAddress?.address2 || shippingAddress?.line2 || "",
//         city: shippingAddress?.city,
//         state: shippingAddress?.state || shippingAddress?.province,
//         zip: shippingAddress?.postal_code || shippingAddress?.zip,
//         country: shippingCountry,
//         phone: shippingAddress?.phone || undefined,
//       };

//       const fromAddress = {
//         name: process.env.SHIPPO_FROM_NAME || "Nordica Plastics",
//         street1: process.env.SHIPPO_FROM_STREET1 || "Default Street",
//         street2: process.env.SHIPPO_FROM_STREET2 || "",
//         city: process.env.SHIPPO_FROM_CITY || "Toronto",
//         state: process.env.SHIPPO_FROM_STATE || "ON",
//         zip: process.env.SHIPPO_FROM_ZIP || "M5V1E3",
//         country: process.env.SHIPPO_FROM_COUNTRY || "CA",
//         phone: process.env.SHIPPO_FROM_PHONE || undefined,
//         email: process.env.SHIPPO_FROM_EMAIL || undefined,
//       };

//       // 1) Create shipment with restricted carrier (Shippo SDK v2 schema)
//       const shipment = await shippoClient.shipments.create({
//         addressFrom: {
//           name: fromAddress.name,
//           street1: fromAddress.street1,
//           street2: fromAddress.street2 || undefined,
//           city: fromAddress.city,
//           state: fromAddress.state,
//           zip: fromAddress.zip,
//           country: fromAddress.country,
//           phone: fromAddress.phone || undefined,
//           email: fromAddress.email || undefined,
//         },
//         addressTo: {
//           name: toAddress.name,
//           street1: toAddress.street1,
//           street2: toAddress.street2 || undefined,
//           city: toAddress.city,
//           state: toAddress.state,
//           zip: toAddress.zip,
//           country: toAddress.country,
//           phone: toAddress.phone || undefined,
//           email: toAddress.email || undefined,
//         },
//         parcels: [
//           {
//             length: 10,
//             width: 10,
//             height: 5,
//             distanceUnit: "cm", // must be one of: "cm","in","ft","m","mm","yd"
//             weight: 0.5,
//             massUnit: "kg",     // must be one of: "g","kg","lb","oz"
//           },
//         ],
//         carrierAccounts: [carrier], // carrier account IDs or codes you configured
//       });

//       if (!shipment || !shipment.rates || !shipment.rates.length) {
//         return res.status(400).json({
//           error: "No rates returned from Shippo for this shipment",
//         });
//       }

//       // Pick the cheapest rate
//       const rate = shipment.rates.reduce((best, r) => {
//         if (!best) return r;
//         const bestPrice = parseFloat(best.amount || best.price || "0");
//         const rPrice = parseFloat(r.amount || r.price || "0");
//         return rPrice < bestPrice ? r : best;
//       }, null);

//       if (!rate) {
//         return res.status(400).json({
//           error: "Failed to select rate for Shippo shipment",
//         });
//       }

//       // 2) Buy label (transaction)
//       const transaction = await shippoClient.transactions.create({
//         rate: rate.object_id,
//         label_file_type: "PDF",
//         async: false,
//       });

//       if (transaction.status !== "SUCCESS") {
//         return res.status(400).json({
//           error: "Shippo transaction failed",
//           details: transaction,
//         });
//       }

//       const trackingNumber =
//         transaction.tracking_number || transaction.trackingNumber || null;
//       const trackingCarrier =
//         transaction.tracking_carrier ||
//         transaction.trackingCarrier ||
//         transaction.carrier ||
//         carrier;

//       // 3) Save tracking to orders table
//       await db.execute(
//         `
//         UPDATE orders
//         SET shippo_tracking_number = ?,
//             shippo_carrier = ?,
//             shippo_tracking_status = 'UNKNOWN',
//             shippo_tracking_raw = ?
//         WHERE id = ?
//         `,
//         [
//           trackingNumber,
//           trackingCarrier,
//           JSON.stringify(transaction),
//           orderId,
//         ]
//       );

//       res.json({
//         success: true,
//         tracking_number: trackingNumber,
//         carrier: trackingCarrier,
//         label_url: transaction.label_url || transaction.labelUrl || null,
//       });
//     } catch (error) {
//       console.error("Shippo create shipment error:", error);
//       res.status(500).json({
//         error: "Failed to create Shippo shipment",
//         details: error.message,
//       });
//     }
//   }
// );

//testin route of order shipo actions


// router.post(
//   "/orders/:id/shippo-create",
//   authenticateToken,
//   requireAdmin,
//   async (req, res) => {
//     try {
//       const orderId = req.params.id;
//       const { carrier } = req.body || {};

//       if (!carrier) {
//         return res.status(400).json({ error: "carrier is required" });
//       }

//       // Load order with shipping address + user info
//       const [rows] = await db.execute(
//         `
//         SELECT 
//           o.*,
//           u.first_name,
//           u.last_name,
//           u.email
//         FROM orders o
//         JOIN users u ON o.user_id = u.id
//         WHERE o.id = ?
//         `,
//         [orderId]
//       );

//       if (!rows.length) {
//         return res.status(404).json({ error: "Order not found" });
//       }

//       const order = rows[0];

//       // Handle MySQL JSON column safely
//       let shippingAddress = null;
//       if (order.shipping_address) {
//         if (typeof order.shipping_address === "string") {
//           try {
//             shippingAddress = JSON.parse(order.shipping_address);
//           } catch (e) {
//             console.error("Failed to parse shipping_address JSON:", e);
//             shippingAddress = null;
//           }
//         } else {
//           shippingAddress = order.shipping_address;
//         }
//       }

//       const shippingCountry =
//         shippingAddress?.country || shippingAddress?.Country || null;

//       if (!shippingCountry || String(shippingCountry).toUpperCase() !== "CA") {
//         return res.status(400).json({
//           error: "Shippo integration only allowed for Canada orders",
//         });
//       }

//       if (order.payment_status !== "paid") {
//         return res.status(400).json({
//           error: "Shippo shipment can only be created for paid orders",
//         });
//       }

//       if (order.shippo_tracking_number && order.shippo_carrier) {
//         return res.status(400).json({
//           error: "Shippo shipment already exists for this order",
//         });
//       }

//       const toAddress = {
//         name:
//           `${order.first_name || ""} ${order.last_name || ""}`.trim() ||
//           shippingAddress?.name ||
//           "Customer",
//         email: order.email || shippingAddress?.email || undefined,
//         street1: shippingAddress?.address1 || shippingAddress?.line1,
//         street2: shippingAddress?.address2 || shippingAddress?.line2 || "",
//         city: shippingAddress?.city,
//         state: shippingAddress?.state || shippingAddress?.province,
//         zip: shippingAddress?.postal_code || shippingAddress?.zip,
//         country: shippingCountry,
//         phone: shippingAddress?.phone || undefined,
//       };

//       const fromAddress = {
//         name: process.env.SHIPPO_FROM_NAME || "Nordica Plastics",
//         street1: process.env.SHIPPO_FROM_STREET1 || "Default Street",
//         street2: process.env.SHIPPO_FROM_STREET2 || "",
//         city: process.env.SHIPPO_FROM_CITY || "Toronto",
//         state: process.env.SHIPPO_FROM_STATE || "ON",
//         zip: process.env.SHIPPO_FROM_ZIP || "M5V1E3",
//         country: process.env.SHIPPO_FROM_COUNTRY || "CA",
//         phone: process.env.SHIPPO_FROM_PHONE || undefined,
//         email: process.env.SHIPPO_FROM_EMAIL || undefined,
//       };

//       // Very simple parcel
//       const parcel = {
//         length: "10",
//         width: "10",
//         height: "5",
//         distance_unit: "cm",
//         weight: "0.5",
//         mass_unit: "kg",
//       };

//       const apiToken = process.env.SHIPPO_API_TOKEN;
//       if (!apiToken) {
//         return res
//           .status(500)
//           .json({ error: "SHIPPO_API_TOKEN is not configured" });
//       }

//       // 1) Create shipment via REST API
//       const shipmentResp = await fetch("https://api.goshippo.com/shipments/", {
//         method: "POST",
//         headers: {
//           "Content-Type": "application/json",
//           Authorization: `ShippoToken ${apiToken}`,
//         },
//         body: JSON.stringify({
//           address_from: fromAddress,
//           address_to: toAddress,
//           parcels: [parcel],
//           // carrier_accounts: [carrier], // must be carrier account IDs
//         }),
//       });

//       const shipment = await shipmentResp.json();

//       // if (!shipmentResp.ok) {
//       //   console.error("Shippo shipment error:", shipment);
//       //   return res.status(400).json({
//       //     error: "Shippo shipment creation failed",
//       //     details: shipment,
//       //   });
//       // }

//       // if (!shipment || !shipment.rates || !shipment.rates.length) {
//       //   return res.status(400).json({
//       //     error: "No rates returned from Shippo for this shipment",
//       //   });
//       // }


//       // After `const shipment = await shipmentResp.json();`

// if (!shipmentResp.ok) {
//   console.error("Shippo shipment error:", shipment);
//   return res.status(400).json({
//     error: "Shippo shipment creation failed",
//     details: shipment,
//   });
// }

// // Add this log:
// console.log("Shippo shipment response:", JSON.stringify(shipment, null, 2));

// if (!shipment || !shipment.rates || !shipment.rates.length) {
//   return res.status(400).json({
//     error: "No rates returned from Shippo for this shipment",
//     details: shipment, // add this to see why in the UI too
//   });
// }

//       // Pick the cheapest rate
//       const rate = shipment.rates.reduce((best, r) => {
//         if (!best) return r;
//         const bestPrice = parseFloat(best.amount || "0");
//         const rPrice = parseFloat(r.amount || "0");
//         return rPrice < bestPrice ? r : best;
//       }, null);

//       if (!rate) {
//         return res.status(400).json({
//           error: "Failed to select rate for Shippo shipment",
//         });
//       }

//       // 2) Buy label via REST API
//       const txResp = await fetch("https://api.goshippo.com/transactions/", {
//         method: "POST",
//         headers: {
//           "Content-Type": "application/json",
//           Authorization: `ShippoToken ${apiToken}`,
//         },
//         body: JSON.stringify({
//           rate: rate.object_id,
//           label_file_type: "PDF",
//           async: false,
//         }),
//       });

//       const transaction = await txResp.json();

//       if (!txResp.ok || transaction.status !== "SUCCESS") {
//         console.error("Shippo transaction error:", transaction);
//         return res.status(400).json({
//           error: "Shippo transaction failed",
//           details: transaction,
//         });
//       }

//       const trackingNumber =
//         transaction.tracking_number || transaction.trackingNumber || null;
//       const trackingCarrier =
//         transaction.tracking_carrier ||
//         transaction.trackingCarrier ||
//         transaction.carrier ||
//         carrier;

//       await db.execute(
//         `
//         UPDATE orders
//         SET shippo_tracking_number = ?,
//             shippo_carrier = ?,
//             shippo_tracking_status = 'UNKNOWN',
//             shippo_tracking_raw = ?
//         WHERE id = ?
//         `,
//         [
//           trackingNumber,
//           trackingCarrier,
//           JSON.stringify(transaction),
//           orderId,
//         ]
//       );

//       res.json({
//         success: true,
//         tracking_number: trackingNumber,
//         carrier: trackingCarrier,
//         label_url: transaction.label_url || transaction.labelUrl || null,
//       });
//     } catch (error) {
//       console.error("Shippo create shipment error:", error);
//       res.status(500).json({
//         error: "Failed to create Shippo shipment",
//         details: error.message,
//       });
//     }
//   }
// );


//testing 2

router.post(
  "/orders/:id/shippo-create",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const orderId = req.params.id;
      const { carrier } = req.body || {};

      if (!carrier) {
        return res.status(400).json({ error: "carrier is required" });
      }

      // Load order with shipping address + user info
      const [rows] = await db.execute(
        `
        SELECT 
          o.*,
          u.first_name,
          u.last_name,
          u.email
        FROM orders o
        JOIN users u ON o.user_id = u.id
        WHERE o.id = ?
        `,
        [orderId]
      );

      if (!rows.length) {
        return res.status(404).json({ error: "Order not found" });
      }

      const order = rows[0];

      // Handle MySQL JSON column safely
      let shippingAddress = null;
      if (order.shipping_address) {
        if (typeof order.shipping_address === "string") {
          try {
            shippingAddress = JSON.parse(order.shipping_address);
          } catch (e) {
            console.error("Failed to parse shipping_address JSON:", e);
            shippingAddress = null;
          }
        } else {
          shippingAddress = order.shipping_address;
        }
      }

      const shippingCountry =
        shippingAddress?.country || shippingAddress?.Country || null;

      if (!shippingCountry || String(shippingCountry).toUpperCase() !== "CA") {
        return res.status(400).json({
          error: "Shippo integration only allowed for Canada orders",
        });
      }

      if (order.payment_status !== "paid") {
        return res.status(400).json({
          error: "Shippo shipment can only be created for paid orders",
        });
      }

      if (order.shippo_tracking_number && order.shippo_carrier) {
        return res.status(400).json({
          error: "Shippo shipment already exists for this order",
        });
      }

      // Normalize postal codes
      const toPostalRaw =
        shippingAddress?.postal_code || shippingAddress?.zip || "";
      const toPostal = toPostalRaw.replace(/\s+/g, "");

      const toAddress = {
        name:
          `${order.first_name || ""} ${order.last_name || ""}`.trim() ||
          shippingAddress?.name ||
          "Customer",
        email: order.email || shippingAddress?.email || undefined,
        street1: shippingAddress?.address1 || shippingAddress?.line1,
        street2: shippingAddress?.address2 || shippingAddress?.line2 || "",
        city: shippingAddress?.city,
        state: shippingAddress?.state || shippingAddress?.province,
        zip: toPostal,
        country: shippingCountry,
        phone: shippingAddress?.phone || undefined,
      };

      const fromPostalRaw = process.env.SHIPPO_FROM_ZIP || "M5V1E3";
      const fromPostal = fromPostalRaw.replace(/\s+/g, "");

      const fromAddress = {
        name: process.env.SHIPPO_FROM_NAME || "Nordica Plastics",
        street1: process.env.SHIPPO_FROM_STREET1 || "Default Street",
        street2: process.env.SHIPPO_FROM_STREET2 || "",
        city: process.env.SHIPPO_FROM_CITY || "Toronto",
        state: process.env.SHIPPO_FROM_STATE || "ON",
        zip: fromPostal,
        country: process.env.SHIPPO_FROM_COUNTRY || "CA",
        phone: process.env.SHIPPO_FROM_PHONE || undefined,
        email: process.env.SHIPPO_FROM_EMAIL || undefined,
      };

      // Simple parcel (REST JSON shape)
      const parcel = {
        length: "10",
        width: "10",
        height: "5",
        distance_unit: "cm",
        weight: "0.5",
        mass_unit: "kg",
      };

      const apiToken = process.env.SHIPPO_API_TOKEN;
      if (!apiToken) {
        return res
          .status(500)
          .json({ error: "SHIPPO_API_TOKEN is not configured" });
      }

      // 1) Create shipment via REST, forcing selected carrier account id
      const shipmentResp = await fetch("https://api.goshippo.com/shipments/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `ShippoToken ${apiToken}`,
        },
        body: JSON.stringify({
          address_from: fromAddress,
          address_to: toAddress,
          parcels: [parcel],
          carrier_accounts: [carrier], // this is the Canada Post account object_id
        }),
      });

      const shipment = await shipmentResp.json();

      if (!shipmentResp.ok) {
        console.error("Shippo shipment error:", shipment);
        return res.status(400).json({
          error: "Shippo shipment creation failed",
          details: shipment,
        });
      }

      console.log(
        "Shippo shipment response:",
        JSON.stringify(shipment, null, 2)
      );

      if (!shipment || !shipment.rates || !shipment.rates.length) {
        return res.status(400).json({
          error: "No rates returned from Shippo for this shipment",
          details: shipment,
        });
      }

      // Pick the cheapest rate
      const rate = shipment.rates.reduce((best, r) => {
        if (!best) return r;
        const bestPrice = parseFloat(best.amount || "0");
        const rPrice = parseFloat(r.amount || "0");
        return rPrice < bestPrice ? r : best;
      }, null);

      if (!rate) {
        return res.status(400).json({
          error: "Failed to select rate for Shippo shipment",
        });
      }

      // 2) Buy label via REST
      const txResp = await fetch("https://api.goshippo.com/transactions/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `ShippoToken ${apiToken}`,
        },
        body: JSON.stringify({
          rate: rate.object_id,
          label_file_type: "PDF",
          async: false,
        }),
      });

      const transaction = await txResp.json();

      if (!txResp.ok || transaction.status !== "SUCCESS") {
        console.error("Shippo transaction error:", transaction);
        return res.status(400).json({
          error: "Shippo transaction failed",
          details: transaction,
        });
      }

      const trackingNumber =
        transaction.tracking_number || transaction.trackingNumber || null;
      const trackingCarrier =
        transaction.tracking_carrier ||
        transaction.trackingCarrier ||
        transaction.carrier ||
        "canada_post";

      await db.execute(
        `
        UPDATE orders
        SET shippo_tracking_number = ?,
            shippo_carrier = ?,
            shippo_tracking_status = 'UNKNOWN',
            shippo_tracking_raw = ?
        WHERE id = ?
        `,
        [
          trackingNumber,
          trackingCarrier,
          JSON.stringify(transaction),
          orderId,
        ]
      );

      res.json({
        success: true,
        tracking_number: trackingNumber,
        carrier: trackingCarrier,
        label_url: transaction.label_url || transaction.labelUrl || null,
      });
    } catch (error) {
      console.error("Shippo create shipment error:", error);
      res.status(500).json({
        error: "Failed to create Shippo shipment",
        details: error.message,
      });
    }
  }
);


router.get(
  "/orders/:id",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const [orders] = await db.execute(
        `SELECT 
           o.*,
           COALESCE(u.first_name, o.shipping_first_name) as customer_first_name,
           COALESCE(u.last_name, o.shipping_last_name) as customer_last_name,
           COALESCE(u.email, o.customer_email) as customer_email,
           (SELECT JSON_ARRAYAGG(
              JSON_OBJECT(
                'id', oi.id, 
                'product_id', oi.product_id, 
                'quantity', oi.quantity, 
                'price_at_purchase', oi.price_at_purchase, 
                'product_name_at_purchase', oi.product_name_at_purchase, 
                'image_url_at_purchase', oi.image_url_at_purchase,
                'image', p.image
              )
            ) FROM order_items oi 
              LEFT JOIN products p ON oi.product_id = p.id
              WHERE oi.order_id = o.id
           ) as items
         FROM orders o 
         LEFT JOIN users u ON o.user_id = u.id 
         WHERE o.id = ?`,
        [id]
      );

      if (orders.length === 0) {
        return res.status(404).json({ error: "Order not found" });
      }

      const order = orders[0];
      if (order.shipping_address && typeof order.shipping_address === "string") {
        try { order.shipping_address = JSON.parse(order.shipping_address); } catch (e) { }
      }
      order.items = order.items || [];

      res.json(order);
    } catch (error) {
      console.error("Admin order detail error:", error);
      res.status(500).json({ error: "Failed to fetch order details" });
    }
  }
);

router.get(
  "/customers/:id/orders",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { page = 1, limit = 10 } = req.query;
      const pageNum = parseInt(page, 10) || 1;
      const limitNum = parseInt(limit, 10) || 10;
      const offset = (pageNum - 1) * limitNum;

      const [orders] = await db.execute(
        `SELECT 
           o.*,
           JSON_OBJECT(
             'first_name', u.first_name,
             'last_name', u.last_name,
             'email', u.email
           ) as user,
           JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.country')) AS shipping_country
         FROM orders o 
         JOIN users u ON o.user_id = u.id 
         WHERE o.user_id = ? 
         ORDER BY o.created_at DESC 
         LIMIT ? OFFSET ?`,
        [id, limitNum, offset]
      );

      const [count] = await db.execute(
        "SELECT COUNT(*) as total FROM orders WHERE user_id = ?",
        [id]
      );

      orders.forEach((order) => {
        if (order.shipping_address && typeof order.shipping_address === "string") {
          order.shipping_address = JSON.parse(order.shipping_address);
        }
        if (order.user && typeof order.user === "string") {
          order.user = JSON.parse(order.user);
        }
      });

      res.json({
        orders,
        pagination: { page: pageNum, total: count[0].total },
      });
    } catch (error) {
      console.error("Customer orders error:", error);
      res.status(500).json({ error: "Failed to fetch customer orders" });
    }
  }
);

router.get(
  "/reports/export/:type",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const { type } = req.params;
      const { country, range = "LAST_30", startDate, endDate } = req.query;

      let dateWhere = "1=1";
      const params = [];

      if (range === "TODAY") {
        dateWhere = "DATE(created_at) = CURDATE()";
      } else if (range === "LAST_7") {
        dateWhere = "created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)";
      } else if (range === "LAST_30") {
        dateWhere = "created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)";
      } else if (range === "CUSTOM" && startDate && endDate) {
        dateWhere = "DATE(created_at) BETWEEN ? AND ?";
        params.push(startDate, endDate);
      }

      let countryWhere = "1=1";
      if (country === "US" || country === "CA") {
        countryWhere =
          "shipping_address IS NOT NULL AND JSON_VALID(shipping_address) AND JSON_UNQUOTE(JSON_EXTRACT(shipping_address, '$.country')) = ?";
        params.push(country);
      }

      let data = [];

      if (type === "orders") {
        const [rows] = await db.execute(
          `SELECT id, created_at, total, status, payment_status, user_id 
           FROM orders 
           WHERE ${dateWhere} AND ${countryWhere}
           ORDER BY created_at DESC 
           LIMIT 1000`,
          params
        );
        data = rows;
      } else if (type === "customers") {
        const [rows] = await db.execute(
          `SELECT id, email, first_name, last_name, total_orders, total_spent 
           FROM (
             SELECT u.*, COUNT(o.id) as total_orders, COALESCE(SUM(o.total), 0) as total_spent 
             FROM users u 
             LEFT JOIN orders o ON u.id = o.user_id 
             WHERE u.role = 'customer' 
             GROUP BY u.id
           ) t`
        );
        data = rows;
      } else if (type === "analytics") {
        const [users] = await db.execute(
          'SELECT COUNT(*) as totalUsers FROM users WHERE role="customer"'
        );
        const [orders] = await db.execute(
          `SELECT COUNT(*) as totalOrders, 
                  SUM(CASE WHEN payment_status="paid" THEN total ELSE 0 END) as totalRevenue 
           FROM orders`
        );
        data = [
          {
            totalUsers: users[0].totalUsers,
            totalOrders: orders[0].totalOrders,
            totalRevenue: orders[0].totalRevenue,
          },
        ];
      } else {
        return res.status(400).json({ error: "Invalid type" });
      }

      const filename = `admin-${type}-report-${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx`;
      const xls = json2xls(data);
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.end(xls, "binary");
    } catch (error) {
      console.error("Export error:", error);
      res.status(500).json({ error: "Export failed" });
    }
  }
);




// ── Banners CMS ─────────────────────────────────────────────────────────────

// List Banners (Admin)
router.get("/banners", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, parseInt(limit, 10));
    const offset = (pageNum - 1) * limitNum;

    const [banners] = await db.query(
      `SELECT * FROM banners ORDER BY sort_order ASC, created_at DESC LIMIT ? OFFSET ?`,
      [limitNum, offset]
    );

    const [[{ total }]] = await db.query("SELECT COUNT(*) as total FROM banners");

    res.json({
      banners,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error("Get banners error:", error);
    res.status(500).json({ error: "Failed to fetch banners" });
  }
});

// Create Banner
router.post(
  "/banners",
  authenticateToken,
  requireAdmin,
  s3Upload.fields([{ name: 'file', maxCount: 1 }, { name: 'mobile_file', maxCount: 1 }]),
  async (req, res) => {
    try {
      const {
        title,
        description,
        subtitle,
        image_url,
        mobile_image_url,
        link_url,
        button_text,
        page_location,
        device_type,
        is_active = 1,
        sort_order = 0,
      } = req.body;
 
      const files = req.files || {};
      const desktopFile = files['file'] ? files['file'][0] : null;
      const mobileFile = files['mobile_file'] ? files['mobile_file'][0] : null;
 
      const finalDesktopUrl = desktopFile ? desktopFile.location : image_url;
      const finalMobileUrl = mobileFile ? mobileFile.location : mobile_image_url;
 
      if (!finalDesktopUrl) {
        return res.status(400).json({ error: "Desktop image file or image_url required" });
      }

      const id = uuidv4();
      await db.execute(
        `INSERT INTO banners (id, title, description, subtitle, image_url, mobile_image_url, link_url, button_text, page_location, device_type, is_active, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          title || null,
          description || null,
          subtitle || null,
          finalDesktopUrl,
          finalMobileUrl || null,
          link_url || null,
          button_text || null,
          page_location || 'home_hero',
          device_type || 'all',
          parseInt(is_active) === 0 ? 0 : 1,
          parseInt(sort_order) || 0,
        ]
      );

      res.status(201).json({ success: true, message: "Banner created", id });
    } catch (error) {
      console.error("Create banner error:", error);
      res.status(500).json({ error: "Failed to create banner" });
    }
  }
);

// Update Banner
router.put(
  "/banners/:id",
  authenticateToken,
  requireAdmin,
  s3Upload.fields([{ name: 'file', maxCount: 1 }, { name: 'mobile_file', maxCount: 1 }]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const {
        title,
        description,
        subtitle,
        image_url,
        mobile_image_url,
        link_url,
        button_text,
        page_location,
        device_type,
        is_active,
        sort_order,
      } = req.body;
 
      const files = req.files || {};
      const desktopFile = files['file'] ? files['file'][0] : null;
      const mobileFile = files['mobile_file'] ? files['mobile_file'][0] : null;

      const updates = [];
      const values = [];

      if (title !== undefined) { updates.push("title = ?"); values.push(title || null); }
      if (description !== undefined) { updates.push("description = ?"); values.push(description || null); }
      if (subtitle !== undefined) { updates.push("subtitle = ?"); values.push(subtitle || null); }
      
      if (desktopFile) { updates.push("image_url = ?"); values.push(desktopFile.location); }
      else if (image_url !== undefined) { updates.push("image_url = ?"); values.push(image_url); }
      
      if (mobileFile) { updates.push("mobile_image_url = ?"); values.push(mobileFile.location); }
      else if (mobile_image_url !== undefined) { updates.push("mobile_image_url = ?"); values.push(mobile_image_url); }
 
      if (link_url !== undefined) { updates.push("link_url = ?"); values.push(link_url || null); }
      if (button_text !== undefined) { updates.push("button_text = ?"); values.push(button_text || null); }
      if (page_location !== undefined) { updates.push("page_location = ?"); values.push(page_location); }
      if (device_type !== undefined) { updates.push("device_type = ?"); values.push(device_type); }
      if (is_active !== undefined) { updates.push("is_active = ?"); values.push(parseInt(is_active) === 0 ? 0 : 1); }
      if (sort_order !== undefined) { updates.push("sort_order = ?"); values.push(parseInt(sort_order) || 0); }

      if (updates.length === 0) {
        return res.status(400).json({ error: "No fields to update" });
      }

      values.push(id);
      const [result] = await db.execute(
        `UPDATE banners SET ${updates.join(", ")}, updated_at = NOW() WHERE id = ?`,
        values
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: "Banner not found" });
      }

      res.json({ success: true, message: "Banner updated" });
    } catch (error) {
      console.error("Update banner error:", error);
      res.status(500).json({ error: "Failed to update banner" });
    }
  }
);

// Delete Banner
router.delete("/banners/:id", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await db.execute("DELETE FROM banners WHERE id = ?", [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Banner not found" });
    }

    res.json({ success: true, message: "Banner deleted" });
  } catch (error) {
    console.error("Delete banner error:", error);
    res.status(500).json({ error: "Failed to delete banner" });
  }
});

// ── Dummy Order & Invoice ────────────────────────────────────────────────────

router.post('/create-dummy-order', authenticateToken, requireAdmin, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const orderId = uuidv4();
    const orderNumber = `ORD-DUMMY-${Date.now().toString().slice(-6)}`;

    // Get a random customer
    const [users] = await connection.query("SELECT id, email, first_name, last_name FROM users WHERE role = 'customer' LIMIT 1");
    if (!users.length) throw new Error("No customers found to attach order to.");
    const user = users[users.length - 1];

    // Create Order
    await connection.query(
      `INSERT INTO orders (id, order_number, user_id, customer_email, shipping_first_name, shipping_last_name, shipping_address, subtotal, tax, shipping_cost, total, status, payment_status, country)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId, orderNumber, user.id, user.email, user.first_name, user.last_name,
        JSON.stringify({ address1: '123 Dummy St', city: 'Toronto', country: 'CA' }),
        100.00, 13.00, 15.00, 128.00, 'pending', 'paid', 'CA'
      ]
    );

    // Create Invoice (Dummy number)
    const invoiceId = uuidv4();
    const invoiceNumber = `INV-${Date.now().toString().slice(-8)}`;
    await connection.query(
      `INSERT INTO invoices (id, order_id, invoice_number, total_amount, tax_amount, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [invoiceId, orderId, invoiceNumber, 128.00, 13.00, 'paid']
    );

    await connection.commit();
    res.json({ success: true, orderId, orderNumber, invoiceNumber });
  } catch (err) {
    await connection.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    connection.release();
  }
});

// DEBUG: Market Categorization (Run once to setup regional split)
router.post("/debug/recalibrate-regions", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [all] = await db.query("SELECT id FROM products WHERE is_active = 1 LIMIT 21");
    if (all.length === 0) return res.json({ message: "No products found" });

    // Assign top 6 to US
    for (let i = 0; i < Math.min(6, all.length); i++) {
      await db.query("UPDATE products SET target_country = 'us' WHERE id = ?", [all[i].id]);
    }
    // Assign next 15 to Canada
    for (let i = 6; i < Math.min(21, all.length); i++) {
      await db.query("UPDATE products SET target_country = 'canada' WHERE id = ?", [all[i].id]);
    }
    res.json({ success: true, message: `Market split complete: ${all.length} products categorized.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
