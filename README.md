# E-Commerce Backend — Complete Setup Guide
## Amazon MCF (SP-API) + Shippo + MySQL + Node.js/Express

---

## 📁 Project Structure

```
ecommerce-backend/
├── server.js                        ← Entry point
├── package.json
├── .env.example                     ← Copy to .env and fill values
├── .gitignore
│
├── config/
│   ├── database.js                  ← MySQL pool
│   └── redis.js                     ← Redis client (Bull queues)
│
├── middleware/
│   ├── auth.js                      ← JWT middleware (requireAuth, requireRole)
│   └── validation.js                ← express-validator rules
│
├── models/
│   ├── Order.js                     ← All order DB operations
│   ├── Customer.js                  ← Customer findOrCreate, findById
│   └── Product.js                   ← Product listing, SKU validation
│
├── services/
│   ├── amazonTokenService.js        ← LWA OAuth2 token refresh + cache
│   ├── spApiClient.js               ← SP-API HTTP client (SigV4 signed)
│   ├── mcfService.js                ← Amazon MCF create/get/cancel order
│   ├── shippoService.js             ← Shippo label + tracking + rates
│   ├── fulfillmentService.js        ← Orchestrator: routes US→MCF, CA→Shippo
│   └── emailService.js              ← Nodemailer transactional emails
│
├── routes/
│   ├── orderRoutes.js               ← POST /api/orders, GET /api/orders/:id
│   ├── fulfillmentRoutes.js         ← Preview, rates, cancel, status
│   ├── trackingRoutes.js            ← GET /api/tracking/:orderId
│   ├── webhookRoutes.js             ← Shippo + Stripe/PayPal webhooks
│   ├── productRoutes.js             ← Product listing by country
│   └── authRoutes.js                ← Admin login/JWT
│
├── jobs/
│   └── trackingPoller.js            ← Bull queue: polls MCF every 15min
│
├── utils/
│   ├── logger.js                    ← Winston logger
│   └── helpers.js                   ← Utilities (UUID, retry, formatCurrency)
│
├── sql/
│   ├── migrate.js                   ← Creates all DB tables
│   └── seed.js                      ← Creates admin user + sample products
│
└── logs/                            ← Auto-created: error.log, combined.log
```

---

## 🚀 Step-by-Step Setup

### Step 1 — Prerequisites

Make sure you have the following installed:

```bash
node --version    # v18+ recommended
mysql --version   # MySQL 8.0+
redis-cli ping    # Redis 6+
```

Install Redis (if not installed):
```bash
# Ubuntu/Debian
sudo apt update && sudo apt install redis-server
sudo systemctl enable redis-server && sudo systemctl start redis-server

# macOS
brew install redis && brew services start redis

# Windows — use WSL2 or Docker:
docker run -d -p 6379:6379 redis:latest
```

---

### Step 2 — Install Project Dependencies

```bash
# Navigate to your backend folder
cd ecommerce-backend

# Install all npm packages
npm install

# Install nodemon for dev (optional)
npm install -D nodemon
```

---

### Step 3 — Configure Environment Variables

```bash
cp .env.example .env
```

Open `.env` and fill in every value. Key sections:

#### MySQL
```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=ecommerce_db
```

#### Amazon SP-API
```env
LWA_CLIENT_ID=amzn1.application-oa2-client.XXXX
LWA_CLIENT_SECRET=amzn1.oa2-cs.v1.XXXX
LWA_REFRESH_TOKEN=Atzr|XXXX
AMAZON_SELLER_ID=AXXXXXXXXXX
AWS_ACCESS_KEY_ID=AKIAXXXXXXXX
AWS_SECRET_ACCESS_KEY=XXXXXXXXXXXXXXXXXXXXXXXX
AMAZON_SANDBOX=true   # ← Start with true for testing
```

#### Shippo
```env
SHIPPO_API_KEY=shippo_test_XXXX   # ← Start with test key
SHIPPO_FROM_NAME=Your Store
SHIPPO_FROM_STREET1=123 Warehouse St
SHIPPO_FROM_CITY=Toronto
SHIPPO_FROM_STATE=ON
SHIPPO_FROM_ZIP=M5H2N2
SHIPPO_FROM_COUNTRY=CA
```

