import 'dotenv/config';
import db from '../config/database.js';
import { v4 as uuidv4 } from 'uuid';

async function run() {
  try {
    const banners = [
      { page: 'media_page', title: 'Media Center', desktop: '/assets/new_bg.webp', mobile: '/assets/new_bg_mobile.webp' },
      { page: 'where_to_buy', title: 'Find a Retailer', desktop: '/assets/new_bg.webp', mobile: '/assets/new_bg_mobile.webp' }
    ];
    
    for (const b of banners) {
      const [exists] = await db.query('SELECT id FROM banners WHERE page_location = ? AND position_type = "background"', [b.page]);
      if (exists.length === 0) {
        await db.query('INSERT INTO banners (id, title, page_location, position_type, image_url, mobile_image_url, device_type, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 
          [uuidv4(), b.title, b.page, 'background', b.desktop, b.mobile, 'all', 1]);
        console.log(`Seeded banner for ${b.page}`);
      } else {
        console.log(`Banner for ${b.page} already exists`);
      }
    }
  } catch (e) {
    console.error(e);
  } finally {
    process.exit();
  }
}
run();
