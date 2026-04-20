import db from '../config/database.js';

async function connectImages() {
  try {
    console.log('Connecting images for all Canada products...');
    const [products] = await db.query("SELECT id, slug, images, variant_images FROM products WHERE country = 'CAD' OR slug LIKE 'cad-%'");
    console.log(`Found ${products.length} Canada products.`);

    for (const p of products) {
      console.log(`Processing ${p.slug}...`);
      
      // 1. Primary images
      const images = typeof p.images === 'string' ? JSON.parse(p.images) : (p.images || []);
      for (let i = 0; i < images.length; i++) {
        const url = images[i];
        await db.query(`
          INSERT INTO product_images (id, product_id, image_url, sort_order, is_primary)
          VALUES (UUID(), ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE image_url = VALUES(image_url)
        `, [p.id, url, i, i === 0]);
      }

      // 2. Variant images
      const vImages = typeof p.variant_images === 'string' ? JSON.parse(p.variant_images) : (p.variant_images || {});
      for (const [color, urls] of Object.entries(vImages)) {
        const urlArray = Array.isArray(urls) ? urls : [urls];
        for (let i = 0; i < urlArray.length; i++) {
          const url = urlArray[i];
          await db.query(`
            INSERT INTO product_images (id, product_id, image_url, sort_order, is_primary)
            VALUES (UUID(), ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE image_url = VALUES(image_url)
          `, [p.id, url, i + 100, i === 0]);
        }
      }
    }
    console.log('All Canada products connected successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

connectImages();
