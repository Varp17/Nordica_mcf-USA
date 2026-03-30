import 'dotenv/config';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';

async function seedAdmin() {
  const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_NAME || 'nordica_ecomsun'
  };

  const email = process.env.ADMIN_EMAIL || 'admin@detailguardz.com';
  const password = process.env.ADMIN_SEED_PASSWORD || 'Admin@Secure123!';

  console.log(`🚀 Seeding admin into database: ${dbConfig.database}...`);
  
  const conn = await mysql.createConnection(dbConfig);

  try {
    const saltRounds = 12;
    const hash = await bcrypt.hash(password, saltRounds);

    // Check if user exists
    const [rows] = await conn.execute('SELECT id FROM users WHERE email = ?', [email]);

    if (rows.length > 0) {
      console.log('🔄 User already exists. Updating password...');
      await conn.execute(
        'UPDATE users SET password_hash = ?, role = "superadmin", is_active = 1 WHERE email = ?',
        [hash, email]
      );
    } else {
      console.log('✨ Creating new admin user...');
      await conn.execute(
        'INSERT INTO users (id, email, password_hash, first_name, last_name, role, is_active) VALUES (UUID(), ?, ?, "Admin", "User", "superadmin", 1)',
        [email, hash]
      );
    }

    console.log('✅ Admin credentials updated/created successfully.');
    console.log(`📧 Email: ${email}`);
    console.log(`🔑 Password: ${password}`);
  } catch (err) {
    console.error('❌ SEED ERROR:', err.message);
  } finally {
    await conn.end();
  }
}

seedAdmin();
