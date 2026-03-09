import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import * as XLSX from 'xlsx';
import csv from 'csv-parser';

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

/**
 * Reads a file from S3 and extracts a list of IDs
 * Supports both Excel (.xlsx, .xls) and CSV (.csv) files
 * 
 * @param {string} bucket - S3 bucket name
 * @param {string} key - S3 object key (file path)
 * @param {string} columnName - Optional: column name containing IDs (defaults to 'ID' or first column)
 * @returns {Promise<string[]>} Array of IDs from the file
 */
export async function readIdsFromS3(bucket, key, columnName = null) {
  try {
    // Get the file from S3
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    const response = await s3Client.send(command);
    const fileExtension = key.split('.').pop().toLowerCase();

    // Convert stream to buffer
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Parse based on file type
    if (fileExtension === 'csv') {
      return await parseCSV(buffer, columnName);
    } else if (['xlsx', 'xls'].includes(fileExtension)) {
      return await parseExcel(buffer, columnName);
    } else {
      throw new Error(`Unsupported file type: ${fileExtension}. Supported types: csv, xlsx, xls`);
    }
  } catch (error) {
    console.error(`Error reading file from S3 (${bucket}/${key}):`, error);
    throw error;
  }
}

/**
 * Parses a CSV file buffer and extracts IDs
 */
async function parseCSV(buffer, columnName) {
  return new Promise((resolve, reject) => {
    const ids = [];
    const stream = Readable.from(buffer);
    
    stream
      .pipe(csv())
      .on('data', (row) => {
        // If columnName is specified, use it; otherwise use 'ID' or first column
        let id = null;
        if (columnName && row[columnName]) {
          id = row[columnName];
        } else if (row['ID']) {
          id = row['ID'];
        } else if (row['id']) {
          id = row['id'];
        } else {
          // Use first column value
          const firstKey = Object.keys(row)[0];
          id = row[firstKey];
        }
        
        if (id && id.toString().trim() !== '') {
          ids.push(id.toString().trim());
        }
      })
      .on('end', () => {
        resolve(ids);
      })
      .on('error', (error) => {
        reject(error);
      });
  });
}

/**
 * Parses an Excel file buffer and extracts IDs
 */
async function parseExcel(buffer, columnName) {
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    
    // Get the first sheet
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Convert to JSON
    const data = XLSX.utils.sheet_to_json(worksheet);
    
    if (data.length === 0) {
      return [];
    }
    
    // Extract IDs from the specified column or default to 'ID' or first column
    const ids = [];
    for (const row of data) {
      let id = null;
      if (columnName && row[columnName]) {
        id = row[columnName];
      } else if (row['ID']) {
        id = row['ID'];
      } else if (row['id']) {
        id = row['id'];
      } else {
        // Use first column value
        const firstKey = Object.keys(row)[0];
        id = row[firstKey];
      }
      
      if (id && id.toString().trim() !== '') {
        ids.push(id.toString().trim());
      }
    }
    
    return ids;
  } catch (error) {
    console.error('Error parsing Excel file:', error);
    throw error;
  }
}

/**
 * Helper function to read IDs from S3 using environment variables
 * Expects S3_BUCKET and S3_KEY environment variables
 * 
 * @param {string} columnName - Optional: column name containing IDs
 * @returns {Promise<string[]>} Array of IDs from the file
 */
export async function readIdsFromS3Env(columnName = null) {
  const bucket = process.env.S3_BUCKET;
  const key = process.env.S3_KEY;
  
  if (!bucket || !key) {
    throw new Error('S3_BUCKET and S3_KEY environment variables must be set');
  }
  
  return await readIdsFromS3(bucket, key, columnName);
}

