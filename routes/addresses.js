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

router.post('/', authenticateToken, async (req, res) => {
  try {
    const firstName = req.body.firstName || req.body.first_name;
    const lastName = req.body.lastName || req.body.last_name;
    const isDefault = req.body.isDefault !== undefined ? req.body.isDefault : req.body.is_default;
    const { phone, address1, address2, city, state, zip, country, label } = req.body;

    if (!firstName || !lastName || !address1 || !city || !zip || !country) {
      const missing = [];
      if (!firstName) missing.push('firstName');
      if (!lastName) missing.push('lastName');
      if (!address1) missing.push('address1');
      if (!city) missing.push('city');
      if (!zip) missing.push('zip');
      if (!country) missing.push('country');
      
      logger.warn(`Address creation failed: Missing required fields: ${missing.join(', ')}`, { body: req.body });
      return res.status(400).json({ success: false, message: `Missing required fields: ${missing.join(', ')}` });
    }

    await Address.create({
      userId: req.user.id,
      firstName, lastName, phone, 
      address1, address2, city, state, zip, country, 
      isDefault, label
    });

    res.json({ success: true, message: 'Address added successfully' });
  } catch (error) {
    console.error('Add address error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const firstName = req.body.firstName || req.body.first_name;
    const lastName = req.body.lastName || req.body.last_name;
    const isDefault = req.body.isDefault !== undefined ? req.body.isDefault : req.body.is_default;
    const { phone, address1, address2, city, state, zip, country, label } = req.body;

    await Address.update(req.params.id, req.user.id, {
      firstName, lastName, phone, 
      address1, address2, city, state, zip, country, 
      isDefault, label
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
