const fs = require('fs');
const path = require('path');

const seedPath = path.join(__dirname, 'sql', 'Product_seed.sql');
const destPath = path.join(__dirname, 'sql', 'Product_seed_mysql.sql');

let content = fs.readFileSync(seedPath, 'utf8');

// 1. Remove Postgres casting ::JSONB
content = content.split('::JSONB').join('');

// 2. Remove Postgres extended string indicator E'
content = content.replace(/E'/g, "'");

// 3. Fix JSON escaping for MySQL backslashes (quoted quotes)
// Case: \"
content = content.split('\\"').join('\\\\"');

// 4. Fix JSON escaping for newlines in strings
// Case: \n inside a JSON string
content = content.split('\\n').join('\\\\n');
content = content.split('\\r').join('\\\\r');

// 5. Handle MySQL boolean true/false (avoiding internal string matches)
// Matches , true, or (true,
content = content.replace(/([,\s]\()(true)([,\s])/g, '$1 1 $3');
content = content.replace(/([,\s])(true)([,\s])/g, '$1 1 $3');
content = content.replace(/([,\s]\()(false)([,\s])/g, '$1 0 $3');
content = content.replace(/([,\s])(false)([,\s])/g, '$1 0 $3');

fs.writeFileSync(destPath, content);
console.log('✨ Cleaned seed file created.');
