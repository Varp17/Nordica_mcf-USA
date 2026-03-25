import fs from 'fs';
import {google} from 'googleapis';

// Load credentials
import credentials from '../config/google.credentials.json' with {type: 'json'};
import logger from "../utils/logger.js";
const _log = logger.child({module: 'googleSheetsReader'});

const {client_id, client_secret, redirect_uris} = credentials.web || credentials.installed;

const TOKEN_PATH = process.env.GOOGLE_DRIVE_TOKEN_PATH || 'tokens/google.token.json';

class GoogleSheetsReader {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirect_uris[0]
    );
    this.sheetsAPI = null;
  }

  async getSheetsData(spreadsheetId) {
    try {
      const response = await this.sheetsAPI.spreadsheets.values.get({
        spreadsheetId,
        range: 'Sheet1',
      });
      const rows = response.data.values;

      if (!rows || rows.length === 0) {
        _log.warn("No data found.");
      } else {
        _log.debug("Raw rows:", rows.length);
      }
      const [header, ...dataRows] = rows;
      const jsonData = dataRows.map(row => {
        let obj = {};
        header.forEach((col, i) => {
          obj[col] = row[i] || null;  // handle missing cells
        });
        return obj;
      });
      return jsonData;
    }catch (error) {
      _log.error('Error getting sheets data:', error.message);
      throw error;
    }
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

    // Initialize Sheets API
    this.sheetsAPI = google.sheets({version: 'v4', auth: this.oauth2Client});

    _log.info('✅ Google Sheets API initialized');
  }


}

export {GoogleSheetsReader}