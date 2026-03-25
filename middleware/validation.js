import { body, param, query, validationResult } from 'express-validator';

export function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map(e => ({ field: e.path, message: e.msg }))
    });
  }
  next();
}

export const validateCreateOrder = [
  body('country').isIn(['US', 'CA']).withMessage('Country must be US or CA'),
  body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
  body('items.*.sku').notEmpty().withMessage('Item SKU is required').isString().trim(),
  body('items.*.quantity').isInt({ min: 1, max: 100 }).withMessage('Quantity must be between 1 and 100'),
  body('shipping.firstName').notEmpty().trim().withMessage('First name is required'),
  body('shipping.lastName').notEmpty().trim().withMessage('Last name is required'),
  body('shipping.address1').notEmpty().trim().withMessage('Address is required'),
  body('shipping.city').notEmpty().trim().withMessage('City is required'),
  body('shipping.phone').optional().matches(/^[+\d\s\-().]{7,20}$/).withMessage('Invalid phone number'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('shipping.state').if(body('country').equals('US')).notEmpty().withMessage('State is required for US orders'),
  body('shipping.zip').if(body('country').equals('US')).matches(/^\d{5}(-\d{4})?$/).withMessage('Invalid US ZIP code'),
  body('shipping.province').if(body('country').equals('CA')).notEmpty().withMessage('Province is required for CA orders'),
  body('shipping.postalCode').if(body('country').equals('CA')).matches(/^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/).withMessage('Invalid Canadian postal code'),
  body('paymentReference').notEmpty().withMessage('Payment reference is required'),
  handleValidation
];

export const validateFulfillmentPreview = [
  body('country').isIn(['US', 'CA']).withMessage('Country must be US or CA'),
  body('items').isArray({ min: 1 }).withMessage('Items required'),
  body('items.*').custom((item) => {
    if (!item.variantId && !item.sku) throw new Error('Each item must include either variantId or sku');
    if (!item.quantity || item.quantity < 1) throw new Error('Each item must include a valid quantity (>= 1)');
    return true;
  }),
  body('shipping').isObject().withMessage('Shipping address required'),
  handleValidation
];

export const validateCustomerAuth = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').isString().withMessage('Password must be a string').isLength({ min: 8 }).withMessage('Password must be at least 8 characters long').matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter').matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter').matches(/\d/).withMessage('Password must contain at least one number').isLength({ max: 64 }).withMessage('Password must not exceed 64 characters'),
  body('firstName').optional({ checkFalsy: true }).isString().trim().isLength({ max: 100 }).withMessage('First name cannot exceed 100 characters'),
  body('lastName').optional({ checkFalsy: true }).isString().trim().isLength({ max: 100 }).withMessage('Last name cannot exceed 100 characters'),
  handleValidation
];

export const validateCustomerProfile = [
  body('firstName').optional({ checkFalsy: true }).isString().trim().isLength({ max: 100 }).withMessage('First name cannot exceed 100 characters'),
  body('lastName').optional({ checkFalsy: true }).isString().trim().isLength({ max: 100 }).withMessage('Last name cannot exceed 100 characters'),
  body('phone').optional({ checkFalsy: true }).matches(/^[+\d\s\-().]{7,20}$/).withMessage('Invalid phone number'),
  body('country').optional({ checkFalsy: true }).isIn(['US', 'CA']).withMessage('Country must be US or CA'),
  handleValidation
];

export const validateOrderId = [
  param('orderId').notEmpty().withMessage('Order ID is required'),
  handleValidation
];

export default { handleValidation, validateCreateOrder, validateFulfillmentPreview, validateCustomerAuth, validateCustomerProfile, validateOrderId };
