import 'dotenv/config';
import { refundLabel } from '../services/shippoService.js';

async function cleanup() {
  const txId = 'c3f2f6d3ac424727b60debecaa7e4a84';
  try {
    console.log(`Attempting to refund transaction ${txId}...`);
    const result = await refundLabel(txId);
    console.log('SUCCESS:', result);
  } catch (err) {
    console.error('FAILED:', err.response?.data || err.message);
  }
}

cleanup();
