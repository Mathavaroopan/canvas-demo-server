// ====================
// AWS S3 OPERATIONS MODULE
// ====================
const fs = require('fs');
const path = require('path');
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { pipeline } = require("stream");
const { promisify } = require("util");
const streamPipeline = promisify(pipeline);
require('dotenv').config();

const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME;

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

/**
 * Uploads a file buffer to S3.
 * @param {Buffer} fileBuffer - Buffer containing the file data.
 * @param {string} key - The S3 key (path) under which to store the file.
 * @param {string} contentType - MIME type of the file.
 * @returns {Promise<string>} - URL of the uploaded file.
 */
async function uploadToS3(fileBuffer, key, contentType) {
  try {
    const uploadParams = {
      Bucket: BUCKET_NAME,
      Key: key,
      Body: fileBuffer,
      ContentType: contentType,
    };
    const parallelUploads3 = new Upload({
      client: s3Client,
      params: uploadParams,
    });
    const result = await parallelUploads3.done();
    return result.Location || `https://${BUCKET_NAME}.s3.amazonaws.com/${key}`;
  } catch (error) {
    console.error("S3 upload error:", error);
    throw error;
  }
}

/**
 * Uploads all files in the given output directory to S3 under a folder named submissionId.
 * @param {string} submissionId - Folder name (typically the contentId).
 * @param {string} outputDir - Directory where output files are located.
 * @returns {Promise<Object>} - Mapping of local file names to their S3 URLs.
 */
async function uploadHlsFilesToS3(submissionId, outputDir) {
  const files = fs.readdirSync(outputDir);
  const fileUrlMapping = {};
  for (const file of files) {
    const filePath = path.join(outputDir, file);
    const fileBuffer = fs.readFileSync(filePath);
    let contentType = 'application/octet-stream';
    if (file.endsWith('.m3u8')) {
      contentType = 'application/vnd.apple.mpegurl';
    } else if (file.endsWith('.ts')) {
      contentType = 'video/MP2T';
    }
    const key = `${submissionId}/${file}`;
    const url = await uploadToS3(fileBuffer, key, contentType);
    fileUrlMapping[file] = url;
  }
  return fileUrlMapping;
}

/**
 * Updates a playlist file's content to replace local segment filenames with their corresponding S3 URLs.
 * @param {string} playlistPath - Path to the local playlist file.
 * @param {Object} fileUrlMapping - Mapping of segment file names to S3 URLs.
 * @returns {string} - The updated playlist content.
 */
function updatePlaylistContent(playlistPath, fileUrlMapping) {
  let content = fs.readFileSync(playlistPath, 'utf8');
  const lines = content.split('\n').map(line => {
    const trimmed = line.trim();
    if (trimmed.endsWith('.ts') && fileUrlMapping[trimmed]) {
      return fileUrlMapping[trimmed];
    }
    return line;
  });
  return lines.join('\n');
}

/**
 * Downloads all files from S3 under the given folder prefix and saves them to the local output directory.
 * For m3u8 files, removes the S3 URL prefix from their contents.
 * @param {string} folderPrefix - The folder prefix in the S3 bucket.
 * @param {string} outputDir - The local output directory.
 * @returns {Promise<Array>} - Array of objects { key, localFilePath } for each downloaded file.
 */
async function downloadFolderFromS3(folderPrefix, outputDir) {
  // Recreate an empty output directory.
  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outputDir, { recursive: true });
  console.log("Created new output directory.");

  const listParams = {
    Bucket: BUCKET_NAME,
    Prefix: folderPrefix,
  };
  const listCommand = new ListObjectsV2Command(listParams);
  const data = await s3Client.send(listCommand);
  if (!data.Contents || data.Contents.length === 0) {
    throw new Error("No files found in the specified folder.");
  }
  const downloadedFiles = [];
  const s3UrlPrefix = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${folderPrefix}`;
  for (const object of data.Contents) {
    const key = object.Key;
    if (key.endsWith('/')) continue;
    const getObjectParams = { Bucket: BUCKET_NAME, Key: key };
    const getObjectCommand = new GetObjectCommand(getObjectParams);
    const response = await s3Client.send(getObjectCommand);
    const relativePath = key.substring(folderPrefix.length);
    const localFilePath = path.join(outputDir, relativePath);
    const localDir = path.dirname(localFilePath);
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    await streamPipeline(response.Body, fs.createWriteStream(localFilePath));
    if (localFilePath.endsWith('.m3u8')) {
      let m3u8Content = fs.readFileSync(localFilePath, 'utf8');
      m3u8Content = m3u8Content
        .split('\n')
        .map(line => line.startsWith(s3UrlPrefix) ? line.replace(s3UrlPrefix, '') : line)
        .join('\n');
      fs.writeFileSync(localFilePath, m3u8Content);
    }
    downloadedFiles.push({ key, localFilePath });
  }
  return downloadedFiles;
}

/**
 * Retrieves folder names (common prefixes) from the S3 bucket.
 * @returns {Promise<Array>} - Array of folder prefixes.
 */
async function getFolderNamesFromS3() {
  console.log("Getting the folders");
  const listParams = {
    Bucket: BUCKET_NAME,
    Delimiter: '/'
  };
  const listCommand = new ListObjectsV2Command(listParams);
  const data = await s3Client.send(listCommand);
  const folders = data.CommonPrefixes ? data.CommonPrefixes.map(prefixObj => prefixObj.Prefix) : [];
  return folders;
}

module.exports = {
  uploadToS3,
  uploadHlsFilesToS3,
  updatePlaylistContent,
  downloadFolderFromS3,
  getFolderNamesFromS3,
  s3Client // optional export
};
