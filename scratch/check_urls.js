
import axios from 'axios';

const urls = [
  'https://detailguardz.s3.us-east-1.amazonaws.com/assets/Canada%20Products/DIRT%20LOCK%20-%20CAR%20WASH%20BUCKET%20INSERT/DirtLockBlue_MainImage_720x.webp',
  'https://detailguardz.s3.us-east-1.amazonaws.com/assets/Amazon%20Listing%20Images/Dirt%20Lock-20260122T171825Z-1-001/Dirt%20Lock/Dirt%20Lock%20(blue)%20B07CKLPJZR/2.%20Product%20Features.webp'
];

async function checkUrls() {
  for (const url of urls) {
    try {
      const response = await axios.head(url);
      console.log(`URL: ${url} - Status: ${response.status}`);
    } catch (error) {
      console.log(`URL: ${url} - Error: ${error.response ? error.response.status : error.message}`);
      
      // Try encoding parentheses
      const encodedUrl = url.replace(/\(/g, '%28').replace(/\)/g, '%29');
      try {
        const res2 = await axios.head(encodedUrl);
        console.log(`Encoded URL: ${encodedUrl} - Status: ${res2.status}`);
      } catch (e2) {
        console.log(`Encoded URL: ${encodedUrl} - Error: ${e2.response ? e2.response.status : e2.message}`);
      }
    }
  }
}

checkUrls();
