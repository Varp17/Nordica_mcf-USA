USE nordica_ecomli;

-- Scrub and Pump
UPDATE products SET color_options = JSON_SET(color_options, '$[0].amazon_sku', 'DIRT LOCK-SAP BLACK', '$[0].sku', 'DIRT LOCK-SAP BLACK', '$[1].amazon_sku', 'DIRT LOCK-SAP WHITE', '$[1].sku', 'DIRT LOCK-SAP WHITE') WHERE slug = 'dirt-lock-scrub-pump';

-- Scrub Wall
UPDATE products SET color_options = JSON_SET(color_options, '$[0].amazon_sku', 'DIRT LOCK-SW180 BLACK', '$[0].sku', 'DIRT LOCK-SW180 BLACK', '$[1].amazon_sku', 'DIRT LOCK-SW180 WHITE', '$[1].sku', 'DIRT LOCK-SW180 WHITE', '$[2].amazon_sku', 'DIRT LOCK-SW180 RED', '$[2].sku', 'DIRT LOCK-SW180 RED') WHERE slug = 'dirt-lock-scrub-wall';

-- Hose Guides 4pk
UPDATE products SET color_options = JSON_SET(color_options, '$[0].amazon_sku', 'Detail Guardz Hose Guides 2.0_NewBlack', '$[0].sku', 'Detail Guardz Hose Guides 2.0_NewBlack', '$[1].amazon_sku', 'Detail Guardz Hose Guides 2.0 -Blue', '$[1].sku', 'Detail Guardz Hose Guides 2.0 -Blue', '$[2].amazon_sku', 'Detail Guardz Hose Guides 2.0_Red', '$[2].sku', 'Detail Guardz Hose Guides 2.0_Red', '$[3].amazon_sku', 'Detail Guardz Hose Guides 2.0_Yellow', '$[3].sku', 'Detail Guardz Hose Guides 2.0_Yellow', '$[4].amazon_sku', 'Detail Guardz Hose Guides 2.0_Neon', '$[4].sku', 'Detail Guardz Hose Guides 2.0_Neon') WHERE slug = 'hose-roller-4-pack';

-- Dirt Lock Insert
UPDATE products SET color_options = JSON_SET(color_options, '$[0].amazon_sku', 'DLRP-BLACK-1-stickerless', '$[0].sku', 'DLRP-BLACK-1-stickerless', '$[1].amazon_sku', 'DLRP-BLUE-3-stickerless', '$[1].sku', 'DLRP-BLUE-3-stickerless', '$[2].amazon_sku', 'DLRP-RED-2-stickerless', '$[2].sku', 'DLRP-RED-2-stickerless', '$[3].amazon_sku', 'DLRP-W-stickerless', '$[3].sku', 'DLRP-W-stickerless', '$[4].amazon_sku', 'DLRP-G-stickerless', '$[4].sku', 'DLRP-G-stickerless') WHERE slug = 'dirt-lock-car-wash-insert';

-- Pad Washer
UPDATE products SET color_options = JSON_SET(color_options, '$[0].amazon_sku', 'DIRT LOCK-PWSBL', '$[0].sku', 'DIRT LOCK-PWSBL', '$[1].amazon_sku', 'DIRT LOCK-PWSW-1', '$[1].sku', 'DIRT LOCK-PWSW-1', '$[2].amazon_sku', 'DIRT LOCK-PWS-BLACK', '$[2].sku', 'DIRT LOCK-PWS-BLACK', '$[3].amazon_sku', 'DIRT LOCK-PWS-WHITE-1', '$[3].sku', 'DIRT LOCK-PWS-WHITE-1') WHERE slug = 'dirt-lock-pad-washer-attachment';
