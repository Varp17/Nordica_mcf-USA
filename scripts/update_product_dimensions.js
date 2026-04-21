import mysql from 'mysql2/promise';
import 'dotenv/config';

const productData = [
  {
    name: 'Cup',
    matchNames: ['DETAIL GUARDZ - PREMIUM COFFEE MUG 11OZ'],
    net_g: 410,
    gross_g: 410,
    length_in: 4.4,
    width_in: 4,
    height_in: 5.4
  },
  {
    name: 'Pop Color Mitt',
    matchNames: ['ULTRA SOFT COLOR-POP WASH MITT'],
    net_g: 76.5,
    gross_g: 76.5,
    length_in: 11,
    width_in: 9.2,
    height_in: 0.8 // Assuming a default small height for flat items
  },
  {
    name: 'Double Twist Mitt',
    matchNames: ['DOUBLE TWIST WASH MITT'],
    net_g: 96,
    gross_g: 96,
    length_in: 11,
    width_in: 9.2,
    height_in: 0.8
  },
  {
    name: 'T-Shirt',
    matchNames: ['PREMIUM T-SHIRT WHITE'],
    net_g: 247.5,
    gross_g: 247.5,
    length_in: 9.2,
    width_in: 3.5,
    height_in: 2
  },
  {
    name: 'DIRT LOCK',
    matchNames: ['DIRT LOCK - CAR WASH BUCKET INSERT', 'DETAIL GUARDZ Dirt Lock Car Wash Insert - Bucket Filter for 3-8 Gallon Round Pails - Traps Debris, Prevents Swirl Marks - Self-Locking Rubber Grips, Venturi Flow, Cleaning Tool'],
    net_g: 490,
    gross_g: 490,
    length_in: 10.70,
    width_in: 2.75,
    height_in: 10.70,
    variants: ['Black', 'Blue', 'Red', 'White', 'Gold']
  },
  {
    name: 'Dirt Lock-SW180',
    matchNames: ['DIRT LOCK - COMPLETE SCRUB WALL KIT', 'DETAIL GUARDZ Dirt Lock Scrub Wall 180/360 - Vertical Cleaning Tool for Brushes, Mitts'],
    net_g: 400,
    gross_g: 400,
    length_in: 8.5,
    width_in: 10,
    height_in: 2,
    variants: ['Black', 'White']
  },
  {
    name: 'Detail Guardz-4',
    matchNames: ['DETAIL GUARDZ - HOSE GUIDE (4PK)', 'DETAIL GUARDZ Hose Guide - Tire Wheel Rolling System Preventing Stucking and Snagging Under Tires'],
    net_g: 250,
    gross_g: 250,
    length_in: 6.75,
    width_in: 2.75,
    height_in: 4.5,
    variants: ['Black', 'Blue', 'Red', 'Yellow', 'Neon Green']
  },
  {
    name: 'DG-5GAL',
    matchNames: ['DETAIL GUARDZ 5 GALLON DETAILING BUCKET'],
    net_g: 750,
    gross_g: 750,
    length_in: 12,
    width_in: 12,
    height_in: 14.5
  },
  {
    name: 'Dirt Lock-SAP',
    matchNames: ['DIRT LOCK - COMPLETE SCRUB AND PUMP KIT', 'DETAIL GUARDZ The Dirt Lock Scrub and Pump Attachment for Car Wash Bucket Filter'],
    net_g: 250,
    gross_g: 250,
    length_in: 7.5,
    width_in: 7.5,
    height_in: 4,
    variants: ['Black', 'White']
  },
  {
    name: 'Dirt Lock-PWS',
    matchNames: ['DIRT LOCK - COMPLETE PAD WASHER KIT', 'The Detail Guardz - Dirt Lock Pad Washer System With Attachment', 'The Detail Guardz - Dirt Lock Pad Washer System Attachment (Black)'],
    net_g: 650,
    gross_g: 650,
    length_in: 7.75,
    width_in: 7.75,
    height_in: 14.5,
    variants: ['Black', 'White']
  },
  {
    name: 'PPSC-650ml',
    matchNames: ['DETAIL GUARDZ - POLISHING PAD SPRAY CLEANER 650ML'],
    net_g: 700,
    gross_g: 700,
    length_in: 2.25,
    width_in: 4.25,
    height_in: 10.25
  }
];

