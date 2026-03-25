import axios from 'axios';

const BASE_URL = 'http://localhost:5000/api';

async function testSlug(slug) {
  try {
    const res = await axios.get(`${BASE_URL}/products/slug/${slug}?country=US`);
    console.log('SUCCESS:', JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error('ERROR:', err.response?.data || err.message);
  }
}

// I saw this slug in a previous check (approximated)
testSlug('dirt-lock-scrub-wall-180-360-vertical-cleaning-tool-for-brushes-mitts');
