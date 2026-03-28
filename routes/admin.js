import express from "express";
import db from "../config/database.js";
import { authenticateToken, requireAdmin } from "../middleware/auth.js";
import { v4 as uuidv4 } from "uuid";
import json2xls from "json2xls";
import path from "path";
import { upload as s3Upload } from "../services/s3Service.js";
import { shippoClient } from "./shippo.js";
import fetch from "node-fetch";


const router = express.Router();

router.use(json2xls.middleware);


router.get("/analytics", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { country, range = "LAST_30", startDate, endDate, _cb } = req.query;

    console.log(
      `📊 Analytics request: ${country || "ALL"}/${range}${
        _cb ? " (FORCE FRESH)" : ""
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

    res.json({
      stats,
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
          tags: safeParse(p.tags)
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

// Create product - FIXED COUNTRY VALIDATION
router.post(
  "/products",
  authenticateToken,
  requireAdmin,
  s3Upload.any(), // Accept any field names
  async (req, res) => {
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      // Process S3 Files
      const filesByField = {};
      if (req.files) {
        req.files.forEach(f => {
          if (!filesByField[f.fieldname]) filesByField[f.fieldname] = [];
          filesByField[f.fieldname].push(f.location);
        });
      }

      const { category, brand } = req.body;
      
      // Get or create category/brand ... (logic remains)
      let categoryId;
      if (category) {
        const [existingCategories] = await connection.execute("SELECT id FROM categories WHERE LOWER(name) = LOWER(?)", [category]);
        if (existingCategories.length > 0) categoryId = existingCategories[0].id;
        else {
          const newCategoryId = uuidv4();
          await connection.execute("INSERT INTO categories (id, name, is_active, created_at) VALUES (?, ?, 1, NOW())", [newCategoryId, category]);
          categoryId = newCategoryId;
        }
      }

      let brandId;
      if (brand) {
        const [existingBrands] = await connection.execute("SELECT id FROM brands WHERE LOWER(name) = LOWER(?)", [brand]);
        if (existingBrands.length > 0) brandId = existingBrands[0].id;
        else {
          const newBrandId = uuidv4();
          await connection.execute("INSERT INTO brands (id, name, is_active, created_at) VALUES (?, ?, 1, NOW())", [newBrandId, brand]);
          brandId = newBrandId;
        }
      }

      const {
        name, price, description, shortDescription, fullDescription, youtubeUrl,
        features, specifications, tags, colorVariants, sku, weight, dimensions,
        material, warranty, returnPolicy, in_stock, target_country, images,
        ...rest
      } = req.body;

      const stock = parseInt(in_stock) || 0;
      const availability = stock > 0 ? "In Stock" : "Out of Stock";
      const validCountries = ['us', 'canada', 'both'];
      let targetCountry = (target_country && validCountries.includes(target_country.toLowerCase())) ? target_country.toLowerCase() : 'both';

      const heroImage = filesByField.heroImage?.[0] || filesByField.image?.[0] || req.body.image_url || req.body.image || null;
      let gallery = [];
      try { gallery = typeof images === 'string' ? JSON.parse(images) : (images || []); } catch(e) {}
      if (filesByField.gallery) gallery = [...gallery, ...filesByField.gallery];

      const productId = uuidv4();
      await connection.execute(
        `INSERT INTO products (
          id, name, name_ar, price, original_price, discount,
          short_description, description, description_ar, full_description,
          image, images, youtube_url,
          rating, reviews, brand, category, category_id, brand_id,
          availability, sku, in_stock,
          weight, dimensions, material, warranty, return_policy,
          key_features, specifications, tags,
          target_country,
          is_active, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          productId, name, rest.name_ar || null, parseFloat(price),
          rest.original_price ? parseFloat(rest.original_price) : null,
          rest.discount ? parseFloat(rest.discount) : null,
          shortDescription || null, description || fullDescription || "",
          rest.description_ar || null, fullDescription || null,
          heroImage, JSON.stringify(gallery), youtubeUrl || null,
          rest.rating || 0, rest.reviews || 0, brand, category, categoryId, brandId,
          availability, sku || null, stock, 
          weight || null, dimensions || null, material || null, warranty || null, returnPolicy || null,
          features || "[]", specifications || "[]", tags || "[]",
          targetCountry, 1,
        ]
      );

      // Color Variants & Images
      const colorVariantsArray = typeof colorVariants === 'string' ? JSON.parse(colorVariants) : (colorVariants || []);
      for (let i = 0; i < colorVariantsArray.length; i++) {
          const variant = colorVariantsArray[i];
          const variantId = uuidv4();
          await connection.execute(
              "INSERT INTO product_color_variants (id, product_id, color_name, color_code, stock, created_at) VALUES (?,?,?,?,?,NOW())",
              [variantId, productId, variant.color, variant.colorCode, variant.stock || 0]
          );
          const vFiles = filesByField[`colorVariantImages_${i}`] || [];
          for (let j = 0; j < vFiles.length; j++) {
              await connection.execute(
                  "INSERT INTO product_images (id, product_id, image_url, image_type, color_variant_id, display_order, created_at) VALUES (?,?,?,?,?,?,NOW())",
                  [uuidv4(), productId, vFiles[j], 'color_variant', variantId, j+1]
              );
          }
      }

      await connection.commit();
      res.status(201).json({ success: true, productId, target_country: targetCountry });
    } catch (error) {
      await connection.rollback();
      console.error("❌ Create product error:", error);
      res.status(500).json({ 
        error: "Failed to create product", 
        details: error.message 
      });
    } finally {
      connection.release();
    }
  }
);

