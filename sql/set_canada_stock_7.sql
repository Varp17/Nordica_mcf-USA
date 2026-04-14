-- ============================================================
-- SET ALL CANADA PRODUCT VARIANT STOCKS TO 7
-- and force all Canada products to show as IN STOCK
-- ============================================================
-- Run against: ecom_nordica DB (MySQL 8.0+)
-- ============================================================

SET NAMES utf8mb4;
SET SQL_SAFE_UPDATES = 0;
SET FOREIGN_KEY_CHECKS = 0;

-- ─────────────────────────────────────────────────────────────
-- STEP 1: Seed missing product_color_variants rows for Canada
--         products that only have color_options JSON (no DB rows)
--         Uses INSERT IGNORE so it's safe to re-run
-- ─────────────────────────────────────────────────────────────

-- cad-dirt-lock-insert (5 color variants)
INSERT IGNORE INTO product_color_variants
  (id, product_id, variant_name, color_name, amazon_sku, price, stock, sort_order, is_active)
SELECT UUID(), p.id, c.vname, c.cname, c.sku, 32.99, 7, c.sorder, 1
FROM products p,
(SELECT 'Blue'   vname,'Blue'   cname,'CAD-C21-V-BLUE'   sku,1 sorder UNION ALL
 SELECT 'Black',       'Black',       'CAD-C21-V-BLACK',      2       UNION ALL
 SELECT 'Red',         'Red',         'CAD-C21-V-RED',        3       UNION ALL
 SELECT 'White',       'White',       'CAD-C21-V-WHITE',      4       UNION ALL
 SELECT 'Yellow',      'Yellow',      'CAD-C21-V-YELLOW',     5) c
WHERE p.slug = 'cad-dirt-lock-insert'
  AND NOT EXISTS (SELECT 1 FROM product_color_variants v WHERE v.product_id = p.id LIMIT 1);

-- cad-pad-washer-kit (2 color variants)
INSERT IGNORE INTO product_color_variants
  (id, product_id, variant_name, color_name, amazon_sku, price, stock, sort_order, is_active)
SELECT UUID(), p.id, c.vname, c.cname, c.sku, 79.99, 7, c.sorder, 1
FROM products p,
(SELECT 'White' vname,'White' cname,'CAD-2CF16-V-WHITE' sku,1 sorder UNION ALL
 SELECT 'Black',      'Black',      'CAD-2CF16-V-BLACK',    2) c
WHERE p.slug = 'cad-pad-washer-kit'
  AND NOT EXISTS (SELECT 1 FROM product_color_variants v WHERE v.product_id = p.id LIMIT 1);

-- cad-pad-washer-kit-with-cleaner (2 color variants)
INSERT IGNORE INTO product_color_variants
  (id, product_id, variant_name, color_name, amazon_sku, price, stock, sort_order, is_active)
SELECT UUID(), p.id, c.vname, c.cname, c.sku, 89.99, 7, c.sorder, 1
FROM products p,
(SELECT 'White' vname,'White' cname,'CAD-760C-V-WHITE' sku,1 sorder UNION ALL
 SELECT 'Black',      'Black',      'CAD-760C-V-BLACK',   2) c
WHERE p.slug = 'cad-pad-washer-kit-with-cleaner'
  AND NOT EXISTS (SELECT 1 FROM product_color_variants v WHERE v.product_id = p.id LIMIT 1);

-- cad-scrub-wall-kit (2 color variants)
INSERT IGNORE INTO product_color_variants
  (id, product_id, variant_name, color_name, amazon_sku, price, stock, sort_order, is_active)
SELECT UUID(), p.id, c.vname, c.cname, c.sku, 59.99, 7, c.sorder, 1
FROM products p,
(SELECT 'Black' vname,'Black' cname,'CAD-SW-KIT-BLACK' sku,1 sorder UNION ALL
 SELECT 'White',      'White',      'CAD-SW-KIT-WHITE',   2) c