async function updateProductDimensions() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  console.log('Connected to database. Starting updates...');

  for (const data of productData) {
    const weight_kg = parseFloat((data.gross_g / 1000).toFixed(3));
    const weight_lb = parseFloat((weight_kg * 2.20462).toFixed(3));
    
    // Dimensions in CM
    const l_cm = parseFloat((data.length_in * 2.54).toFixed(1));
    const w_cm = parseFloat((data.width_in * 2.54).toFixed(1));
    const h_cm = parseFloat((data.height_in * 2.54).toFixed(1));
    const dimensions = `${l_cm}x${w_cm}x${h_cm}`;
    const dimensions_imperial = `${data.length_in}x${data.width_in}x${data.height_in}`;

    for (const matchName of data.matchNames) {
      console.log(`Processing: ${matchName}...`);
      
      // 1. Update the base product
      const [updateRes] = await db.execute(
        `UPDATE products SET 
          weight_kg = ?, 
          weight_lb = ?, 
          dimensions = ?, 
          dimensions_imperial = ? 
        WHERE name = ?`,
        [weight_kg, weight_lb, dimensions, dimensions_imperial, matchName]
      );

      if (updateRes.affectedRows > 0) {
        console.log(`  Updated base product: ${matchName}`);
      }

      // 2. Handle variants in color_options JSON
      const [products] = await db.execute(
        'SELECT id, color_options FROM products WHERE name = ?',
        [matchName]
      );

      for (const product of products) {
        if (product.color_options) {
          let colors = product.color_options;
          if (typeof colors === 'string') {
            try { colors = JSON.parse(colors); } catch (e) { colors = null; }
          }

          if (Array.isArray(colors)) {
            let changed = false;
            const updatedColors = colors.map(c => {
              // If we have specific variants, only update those. 
              // If no specific variants defined in data, update all colors for this product.
              const shouldUpdate = !data.variants || data.variants.some(v => 
                c.name.toLowerCase().includes(v.toLowerCase()) || 
                v.toLowerCase().includes(c.name.toLowerCase())
              );

              if (shouldUpdate) {
                changed = true;
                return {
                  ...c,
                  weight_kg,
                  weight_lb,
                  dimensions,
                  dimensions_imperial
                };
              }
              return c;
            });

            if (changed) {
              await db.execute(
                'UPDATE products SET color_options = ? WHERE id = ?',
                [JSON.stringify(updatedColors), product.id]
              );
              console.log(`  Updated variants in color_options for ${matchName}`);
            }
          }
        }
      }
      
      // 3. Update product_variants table if it exists and has records
      try {
        const [pvUpdate] = await db.execute(
          `UPDATE product_variants v
           JOIN products p ON v.product_id = p.id
           SET v.weight_kg = ?, v.weight_lb = ?, v.dimensions = ?, v.dimensions_imperial = ?
           WHERE p.name = ?`,
          [weight_kg, weight_lb, dimensions, dimensions_imperial, matchName]
        );
        if (pvUpdate.affectedRows > 0) {
          console.log(`  Updated product_variants table for ${matchName}`);
        }
      } catch (err) {
        // Table might not exist or schema might differ slightly, ignoring errors here as it's secondary
      }

      // 4. Update product_color_variants table
      try {
        const [pcvUpdate] = await db.execute(
          `UPDATE product_color_variants cv
           JOIN products p ON cv.product_id = p.id
           SET cv.weight_kg = ?, cv.weight_lb = ?, cv.dimensions = ?, cv.dimensions_imperial = ?
           WHERE p.name = ?`,
          [weight_kg, weight_lb, dimensions, dimensions_imperial, matchName]
        );
        if (pcvUpdate.affectedRows > 0) {
          console.log(`  Updated product_color_variants table for ${matchName}`);
        }
      } catch (err) {
        // Table might not exist or schema might differ slightly, ignoring errors here
      }
    }
  }

  console.log('All updates completed.');
  await db.end();
}

updateProductDimensions().catch(err => {
  console.error('Update failed:', err);
  process.exit(1);
});
