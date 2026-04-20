const ensureAbsoluteUrl = (url) => {
  if (!url) return url;
  const API_URL = 'http://localhost:5000';
  let finalUrl = url;
  if (!url.startsWith('http') && !url.startsWith('data:')) {
    const cleanUrl = url.startsWith('@/') ? url.substring(1) : (url.startsWith('/') ? url : `/${url}`);
    finalUrl = `${API_URL}${cleanUrl}`;
  }
  try {
    const parts = finalUrl.split('://');
    if (parts.length === 2) {
      const protocol = parts[0];
      const rest = parts[1].replace(/\+/g, '%2B');
      const pathParts = rest.split('/');
      const encodedPath = pathParts.map(part => {
        return encodeURIComponent(decodeURIComponent(part));
      }).join('/');
      return `${protocol}://${encodedPath}`;
    }
  } catch (e) {
    return finalUrl;
  }
  return finalUrl;
};

const url = 'https://detailguardz.s3.us-east-1.amazonaws.com/assets/Canada%20Products/DIRT%20LOCK%20-%20CAR%20WASH%20BUCKET%20INSERT/DirtLockBlue_MainImage_720x.webp';
console.log('Original:', url);
console.log('Normalized:', ensureAbsoluteUrl(url));
