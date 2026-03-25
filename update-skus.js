import 'dotenv/config';
import db from './config/database.js';


async function updateSkus() {
  const updates = [
    {
      slug: 'dirt-lock-car-wash-insert',
      color_options: [
        { name: 'Black', value: 'black', amazon_sku: 'DLRP-BLACK-1-stickerless' },
        { name: 'Blue', value: 'blue', amazon_sku: 'DLRP-BLUE-3-stickerless' },
        { name: 'Red', value: 'red', amazon_sku: 'DLRP-RED-2-stickerless' },
        { name: 'White', value: 'white', amazon_sku: 'DLRP-W-stickerless' },
        { name: 'Yellow', value: 'yellow', amazon_sku: 'DLRP-G-stickerless' },
        { name: 'Gold', value: 'gold', amazon_sku: 'DLRP-G-stickerless' }
      ]
    },
    {
      slug: 'dirt-lock-scrub-wall',
      color_options: [
        { name: 'BLACK', value: 'black', amazon_sku: 'DIRT-LOCK-SW180-BLACK' },
        { name: 'WHITE', value: 'white', amazon_sku: 'DIRT-LOCK-SW180-WHITE' },
        { name: 'RED', value: 'red', amazon_sku: 'DIRT-LOCK-SW180-RED' }
      ]
    },
    {
      slug: 'dirt-lock-scrub-pump',
      color_options: [
        { name: 'BLACK', value: 'black', amazon_sku: 'DIRT-LOCK-SAP-BLACK' },
        { name: 'WHITE', value: 'white', amazon_sku: 'DIRT-LOCK-SAP-WHITE' }
      ]
    },
    {
      slug: 'hose-roller-4-pack',
      color_options: [
        { name: 'Black', value: 'black', amazon_sku: 'Detail-Guardz-Hose-Guides-2.0_NewBlack' },
        { name: 'Blue', value: 'blue', amazon_sku: 'Detail-Guardz-Hose-Guides-2.0-Blue' },
        { name: 'Red', value: 'red', amazon_sku: 'Detail-Guardz-Hose-Guides-2.0_Red' },
        { name: 'Yellow', value: 'yellow', amazon_sku: 'Detail-Guardz-Hose-Guides-2.0_Yellow' },
        { name: 'Neon', value: 'neon', amazon_sku: 'Detail-Guardz-Hose-Guides-2.0_Neon' }
      ]
    },
    {
      slug: 'dirt-lock-pad-washer-attachment',
      color_options: [
        { name: 'Black + 650ML Cleaner', value: 'black-cleaner', amazon_sku: 'DIRT-LOCK-PWSBL' },
        { name: 'White + 650ML Cleaner', value: 'white-cleaner', amazon_sku: 'DIRT-LOCK-PWSW-1' },
        { name: 'black', value: 'black', amazon_sku: 'DIRT-LOCK-PWS-BLACK' },
        { name: 'white', value: 'white', amazon_sku: 'DIRT-LOCK-PWS-WHITE-1' }
      ]
    }
  ];

  for (const update of updates) {
    console.log(`Updating ${update.slug}...`);
    const [rows] = await db.query('SELECT color_options FROM products WHERE slug = ?', [update.slug]);
    if (rows.length === 0) {
      console.warn(`Product ${update.slug} not found`);
      continue;
    }

    let existingOptions = rows[0].color_options;
    if (typeof existingOptions === 'string') existingOptions = JSON.parse(existingOptions);

    const newOptions = existingOptions.map(opt => {
      const u = update.color_options.find(uo => 
        uo.value === opt.value || 
        uo.name.toLowerCase() === opt.name.toLowerCase() ||
        (opt.name && uo.name && opt.name.toLowerCase().includes(uo.name.toLowerCase()))
      );
      if (u) {
        return { ...opt, amazon_sku: u.amazon_sku, sku: u.amazon_sku };
      }
      return opt;
    });

    await db.query('UPDATE products SET color_options = ? WHERE slug = ?', [JSON.stringify(newOptions), update.slug]);
    console.log(`Updated ${update.slug} successfully`);
  }

  process.exit(0);
}

updateSkus().catch(err => {
  console.error(err);
  process.exit(1);
});