#### Email (SendGrid SMTP)
```env
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=SG.XXXX
EMAIL_FROM_NAME=Your Store
EMAIL_FROM_ADDRESS=noreply@yourstore.com
```

---

### Step 4 — Setup Amazon SP-API Credentials

#### 4.1 — Create IAM User in AWS Console

1. Go to **AWS Console** → IAM → Users → **Add Users**
2. Username: `ecommerce-spapi`
3. Access type: **Programmatic access**
4. Attach policy: Create a new policy with this JSON:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "execute-api:Invoke",
      "Resource": "arn:aws:execute-api:us-east-1:*:*"
    }
  ]
}
```

5. Copy **Access Key ID** and **Secret Access Key** → paste in `.env`

#### 4.2 — Register Your App in Seller Central

1. Log into **Seller Central** → Apps & Services → **Develop Apps**
2. Click **Add new app client**
3. Fill in:
   - **App Name**: Your E-Commerce Integration
   - **IAM ARN**: Paste the ARN of the IAM user you created above
   - **OAuth Login URI**: `https://yourdomain.com/auth/amazon/callback`
4. Save → Copy **Client ID** and **Client Secret** → paste in `.env`

#### 4.3 — Get Your Refresh Token

1. In Seller Central → Develop Apps → your app → **Authorize**
2. Follow the OAuth flow
3. Copy the **Refresh Token** → paste in `.env` as `LWA_REFRESH_TOKEN`

#### 4.4 — Enroll SKUs in Amazon MCF

> Your products must be enrolled in FBA/MCF inventory in Amazon Seller Central
> before you can create MCF fulfillment orders for them.

1. In Seller Central → Inventory → **Manage FBA Inventory**
2. Make sure your SKUs exist and have inventory
3. Copy the SKU values into your products table (the `sku` column)
4. Optionally copy the FNSKU into the `fnsku` column

---

### Step 5 — Setup Shippo

1. Create account at **app.goshippo.com**
2. Go to **API** → get your **Test API Token** first
3. Paste in `.env` as `SHIPPO_API_KEY=shippo_test_XXXX`
4. Set up your **webhook** in Shippo Dashboard:
   - Go to **Webhooks** → Add Webhook
   - URL: `https://yourdomain.com/api/webhooks/shippo`
   - Event type: **Tracking Updated**
5. When going live, swap to `shippo_live_XXXX`

---

### Step 6 — Run Database Migrations

```bash
# Create all tables
node sql/migrate.js

# Seed admin user + sample products
node sql/seed.js
```

**Default admin credentials (CHANGE IMMEDIATELY):**
- Email: `admin@yourstore.com`
- Password: `Admin@1234`

---

### Step 7 — Start the Server

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

You should see:
```
[timestamp] info: ✅  MySQL database connected
[timestamp] info: ✅  Redis connected
[timestamp] info: ✅  Background tracking poller started
[timestamp] info: ✅  Server running on port 5000 [development]
```

Test health check:
```bash
curl http://localhost:5000/health
```

---

## 🔌 API Endpoints Reference

### Products
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/products` | List products (auto-detect country from IP) |
| GET | `/api/products?country=US` | US products only |
| GET | `/api/products?country=CA` | Canada products only |
| GET | `/api/products/:id` | Single product |

### Orders
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/orders` | Create order + trigger fulfillment |
| GET | `/api/orders/:orderId?email=x` | Get order (with email verification) |
| GET | `/api/orders/number/:orderNumber` | Get by order number |
| POST | `/api/orders/:orderId/fulfill` | Manual fulfill (admin) |
| POST | `/api/orders/:orderId/retry` | Retry failed fulfillment (admin) |

### Fulfillment
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/fulfillment/preview` | MCF shipping speeds for US cart |
| POST | `/api/fulfillment/rates` | Shippo rates for CA cart |
| POST | `/api/fulfillment/validate-address` | Validate CA address |
| GET | `/api/fulfillment/status/:orderId` | Live MCF status (admin) |
| POST | `/api/fulfillment/cancel/:orderId` | Cancel MCF order (admin) |

### Tracking
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tracking/:orderId?email=x` | Get tracking info |
| GET | `/api/tracking/number/:trackingNumber` | Lookup by tracking # |
| POST | `/api/tracking/:orderId/refresh` | Force-refresh now (admin) |

