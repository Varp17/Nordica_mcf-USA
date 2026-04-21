
import express from 'express';
import Ticket from '../models/Ticket.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { sendNewTicketAdminAlert } from '../services/emailService.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Public: Submit a query
router.post('/', async (req, res) => {
    try {
        const { name, email, subject, message, country } = req.body;

        if (!name || !email || !subject || !message) {
            return res.status(400).json({ success: false, message: 'All fields are required' });
        }

        const ticket = await Ticket.create({
            name,
            email,
            subject,
            message,
            country: country || req.region || 'US'
        });

        // Async send email alert to admin
        sendNewTicketAdminAlert(ticket).catch(err => {
            logger.error(`Failed to send admin alert for ticket ${ticket.ticket_number}: ${err.message}`);
        });

        logger.info(`New ticket created: ${ticket.ticket_number}`);
        res.status(201).json({ 
            success: true, 
            message: 'Your inquiry has been submitted. Our team will get back to you soon.',
            ticket_number: ticket.ticket_number 
        });
    } catch (err) {
        logger.error(`Failed to create ticket: ${err.message}`);
        res.status(500).json({ success: false, message: 'Failed to submit inquiry' });
    }
});

// Admin: Get all tickets
router.get('/', requireAuth, requireRole('admin', 'superadmin', 'support'), async (req, res) => {
    try {
        const { country, status, priority } = req.query;
        const tickets = await Ticket.findAll({ country, status, priority });
        res.json({ success: true, data: tickets });
    } catch (err) {
        logger.error(`Failed to fetch tickets: ${err.message}`);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Admin: Get ticket details
router.get('/:id', requireAuth, requireRole('admin', 'superadmin', 'support'), async (req, res) => {
    try {
        const ticket = await Ticket.findById(req.params.id);
        if (!ticket) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }
        res.json({ success: true, data: ticket });
    } catch (err) {
        logger.error(`Failed to fetch ticket ${req.params.id}: ${err.message}`);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Admin: Update ticket
router.patch('/:id', requireAuth, requireRole('admin', 'superadmin', 'support'), async (req, res) => {
    try {
        const { status, priority, internal_notes, response_message } = req.body;
        
        const updates = { status, priority, internal_notes, response_message };
        if (response_message) {
            updates.responded_at = new Date();
        }

        const ticket = await Ticket.update(req.params.id, updates);
        if (!ticket) {
            return res.status(404).json({ success: false, message: 'Ticket not found or no updates provided' });
        }

        logger.info(`Ticket ${ticket.ticket_number} updated by ${req.user.email}`);
        res.json({ success: true, data: ticket });
    } catch (err) {
        logger.error(`Failed to update ticket ${req.params.id}: ${err.message}`);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

export default router;
