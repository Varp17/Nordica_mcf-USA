
import fetch from 'node-fetch';
async function test() {
  try {
    const loginRes = await fetch('http://127.0.0.1:5000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@detailguardz.com', password: 'Admin@Secure123!' })
    });
    const auth = await loginRes.json();
    if (!auth.token) { console.log('Login failed:', JSON.stringify(auth)); return; }
    const token = auth.token;

    // 1. Create dummy order
    const orderRes = await fetch('http://127.0.0.1:5000/api/admin/create-dummy-order', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token }
    });
    const orderData = await orderRes.json();
    console.log('DUMMY ORDER:', JSON.stringify(orderData));

    // 2. Check products
    const productRes = await fetch('http://127.0.0.1:5000/api/admin/products', {
      headers: { Authorization: 'Bearer ' + token }
    });
    const products = await productRes.json();
    console.log('PRODUCTS:', JSON.stringify({ count: products.length, first: products[0]?.name, image: products[0]?.image_url }));

    // 3. Check banners
    const bannerRes = await fetch('http://127.0.0.1:5000/api/admin/banners', {
      headers: { Authorization: 'Bearer ' + token }
    });
    const banners = await bannerRes.json();
    console.log('BANNERS:', JSON.stringify({ count: banners.length }));

  } catch (e) {
    console.error('TEST ERROR:', e.message);
  }
}
test();