// Update product - FIXED COUNTRY VALIDATION
router.put(
  "/products/:id",
  authenticateToken,
  requireAdmin,
  s3Upload.any(),
  async (req, res) => {
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();
      const { id } = req.params;

      // Process S3 Files
      const filesByField = {};
      if (req.files) {
        req.files.forEach(f => {
          if (!filesByField[f.fieldname]) filesByField[f.fieldname] = [];
          filesByField[f.fieldname].push(f.location);
        });
      }

      const {
        name, price, category, brand, description, image_url, image,
        shortDescription, fullDescription, youtubeUrl,
        features, specifications, tags, colorVariants, images,
        sku, weight, dimensions, material, warranty, returnPolicy,
        in_stock, target_country, ...rest
      } = req.body;

      const updates = {};
      if (name) updates.name = name;
      if (price) updates.price = parseFloat(price);
      if (description !== undefined) updates.description = description;
      if (shortDescription !== undefined) updates.short_description = shortDescription;
      if (fullDescription !== undefined) updates.full_description = fullDescription;
      if (youtubeUrl !== undefined) updates.youtube_url = youtubeUrl;
      if (sku !== undefined) updates.sku = sku;
      if (weight !== undefined) updates.weight = weight;
      if (dimensions !== undefined) updates.dimensions = dimensions;
      if (material !== undefined) updates.material = material;
      if (warranty !== undefined) updates.warranty = warranty;
      if (returnPolicy !== undefined) updates.return_policy = returnPolicy;

      if (features) updates.key_features = typeof features === 'string' ? features : JSON.stringify(features);
      if (specifications) updates.specifications = typeof specifications === 'string' ? specifications : JSON.stringify(specifications);
      if (tags) updates.tags = typeof tags === 'string' ? tags : JSON.stringify(tags);

      // image update
      if (filesByField.heroImage || filesByField.image) {
          updates.image = filesByField.heroImage?.[0] || filesByField.image?.[0];
      } else if (image_url || image) {
          updates.image = image_url || image;
      }

      let gallery = [];
      try { gallery = typeof images === 'string' ? JSON.parse(images) : (images || []); } catch(e) {}
      if (filesByField.gallery) gallery = [...gallery, ...filesByField.gallery];
      updates.images = JSON.stringify(gallery);

      if (target_country !== undefined) {
        const validCountries = ['us', 'canada', 'both'];
        updates.target_country = (target_country && validCountries.includes(target_country.toLowerCase())) ? target_country.toLowerCase() : 'both';
      }

      if (category) {
        const [cats] = await connection.execute("SELECT id FROM categories WHERE LOWER(name) = LOWER(?)", [category]);
        if (cats.length > 0) updates.category_id = cats[0].id;
        else {
          const nid = uuidv4();
          await connection.execute("INSERT INTO categories (id, name, is_active, created_at) VALUES (?, ?, 1, NOW())", [nid, category]);
          updates.category_id = nid;
        }
        updates.category = category;
      }

      if (brand) {
        const [brs] = await connection.execute("SELECT id FROM brands WHERE LOWER(name) = LOWER(?)", [brand]);
        if (brs.length > 0) updates.brand_id = brs[0].id;
        else {
          const nid = uuidv4();
          await connection.execute("INSERT INTO brands (id, name, is_active, created_at) VALUES (?, ?, 1, NOW())", [nid, brand]);
          updates.brand_id = nid;
        }
        updates.brand = brand;
      }

      if (in_stock !== undefined) {
        updates.in_stock = parseInt(in_stock);
        updates.availability = parseInt(in_stock) > 0 ? "In Stock" : "Out of Stock";
      }

      if (Object.keys(updates).length > 0) {
        const fields = Object.keys(updates).map(k => `${k} = ?`).join(", ");
        await connection.execute(`UPDATE products SET ${fields}, updated_at = NOW() WHERE id = ?`, [...Object.values(updates), id]);
      }

      if (colorVariants) {
        await connection.execute("DELETE FROM product_color_variants WHERE product_id = ?", [id]);
        await connection.execute("DELETE FROM product_images WHERE product_id = ? AND image_type = 'color_variant'", [id]);
        const cvArray = typeof colorVariants === 'string' ? JSON.parse(colorVariants) : (colorVariants || []);
        for (let i = 0; i < cvArray.length; i++) {
          const v = cvArray[i];
          const vId = uuidv4();
          await connection.execute(
            "INSERT INTO product_color_variants (id, product_id, color_name, color_code, stock, created_at) VALUES (?,?,?,?,?,NOW())",
            [vId, id, v.color, v.colorCode, v.stock || 0]
          );
          const vFiles = filesByField[`colorVariantImages_${i}`] || [];
          for (let j = 0; j < vFiles.length; j++) {
            await connection.execute(
              "INSERT INTO product_images (id, product_id, image_url, image_type, color_variant_id, display_order, created_at) VALUES (?,?,?,?,?,?,NOW())",
              [uuidv4(), id, vFiles[j], 'color_variant', vId, j+1]
            );
          }
        }
      }

      await connection.commit();
      res.json({ success: true, message: "Product updated successfully" });
    } catch (error) {
      await connection.rollback();
      console.error("❌ Update product error:", error);
      res.status(500).json({ error: "Failed to update product", details: error.message });
    } finally {
      connection.release();
    }
  }
);

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
        u.first_name,
        u.last_name
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
          `SELECT id, created_at, total_amount, status, payment_status, user_id 
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
             SELECT u.*, COUNT(o.id) as total_orders, COALESCE(SUM(o.total_amount), 0) as total_spent 
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
                  SUM(CASE WHEN payment_status="paid" THEN total_amount ELSE 0 END) as totalRevenue 
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
  s3Upload.single("file"),
  async (req, res) => {
    try {
      const {
        title,
        description,
        subtitle,
        image_url,
        link_url,
        button_text,
        page_location,
        device_type,
        is_active = 1,
        sort_order = 0,
      } = req.body;

      const file = req.file;
      const uploadedPath = file ? file.location : null;
      const finalImageUrl = uploadedPath || image_url;

      if (!finalImageUrl) {
        return res.status(400).json({ error: "Image file or image_url required" });
      }

      const id = uuidv4();
      await db.execute(
        `INSERT INTO banners (id, title, description, subtitle, image_url, link_url, button_text, page_location, device_type, is_active, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          title || null,
          description || null,
          subtitle || null,
          finalImageUrl,
          link_url || null,
          button_text || null,
          page_location || 'home',
          device_type || 'both',
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
  s3Upload.single("file"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const {
        title,
        description,
        subtitle,
        image_url,
        link_url,
        button_text,
        page_location,
        device_type,
        is_active,
        sort_order,
      } = req.body;

      const file = req.file;
      const uploadedPath = file ? file.location : null;

      const updates = [];
      const values = [];

      if (title !== undefined) { updates.push("title = ?"); values.push(title || null); }
      if (description !== undefined) { updates.push("description = ?"); values.push(description || null); }
      if (subtitle !== undefined) { updates.push("subtitle = ?"); values.push(subtitle || null); }
      if (uploadedPath) { updates.push("image_url = ?"); values.push(uploadedPath); }
      else if (image_url !== undefined) { updates.push("image_url = ?"); values.push(image_url); }
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
