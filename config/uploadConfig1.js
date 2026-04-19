/**
 * DEPRECATED — This file is an exact duplicate of uploadConfig.js.
 * 
 * It was likely created during testing and should be removed in a future cleanup.
 * All imports should use './uploadConfig.js' instead.
 * 
 * Commenting out the duplicate export to prevent confusion.
 */

// import multer from "multer";
// import path from "path";
// import { fileURLToPath } from "url";
//
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);
//
// const storage = multer.diskStorage({
//   destination: (req, file, cb) => {
//     cb(null, path.join(__dirname, "..", "uploads"));
//   },
//   filename: (req, file, cb) => {
//     const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
//     const ext = path.extname(file.originalname);
//     cb(null, unique + ext);
//   },
// });
//
// export const upload = multer({ storage });

// Re-export from the canonical file for backward compatibility
export { upload } from './uploadConfig.js';