WHERE p.slug = 'cad-scrub-wall-kit'
  AND NOT EXISTS (SELECT 1 FROM product_color_variants v WHERE v.product_id = p.id LIMIT 1);

-- ─────────────────────────────────────────────────────────────
-- STEP 2: Set ALL Canada variant stocks to 7, mark active
-- ─────────────────────────────────────────────────────────────
UPDATE product_color_variants pcv
JOIN products p ON pcv.product_id = p.id
SET   pcv.stock     = 7,
      pcv.is_active = 1,
      pcv.updated_at = NOW()
WHERE (p.target_country = 'canada' OR p.target_country = 'both')
  AND p.is_active = 1;

-- ─────────────────────────────────────────────────────────────
-- STEP 3: Re-aggregate & force IN STOCK on ALL Canada products
--         (covers products WITH variant rows)
-- ─────────────────────────────────────────────────────────────
UPDATE products p
SET
  p.in_stock        = 1,
  p.inventory_cache = COALESCE(
                        (SELECT SUM(v.stock)
                         FROM product_color_variants v
                         WHERE v.product_id = p.id AND v.is_active = 1),
                        7
                      ),
  p.availability    = 'In Stock',
  p.updated_at      = NOW()
WHERE (p.target_country = 'canada' OR p.target_country = 'both')
  AND p.is_active = 1;

-- ─────────────────────────────────────────────────────────────
-- STEP 4: Rebuild color_options JSON from variant table
--         (storefront fallback uses this directly)
-- ─────────────────────────────────────────────────────────────
UPDATE products p
SET color_options = (
  SELECT JSON_ARRAYAGG(
    JSON_OBJECT(
      'id',        v.id,
      'name',      COALESCE(v.variant_name, v.color_name),
      'value',     LOWER(COALESCE(v.variant_name, v.color_name)),
      'color',     COALESCE(v.color_code, '#888888'),
      'stock',     v.stock,
      'amazon_sku', v.amazon_sku,
      'sku',       v.amazon_sku,
      'price',     v.price,
      'in_stock',  1,
      'image',     COALESCE(
                     (SELECT pi.image_url FROM product_images pi
                      WHERE pi.color_variant_id = v.id AND pi.is_primary = 1 LIMIT 1),
                     p.image
                   )
    )
  )
  FROM product_color_variants v
  WHERE v.product_id = p.id AND v.is_active = 1
)
WHERE (p.target_country = 'canada' OR p.target_country = 'both')
  AND p.is_active = 1
  AND EXISTS (
    SELECT 1 FROM product_color_variants v
    WHERE v.product_id = p.id AND v.is_active = 1
  );

-- ─────────────────────────────────────────────────────────────
-- STEP 5: Products WITHOUT any variant rows (no color options)
--         Just force in_stock = 1 and availability directly
-- ─────────────────────────────────────────────────────────────
UPDATE products p
SET   p.in_stock        = 1,
      p.inventory_cache = 7,
      p.availability    = 'In Stock',
      p.updated_at      = NOW()
WHERE (p.target_country = 'canada' OR p.target_country = 'both')
  AND p.is_active = 1
  AND NOT EXISTS (
    SELECT 1 FROM product_color_variants v
    WHERE v.product_id = p.id AND v.is_active = 1
  );

SET SQL_SAFE_UPDATES = 1;
SET FOREIGN_KEY_CHECKS = 1;

-- ─────────────────────────────────────────────────────────────
-- VERIFY — run these SELECTs to confirm results
-- ─────────────────────────────────────────────────────────────
SELECT
  p.slug,
  p.name,
  p.in_stock,
  p.inventory_cache,
  p.availability,
  COUNT(v.id)  AS variant_rows,
  SUM(v.stock) AS total_variant_stock
FROM products p
LEFT JOIN product_color_variants v ON v.product_id = p.id AND v.is_active = 1
WHERE (p.target_country = 'canada' OR p.target_country = 'both')
  AND p.is_active = 1
GROUP BY p.id
ORDER BY p.availability, p.name;
