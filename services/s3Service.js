import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

import multer from "multer";
import multerS3 from "multer-s3";
import path from "path";
import { v4 as uuidv4 } from "uuid";

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const upload = multer({
  storage: multerS3({
    s3: s3,
    bucket: process.env.AWS_BUCKET_NAME || "detailguardz",
    acl: "public-read",
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: function (req, file, cb) {
      const fileName = `${uuidv4()}${path.extname(file.originalname)}`;
      const folder = req.body.category ? `assets/products/${req.body.category.toLowerCase().replace(/\s+/g, '-')}/` : "assets/products/uncategorized/";
      cb(null, `${folder}${fileName}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only images are allowed"), false);
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

/**
 * Upload a Buffer to S3
 */
export async function uploadBuffer(buffer, key, contentType = "application/pdf") {
  const bucket = process.env.AWS_S3_BUCKET || process.env.AWS_BUCKET_NAME || "detailguardz";
  
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    // Note: Public ACL depends on bucket settings. 
    // If bucket is strictly private, omit this and use signed URLs or CloudFront.
  }));

  const region = process.env.AWS_REGION || "us-east-1";
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

export { s3, upload };

