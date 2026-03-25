import db from '../config/database.js';
import bcrypt from 'bcryptjs';
import { generateUUID } from '../utils/helpers.js';

export async function findOrCreate(customerData) {
  const [existing] = await db.query(
    `SELECT * FROM users WHERE email = ? AND role = 'customer'`,
    [customerData.email.toLowerCase().trim()]
  );
  if (existing.length) return existing[0];
  const id = generateUUID();
  await db.query(
    `INSERT INTO users (id, email, first_name, last_name, phone, address1, address2, city, state, zip, country, role, created_at, updated_at) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'customer', NOW(), NOW())`,
    [id, customerData.email.toLowerCase().trim(), customerData.firstName || null, customerData.lastName || null, customerData.phone || null, customerData.address1 || null, customerData.address2 || null, customerData.city || null, customerData.state || null, customerData.zip || null, customerData.country || null]
  );
  const [rows] = await db.query(`SELECT * FROM users WHERE id = ?`, [id]);
  return rows[0];
}

export async function findById(customerId) {
  const [rows] = await db.query(`SELECT * FROM users WHERE id = ? AND role = 'customer'`, [customerId]);
  return rows[0] || null;
}

export async function findByEmail(email) {
  const [rows] = await db.query(`SELECT * FROM users WHERE email = ? AND role = 'customer'`, [email.toLowerCase().trim()]);
  return rows[0] || null;
}

export async function createWithPassword(data) {
  const id = generateUUID();
  const passwordHash = await bcrypt.hash(data.password, 10);
  await db.query(
    `INSERT INTO users (id, email, first_name, last_name, password_hash, role, created_at, updated_at) 
     VALUES (?, ?, ?, ?, ?, 'customer', NOW(), NOW())`,
    [id, data.email.toLowerCase().trim(), data.firstName || null, data.lastName || null, passwordHash]
  );
  const [rows] = await db.query(`SELECT * FROM users WHERE id = ?`, [id]);
  return rows[0];
}

export async function updateLastLogin(customerId) {
  await db.query(`UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = ?`, [customerId]);
}

export async function updateProfile(customerId, data) {
  const fields = [];
  const values = [];
  if (data.firstName) { fields.push('first_name = ?'); values.push(data.firstName); }
  if (data.lastName)  { fields.push('last_name = ?');  values.push(data.lastName); }
  if (data.phone)     { fields.push('phone = ?');      values.push(data.phone); }
  if (data.address1)  { fields.push('address1 = ?');   values.push(data.address1); }
  if (data.address2)  { fields.push('address2 = ?');   values.push(data.address2); }
  if (data.city)      { fields.push('city = ?');       values.push(data.city); }
  if (data.state)     { fields.push('state = ?');      values.push(data.state); }
  if (data.zip)       { fields.push('zip = ?');        values.push(data.zip); }
  if (data.country)   { fields.push('country = ?');    values.push(data.country); }
  if (fields.length === 0) return;
  values.push(customerId);
  await db.query(`UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ? AND role = 'customer'`, values);
}

export async function getOrders(customerId) {
  return db.query('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC', [customerId]);
}

export default { findOrCreate, findById, findByEmail, createWithPassword, updateLastLogin, updateProfile, getOrders };
