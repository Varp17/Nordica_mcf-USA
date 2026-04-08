import 'dotenv/config';
import { getTrackingStatus } from '../services/shippoService.js';

const trackings = [
  { id: '#track-0', num: '1028972154028199' }, // 16 digits
  { id: '#track-4', num: '399969045934' },     // 12 digits
  { id: '#track-6', num: '399638486375' },
  { id: '#track-7', num: '9234690396055747583526' }, // 22 digits
  { id: '#track-9', num: '398104999716' },
  { id: '#track-10', num: '397906299060' },
  { id: '#track-11', num: '9234690396055744881397' },
  { id: '#track-12', num: '396031659506' },
  { id: '#track-13', num: '395524177600' },
  { id: '#track-15', num: '1Z51Y5Y16896844159' }, // UPS
  { id: '#track-16', num: '393591389496' },
  { id: '#track-17', num: '393590435816' },
  { id: '#track-18', num: '393560026564' },
  { id: '#track-19', num: '393267113184' }
];

function detectCarrier(num) {
  if (num.startsWith('1Z')) return 'ups';
  if (num.startsWith('92') && num.length === 22) return 'usps';
  if (num.length === 12 && num.startsWith('3')) return 'fedex';
  if (num.length === 16) return 'canada_post';
  return 'usps'; // default try
}

async function fetchAll() {
  console.log('Fetching tracking statuses for real orders...\n');
  
  for (const t of trackings) {
    const carrier = detectCarrier(t.num);
    process.stdout.write(`Fetching ${t.id} (${t.num}) via ${carrier}... `);
    
    try {
      const result = await getTrackingStatus(carrier, t.num);
      console.log(`${result.status || 'UNKNOWN'}`);
      if (result.tracking_status) {
          console.log(`  Last Op: ${result.tracking_status.status_details}`);
          console.log(`  Loc: ${result.tracking_status.location?.city || ''}, ${result.tracking_status.location?.state || ''}`);
      }
    } catch (err) {
      console.log(`FAILED: ${err.response?.data?.detail || err.message}`);
    }
  }
}

fetchAll();
