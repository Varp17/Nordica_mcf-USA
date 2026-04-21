
import db from '../config/database.js';
import { v4 as uuidv4 } from 'uuid';

class Ticket {
    static async create(data) {
        const id = uuidv4();
        const ticket_number = await this.generateTicketNumber();
        
        const query = `
            INSERT INTO contact_tickets (
                id, ticket_number, name, email, subject, message, country, priority, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        const values = [
            id,
            ticket_number,
            data.name,
            data.email,
            data.subject,
            data.message,
            data.country || 'US',
            data.priority || 'medium',
            data.source || 'web_form'
        ];
        
        await db.query(query, values);
        return { id, ticket_number, ...data };
    }

    static async generateTicketNumber() {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const prefix = 'TK';

        // Get and increment the sequence in a transaction
        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();

            const [rows] = await conn.query(
                'SELECT last_number FROM ticket_sequences WHERE year = ? AND month = ? FOR UPDATE',
                [year, month]
            );

            let nextNumber = 1;
            if (rows.length > 0) {
                nextNumber = rows[0].last_number + 1;
                await conn.query(
                    'UPDATE ticket_sequences SET last_number = ? WHERE year = ? AND month = ?',
                    [nextNumber, year, month]
                );
            } else {
                await conn.query(
                    'INSERT INTO ticket_sequences (year, month, last_number, prefix) VALUES (?, ?, ?, ?)',
                    [year, month, 1, prefix]
                );
            }

            await conn.commit();
            
            // Format: TK-YYYYMM-001
            const datePart = `${year}${month.toString().padStart(2, '0')}`;
            const seqPart = nextNumber.toString().padStart(3, '0');
            return `${prefix}-${datePart}-${seqPart}`;
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    }

    static async findAll(filters = {}) {
        let query = 'SELECT * FROM contact_tickets';
        const values = [];
        const conditions = [];

        if (filters.country) {
            conditions.push('country = ?');
            values.push(filters.country);
        }

        if (filters.status) {
            conditions.push('status = ?');
            values.push(filters.status);
        }

        if (filters.priority) {
            conditions.push('priority = ?');
            values.push(filters.priority);
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        query += ' ORDER BY created_at DESC';

        const [rows] = await db.query(query, values);
        return rows;
    }

    static async findById(id) {
        const [rows] = await db.query('SELECT * FROM contact_tickets WHERE id = ?', [id]);
        return rows[0];
    }

    static async update(id, updates) {
        const allowedUpdates = [
            'status', 'priority', 'assigned_to', 'internal_notes', 
            'response_message', 'responded_at'
        ];
        
        const actualUpdates = [];
        const values = [];

        Object.keys(updates).forEach(key => {
            if (allowedUpdates.includes(key)) {
                actualUpdates.push(`${key} = ?`);
                values.push(updates[key]);
            }
        });

        if (actualUpdates.length === 0) return null;

        values.push(id);
        const query = `UPDATE contact_tickets SET ${actualUpdates.join(', ')} WHERE id = ?`;
        
        await db.query(query, values);
        return this.findById(id);
    }
}

export default Ticket;
