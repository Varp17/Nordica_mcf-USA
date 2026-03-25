import _ from 'lodash';
import stringManipulation from '../utils/string-manipulation.js';
import AWS from 'aws-sdk';
import {v4 as uuidv4} from "uuid";
import db from "../config/database.js";
import logger from "../utils/logger.js";
const _log = logger.child({module: 'googleSheetsReader'});

// Configure AWS
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

// Create S3 service object
const s3 = new AWS.S3();


async function productDataProcessor(productFolderName, googleSheetFileName, imagesFolderName = 'Images', skipImages = false) {
  try {
    // process.driveReader is a google.drive API object
    let productFolderInfo = await process.driveReader.getFolderInfo(process.env.GOOGLE_DRIVE_PRODUCT_ROOT_FOLDER_ID, productFolderName);

    let productFolderFiles = await process.driveReader.listFiles(productFolderInfo.id, 10)

    let spreadSheetInfo = _.find(productFolderFiles, { name: googleSheetFileName });

    // Read spreadsheet content using Sheets API
    let jsonData = await process.sheetsReader.getSheetsData(spreadSheetInfo.id);

    let imagesFolderInfo = _.find(productFolderFiles, {name: imagesFolderName,mimeType: 'application/vnd.google-apps.folder'});

    let imageFolderFiles = await process.driveReader.listFiles(imagesFolderInfo.id, 1000);

    for (let file of imageFolderFiles) {
      file.nameWithoutExtension = stringManipulation.removeFileExtension(file.name).toLowerCase();
      file.imageUrl = `${process.env.AWS_S3_HTTP_URL}/${process.env.AWS_S3_PRODUCT_IMAGES_PATH}/${stringManipulation.formatString(productFolderName)}/${file.name}`;
    }

    // _log.debug(`imageFolderFiles: ${JSON.stringify(imageFolderFiles, null, 2)}`);
    await Promise.all(jsonData.map(async (row) => {
      let dbRow = {
        name: row["Top Most Selling/Moving Products Name"],
        name_ar: row["Product Arabic Name"],
        price: row["Price"],
        originalPrice: row["Price"],
        description: row["Product Discription"],
        description_ar: row["Product Discription"],
        sku: row["Internal Reference"],
        in_stock: row["Stock"],
        category: row["Product Category"],
        brand: row["Sub Category / Brand Name"],
        image_url: null
      }
      _log.debug(`processing row: ${dbRow.sku}`);
      try {
        let imageRow = _.find(imageFolderFiles, {nameWithoutExtension: dbRow.sku.toLowerCase()});
        dbRow.image_url = imageRow ? imageRow.imageUrl : null;
        _log.debug(`generated imageUrl : ${dbRow.sku} - ${dbRow.image_url}`);
        const insertStatus = await insertProductInfo(dbRow);
        _log.debug(`insertStatus : ${dbRow.sku} - ${insertStatus.success ? 'success' : 'failed'}`);
      }catch (error) {
        _log.warn(`Skipped processing row: ${dbRow.sku}`, error);
      }
    }))

    if (!skipImages) {
      let imageUploadResults = await processImagesFolder(productFolderName, imageFolderFiles);
      _log.debug(`Images processed - ${imageUploadResults.length}`);
    } else {
      _log.debug('Images skipped');
    }
    return {success: true};
  } catch (error) {
    _log.error('Error processing Drive folder:', error);
    throw new Error('Failed to process Drive folder');
  }
}

async function insertProductInfo(body) {

  let {name, name_ar, price, originalPrice, description, description_ar, image_url, sku, in_stock, category: category, brand: brand} = body;

  if (!name || !price || !category || !brand) {
    throw new Error('Name, price, category, and brand are required.');
  }
  const newProductId = uuidv4();
  const stockCount = parseInt(in_stock, 10) || 0;
  const availability = stockCount > 0 ? "In Stock" : "Out of Stock";

  const [[categoryResult]] = await db.execute('SELECT id FROM categories WHERE name = ?', [category]);
  const [[brandResult]] = await db.execute('SELECT id FROM brands WHERE name = ?', [brand]);

  if (!categoryResult || !brandResult) {
    _log.error('Invalid Category or Brand ID provided.', {categoryResult, brandResult, category, brand});
    throw new Error('Invalid Category or Brand ID provided.');
  }

  const sql = `
      INSERT INTO products (id, name, name_ar, price, original_price, description, description_ar, image_url, sku,
                            in_stock, availability, category_id, brand_id, category, brand)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  await db.execute(sql, [
    newProductId, name, name_ar || null, parseFloat(price), originalPrice ? parseFloat(originalPrice) : null,
    description || null, description_ar || null, image_url || null, sku || null, stockCount, availability,
    categoryResult.id, brandResult.id, category, brand
  ]);

  return {success: true, message: "Product created successfully", productId: newProductId};

}


async function processImagesFolder(productFolderName, imageFolderFiles) {
  const s3Prefix = `${process.env.AWS_S3_PRODUCT_IMAGES_PATH}/${stringManipulation.formatString(productFolderName)}`;
  const results = [];
  _log.debug(`uploading files - ${imageFolderFiles.length} to ${s3Prefix}`)
    for (let file of imageFolderFiles) {
      try {
      const response = await process.driveReader.drive.files.get(
          {fileId: file.id, alt: 'media'},
          {responseType: 'arraybuffer'}
      );

      const buffer = Buffer.from(response.data);

      const params = {
        Bucket: process.env.AWS_S3_BUCKET,
        Key: `${s3Prefix}/${file.name}`,
        Body: buffer,
        ContentType: file.mimeType
      };
      _log.debug(`uploading file - ${file.name} to ${params.Bucket}/${s3Prefix}`)
      const uploadResult = await s3.upload(params).promise();
      _log.debug(`uploading file - ${file.name} to ${params.Bucket}/${s3Prefix} :: success`)
      results.push({
        fileName: file.name,
        s3Url: uploadResult.Location,
        status: 'success'
      });
      } catch (error) {
        _log.warn(`Skipped processing image: ${file.name}`, error);
      }
    }
  return results;
}


export {productDataProcessor}