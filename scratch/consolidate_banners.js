import 'dotenv/config';
import db from '../config/database.js';

async function run() {
  try {
    // Get all mobile background banners
    const [mobileBanners] = await db.query('SELECT * FROM banners WHERE device_type = "mobile" AND position_type = "background"');
    
    for (const mb of mobileBanners) {
      // Find matching desktop banner by page_location
      const [desktopBanners] = await db.query('SELECT * FROM banners WHERE (device_type = "desktop" OR device_type = "all") AND page_location = ? AND position_type = "background"', [mb.page_location]);
      if (desktopBanners.length > 0) {
        const dbId = desktopBanners[0].id;
        // Update desktop banner with mobile image url
        await db.query('UPDATE banners SET mobile_image_url = ?, device_type = "all", title = ? WHERE id = ?', 
          [mb.image_url, mb.title.replace(' (Mobile)', '').replace(' (Desktop)', ''), dbId]);
        // Delete the separate mobile record
        await db.query('DELETE FROM banners WHERE id = ?', [mb.id]);
        console.log(`Merged mobile banner into desktop banner for ${mb.page_location}`);
      }
    }
    console.log('Banner consolidation complete');
  } catch (e) {
    console.error(e);
  } finally {
    process.exit();
  }
}
run();
