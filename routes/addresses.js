import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import Address from '../models/Address.js';

const router = express.Router();

// Get all address for logged in user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const addresses = await Address.findAllByUserId(req.user.id);
    res.json({ success: true, addresses });
  } catch (error) {
    console.error('Fetch addresses error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Add new address
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { 
      firstName, lastName, phone, 
      address1, address2, city, state, zip, country, 
      isDefault 
    } = req.body;

    if (!firstName || !lastName || !address1 || !city || !zip || !country) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    await Address.create({
      userId: req.user.id,
      firstName, lastName, phone, 
      address1, address2, city, state, zip, country, 
      isDefault
    });

    res.json({ success: true, message: 'Address added successfully' });
  } catch (error) {
    console.error('Add address error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update address
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { 
      firstName, lastName, phone, 
      address1, address2, city, state, zip, country, 
      isDefault 
    } = req.body;

    await Address.update(req.params.id, req.user.id, {
      firstName, lastName, phone, 
      address1, address2, city, state, zip, country, 
      isDefault
    });

    res.json({ success: true, message: 'Address updated successfully' });
  } catch (error) {
    console.error('Update address error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Delete address
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    await Address.delete(req.params.id, req.user.id);
    res.json({ success: true, message: 'Address deleted successfully' });
  } catch (error) {
    console.error('Delete address error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Set default
router.patch('/:id/default', authenticateToken, async (req, res) => {
  try {
    await Address.setDefault(req.params.id, req.user.id);
    res.json({ success: true, message: 'Default address updated' });
  } catch (error) {
    console.error('Set default address error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

export default router;
