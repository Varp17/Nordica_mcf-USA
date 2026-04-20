import axios from 'axios';

const urls = [
  'https://detailguardz.s3.us-east-1.amazonaws.com/assets/Amazon%20Listing%20Images/Dirt%20Lock-20260122T171825Z-1-001/Dirt%20Lock/Dirt%20Lock%20(black)%20B07CKC4M9D/1.%20Hero%20Image.webp',
  'https://detailguardz.s3.us-east-1.amazonaws.com/assets/Amazon%20Listing%20Images/Dirt%20Lock-20260122T171825Z-1-001/Dirt%20Lock/Dirt%20Lock%20(blue)%20B07CKLPJZR/1.%20Hero%20Image.webp',
  'https://detailguardz.s3.us-east-1.amazonaws.com/assets/Amazon%20Listing%20Images/Dirt%20Lock-20260122T171825Z-1-001/Dirt%20Lock/Dirt%20Lock%20(red)%20B07CKG1VCH/1.%20Hero%20Image.webp',
  'https://detailguardz.s3.us-east-1.amazonaws.com/assets/Amazon%20Listing%20Images/Dirt%20Lock-20260122T171825Z-1-001/Dirt%20Lock/Dirt%20Lock%20(white)%20B088PZXQY1/1.%20Hero%20Image.webp',
  'https://detailguardz.s3.us-east-1.amazonaws.com/assets/Canada%20Products/DETAIL%20GUARDZ%20-%20HOSE%20GUIDE%20(4PK)/Detail_Guardz_Car_Hose_Guides_-_4_Pack_Black_720x.webp',
  'https://detailguardz.s3.us-east-1.amazonaws.com/assets/Canada%20Products/DOUBLE%20TWIST%20WASH%20MITT/ssum_double-twist-mitt_720x-main.jpg'
];

async function check() {
  for (const url of urls) {
    try {
      const res = await axios.head(url);
      console.log(`✅ ${res.status} - ${url}`);
    } catch (e) {
      console.log(`❌ ${e.response ? e.response.status : e.message} - ${url}`);
    }
  }
}

check();
