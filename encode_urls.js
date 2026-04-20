import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sqlPath = path.join(__dirname, 'sql', 'create_tables.sql');
let content = fs.readFileSync(sqlPath, 'utf8');

// Regex to find S3 URLs and replace spaces with %20
// It looks for the S3 base URL and matches until the end of the quote or a JSON separator
content = content.replace(/(https:\/\/detailguardz\.s3\.us-east-1\.amazonaws\.com\/[^'"]+)/g, (match) => {
  return match.replace(/ /g, '%20');
});

fs.writeFileSync(sqlPath, content);
console.log('✅ All S3 URLs in create_tables.sql have been URL-encoded (spaces replaced with %20).');
