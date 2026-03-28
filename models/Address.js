import db from '../config/database.js';

export const Address = {
  async findAllByUserId(userId) {
    const [rows] = await db.execute(
      'SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC',
      [userId]
    );
    return rows;
  },

  async findById(id) {
    const [rows] = await db.execute('SELECT * FROM addresses WHERE id = ?', [id]);
    return rows[0] || null;
  },

  async create(data) {
    const { 
      userId, firstName, lastName, phone, 
      address1, address2, city, state, zip, country, 
      isDefault 
    } = data;

    // If setting as default, unset others first
    if (isDefault) {
      await db.execute('UPDATE addresses SET is_default = 0 WHERE user_id = ?', [userId]);
    }

    const [result] = await db.execute(
      `INSERT INTO addresses (
        user_id, first_name, last_name, phone, 
        address1, address2, city, state, zip, country, 
        is_default
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, firstName, lastName, phone || null, 
        address1, address2 || null, city, state || null, zip, country, 
        isDefault ? 1 : 0
      ]
    );

    return result.insertId;
  },

  async update(id, userId, data) {
    const { 
      firstName, lastName, phone, 
      address1, address2, city, state, zip, country, 
      isDefault 
    } = data;

    if (isDefault) {
      await db.execute('UPDATE addresses SET is_default = 0 WHERE user_id = ?', [userId]);
    }

    await db.execute(
      `UPDATE addresses SET 
        first_name = ?, last_name = ?, phone = ?, 
        address1 = ?, address2 = ?, city = ?, state = ?, zip = ?, country = ?, 
        is_default = ? 
      WHERE id = ? AND user_id = ?`,
      [
        firstName, lastName, phone || null, 
        address1, address2 || null, city, state || null, zip, country, 
        isDefault ? 1 : 0,
        id, userId
      ]
    );
  },

  async delete(id, userId) {
    await db.execute('DELETE FROM addresses WHERE id = ? AND user_id = ?', [id, userId]);
  },

  async setDefault(id, userId) {
    await db.execute('UPDATE addresses SET is_default = 0 WHERE user_id = ?', [userId]);
    await db.execute('UPDATE addresses SET is_default = 1 WHERE id = ? AND user_id = ?', [id, userId]);
  }
};

export default Address;
