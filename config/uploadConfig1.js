// // backend/config/uploadConfig.js
// import multer from "multer";
// import path from "path";
// import fs from "fs";

// const uploadsDir = path.join(process.cwd(), "uploads");

// if (!fs.existsSync(uploadsDir)) {
//   fs.mkdirSync(uploadsDir);
// }

// const storage = multer.diskStorage({
//   destination: function (req, file, cb) {
//     cb(null, uploadsDir);
//   },
//   filename: function (req, file, cb) {
//     const ext = path.extname(file.originalname);
//     const base = path.basename(file.originalname, ext);
//     const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
//     cb(null, `${base}-${unique}${ext}`);
//   },
// });

// export const upload = multer({ storage });

//testing 
// backend/config/uploadConfig.js
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "..", "uploads"));
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  },
});

export const upload = multer({ storage });