### Webhooks
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/webhooks/shippo` | Shippo tracking updates |
| POST | `/api/webhooks/payment` | Stripe/PayPal payment events |

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Admin login → JWT |
| GET | `/api/auth/me` | Current admin user |
| POST | `/api/auth/refresh` | Refresh JWT |

---

## 📦 Frontend Integration Guide

### 1. Detect Country & Load Products

```javascript
// frontend: productService.js
async function loadProducts() {
  const response = await fetch('/api/products');  // Auto-detects country from IP
  const { products, country } = await response.json();
  return { products, country };
}
```

### 2. Get Shipping Options at Checkout

**For US (Amazon MCF speeds):**
```javascript
const response = await fetch('/api/fulfillment/preview', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    country: 'US',
    items: cartItems,   // [{ sku, quantity }]
    shipping: {
      firstName: 'John', lastName: 'Doe',
      address1: '123 Main St', city: 'Seattle',
      state: 'WA', zip: '98101', phone: '2065551234'
    }
  })
});
const { previews } = await response.json();
// previews = [{ shippingSpeedCategory, isFulfillable, estimatedFees, fulfillmentPreviewShipments }]
```

**For Canada (Shippo rates):**
```javascript
const response = await fetch('/api/fulfillment/rates', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    country: 'CA',
    items: cartItems,
    shipping: {
      firstName: 'Jane', lastName: 'Smith',
      address1: '456 Maple Ave', city: 'Toronto',
      province: 'ON', postalCode: 'M5H2N2'
    }
  })
});
const { rates } = await response.json();
// rates = [{ provider, serviceName, amount, currency, estimatedDays }]
```

### 3. Place Order After Payment

```javascript
// Call this AFTER your payment provider (Stripe/PayPal) confirms payment
async function placeOrder(paymentResult) {
  const response = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      country: 'US',                           // 'US' or 'CA'
      email: 'customer@email.com',
      items: [{ sku: 'PROD-US-001', quantity: 2 }],
      shipping: {
        firstName: 'John', lastName: 'Doe',
        address1: '123 Main St', address2: 'Apt 4B',
        city: 'Seattle', state: 'WA', zip: '98101',
        phone: '2065551234'
      },
      shippingSpeed: 'standard',               // 'standard'|'expedited'|'priority'
      paymentMethod: 'stripe',
      paymentReference: paymentResult.paymentIntentId,
      subtotal: 59.98,
      tax: 5.40,
      shippingCost: 0,
      total: 65.38,
      currency: 'USD'
    })
  });
  return response.json();
}
```

### 4. Track an Order

```javascript
async function getTracking(orderId, customerEmail) {
  const response = await fetch(
    `/api/tracking/${orderId}?email=${encodeURIComponent(customerEmail)}`
  );
  const data = await response.json();
  // data.tracking = { trackingNumber, trackingUrl, carrier, status, estimatedDelivery }
  return data;
}
```

---

## 🔄 The Complete Order Flow

```
Customer buys on your site
         │
         ▼
  Payment processed (Stripe/PayPal)
         │
         ├──────────────────────────────────────────┐
         │                                          │
  Stripe webhook fires          OR         Frontend calls POST /api/orders
  POST /api/webhooks/payment               (if you want to trigger manually)
         │
         ▼
  Order created in MySQL (status: 'pending' → 'paid')
         │
         ▼
  fulfillmentService.fulfillOrder(orderId) called async
         │
         ├── country === 'US' ────────────────────────────────────┐
         │                                                         │
         │                              mcfService.createFulfillmentOrder()
         │                              POST /fba/outbound/2020-07-01/fulfillmentOrders
         │                              Order status → 'submitted_to_amazon'
         │                              Order confirmation email sent
         │                                         │
         │                              Background poller runs every 15min
         │                              GET /fba/outbound/2020-07-01/fulfillmentOrders/{id}
         │                              When tracking number appears:
         │                                - DB updated with tracking#, carrier
         │                                - "Your order shipped" email sent
         │
         └── country === 'CA' ────────────────────────────────────┐
                                                                   │
                                        shippoService.createShipment()
                                        → Address created
                                        → Parcel created
                                        → Rates fetched
                                        → Label purchased
                                        Order status → 'label_created'
                                        Tracking # stored in DB immediately
                                        Confirmation + shipped email sent
                                                   │
                                        Shippo webhook POST /api/webhooks/shippo
                                        Fires when: in_transit, out_for_delivery, delivered
                                        → DB status updated
                                        → "Delivered" email sent on delivery
