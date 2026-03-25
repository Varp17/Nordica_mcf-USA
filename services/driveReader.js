import fs from 'fs';
import {google} from 'googleapis';

// Load credentials
import credentials from '../config/google.credentials.json' with {type: 'json'};

import logger from '../utils/logger.js';
const _log = logger.child({module: 'driveReader'});
_log.transports.forEach(t => (t.level = process.env.DRIVE_READER_LOG_LEVEL || 'debug'));

const {client_id, client_secret, redirect_uris} = credentials.web || credentials.installed;

const TOKEN_PATH = process.env.GOOGLE_DRIVE_TOKEN_PATH || 'tokens/google.token.json';

class GoogleDriveReader {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirect_uris[0]
    );
    this.drive = null;
  }

  async initialize() {
    // Check if token file exists
    if (!fs.existsSync(TOKEN_PATH)) {
      _log.error("Token file not found. Please run 'node authorize.js' first.");
    }

    // Load tokens
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH));
    this.oauth2Client.setCredentials(tokens);

    // Set up automatic token refresh
    this.oauth2Client.on('tokens', (newTokens) => {
      _log.info('🔄 Tokens refreshed automatically');

      // Merge new tokens with existing ones
      const currentTokens = JSON.parse(fs.readFileSync(TOKEN_PATH));
      const updatedTokens = {...currentTokens, ...newTokens};

      // Save updated tokens
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(updatedTokens, null, 2));
    });

    // Initialize Drive API
    this.drive = google.drive({version: 'v3', auth: this.oauth2Client});

    _log.info('✅ Google Drive client initialized');
  }

  // List files

  async getFolderInfo(rootFolder , folderName = null) {
    try {
      const res = await this.drive.files.list({
        q: `'${rootFolder}' in parents and mimeType = 'application/vnd.google-apps.folder' and name = '${folderName}' and trashed = false`,
        fields: "files(id, name)"
      });

      if (res.data.files.length === 0) {
        _log.debug("Parent folder not found");
        return;
      }
      return res.data.files[0];
    } catch (error) {
      console.error('Error listing files:', error.message);
      throw error;
    }
  }

  async listFiles(parentId , pageSize = 10) {
    try {
      const queryParams = {
        pageSize,
        fields: 'nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, size)',
        q: `'${parentId}' in parents and trashed = false`
      };

      const response = await this.drive.files.list(queryParams);

      const files = response.data.files;

      if (files.length === 0) {
        _log.debug('No files found.');
        return [];
      }

      _log.debug('\n📁 Files in your Drive:');
      files.forEach((file) => {
        _log.debug(`  • ${file.name} (${file.mimeType})`);
      });

      return files;
    } catch (error) {
      console.error('Error listing files:', error.message);
      throw error;
    }
  }

  // Get file metadata
  async getFileMetadata(fileId) {
    try {
      const response = await this.drive.files.get({
        fileId,
        fields: 'id, name, mimeType, size, createdTime, modifiedTime, owners, webViewLink',
      });

      return response.data;
    } catch (error) {
      console.error('Error getting file metadata:', error.message);
      throw error;
    }
  }

  // Download file
  async downloadFile(fileId, destPath) {
    try {
      const dest = fs.createWriteStream(destPath);

      const response = await this.drive.files.get(
          {fileId, alt: 'media'},
          {responseType: 'stream'}
      );

      return new Promise((resolve, reject) => {
        response.data
            .on('end', () => {
              _log.debug(`✅ File downloaded to ${destPath}`);
              resolve();
            })
            .on('error', reject)
            .pipe(dest);
      });
    } catch (error) {
      console.error('Error downloading file:', error.message);
      throw error;
    }
  }

  // Read text file content
  async readFileContent(fileId) {
    try {
      const response = await this.drive.files.get(
          {fileId, alt: 'media'},
          {responseType: 'text'}
      );

      return response.data;
    } catch (error) {
      console.error('Error reading file:', error.message);
      throw error;
    }
  }

  // Search files
  async searchFiles(query) {
    try {
      const response = await this.drive.files.list({
        q: query,
        fields: 'files(id, name, mimeType, modifiedTime)',
      });

      return response.data.files;
    } catch (error) {
      console.error('Error searching files:', error.message);
      throw error;
    }
  }

  // List files in folder
  async listFilesInFolder(folderId) {
    try {
      const response = await this.drive.files.list({
        q: `'${folderId}' in parents`,
        fields: 'files(id, name, mimeType)',
      });

      return response.data.files;
    } catch (error) {
      console.error('Error listing folder contents:', error.message);
      throw error;
    }
  }
}

// Example usage
async function initializeDriveClient() {
  const reader = new GoogleDriveReader();

  try {
    await reader.initialize();
    return reader;
    // List files
    // await reader.listFiles(10);

    // Example: Get specific file (uncomment and add your file ID)
    // const fileId = 'YOUR_FILE_ID_HERE';
    // const metadata = await reader.getFileMetadata(fileId);
    // _log.debug('\n📄 File metadata:', metadata);

    // Download file
    // await reader.downloadFile(fileId, './downloaded-file.pdf');

    // Search files
    // const results = await reader.searchFiles("name contains 'report'");
    // _log.debug('\n🔍 Search results:', results);

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

export {GoogleDriveReader}