```

---

## ⚙️ Environment: Testing vs Production

### Testing (Sandbox)
```env
AMAZON_SANDBOX=true
SHIPPO_API_KEY=shippo_test_XXXX
```
- Amazon sandbox test ASIN: `B00000K3CQ`
- Amazon sandbox test address: `1000 Pine St, Seattle WA 98101`
- Shippo test labels have "TEST" watermark — not real

### Production
```env
AMAZON_SANDBOX=false
SHIPPO_API_KEY=shippo_live_XXXX
```

---

## 🚀 Production Deployment Checklist

- [ ] Set `NODE_ENV=production` in `.env`
- [ ] Set `AMAZON_SANDBOX=false`
- [ ] Switch to `SHIPPO_API_KEY=shippo_live_XXXX`
- [ ] Set a strong random `JWT_SECRET` (min 64 characters)
- [ ] Change the default admin password
- [ ] Configure HTTPS (Nginx + Let's Encrypt recommended)
- [ ] Set `FRONTEND_URL` to your actual domain (for CORS)
- [ ] Register Shippo webhook with your production domain URL
- [ ] Register Stripe/PayPal webhook with your production domain URL
- [ ] Run `node sql/migrate.js` on your production MySQL
- [ ] Set up log rotation for `logs/` directory
- [ ] Use a process manager: `pm2 start server.js --name ecommerce`

---

## ❓ Troubleshooting

### "401 Unauthorized" from Amazon SP-API
- Verify `LWA_REFRESH_TOKEN` is correct and not expired
- Re-authorize the app in Seller Central to get a fresh refresh token

### "400 InvalidSKU" from Amazon MCF
- The SKU must exist in Amazon FBA/MCF inventory
- Log into Seller Central → FBA Inventory and verify the exact SKU string

### Shippo "label purchase failed"
- Check address is valid Canadian format (postal code: `A1A 1A1`)
- Ensure parcel dimensions are within carrier limits
- Use `POST /api/fulfillment/validate-address` to pre-validate

### Redis connection failed
- `redis-cli ping` should return `PONG`
- Start Redis: `redis-server` or `sudo systemctl start redis`

### Bull queue jobs not running
- Redis must be running
- Check `logs/combined.log` for errors
- Verify `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` in `.env`

### Emails not sending
- Verify `SMTP_PASS` is a valid SendGrid API key
- Test with: `node -e "require('./services/emailService').sendOrderConfirmationEmail({...})"` 

---

## 📞 API Test Curl Commands

```bash
# Health check
curl http://localhost:5000/health

# Get products (US)
curl "http://localhost:5000/api/products?country=US"

# Get products (CA)
curl "http://localhost:5000/api/products?country=CA"

# Get shipping rates for CA cart
curl -X POST http://localhost:5000/api/fulfillment/rates \
  -H "Content-Type: application/json" \
  -d '{
    "country": "CA",
    "items": [{"sku": "PROD-CA-001", "quantity": 1}],
    "shipping": {
      "firstName": "Jane", "lastName": "Smith",
      "address1": "456 Maple Ave", "city": "Toronto",
      "province": "ON", "postalCode": "M5H2N2"
    }
  }'

# Admin login
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@yourstore.com", "password": "Admin@1234"}'

# Track an order (replace IDs)
curl "http://localhost:5000/api/tracking/ORDER-ID-HERE?email=customer@email.com"
```
"# Nordica_mcf-USA" 
