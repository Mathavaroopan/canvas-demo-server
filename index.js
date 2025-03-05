const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const mongoose = require('mongoose');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// AWS S3 SDK modules
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");

// Initialize Express App
const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// Import Mongoose models
const Platform = require('./schemas/Platform');
const User = require('./schemas/User');
const Lock = require('./schemas/Lock');
const Quota = require('./schemas/Quota');

// Configure AWS S3
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});
const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME;

// Use Vercel’s temporary directory for file operations
const TMP_DIR = "/tmp";

// Configure Multer to use memory storage
const upload = multer({ storage: multer.memoryStorage() });

/**
 * Convert MP4 video to HLS format with blackout segments
 */
function createM3U8WithExactSegments(inputPath, blackoutSegments) {
  try {
    const allSegments = [];
    let currentTime = 0;

    blackoutSegments.sort((a, b) => a.startTime - b.startTime);
    blackoutSegments.forEach(seg => {
      if (seg.startTime > currentTime) {
        allSegments.push({ start: currentTime, end: seg.startTime, isBlackout: false });
      }
      allSegments.push({ start: seg.startTime, end: seg.endTime, isBlackout: true });
      currentTime = seg.endTime;
    });

    // Generate .m3u8 playlists
    const normalPlaylistPath = path.join(TMP_DIR, 'output.m3u8');
    fs.writeFileSync(normalPlaylistPath, "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-ENDLIST");

    const blackoutPlaylistPath = path.join(TMP_DIR, 'blackout.m3u8');
    fs.writeFileSync(blackoutPlaylistPath, "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-ENDLIST");

    return { normalPlaylistPath, blackoutPlaylistPath };
  } catch (error) {
    console.error('Error during HLS conversion:', error);
    throw error;
  }
}

/**
 * Upload HLS files to S3
 */
async function uploadHlsFilesToS3(submissionId) {
  const files = fs.readdirSync(TMP_DIR);
  const fileUrlMapping = {};

  for (const file of files) {
    const filePath = path.join(TMP_DIR, file);
    const fileBuffer = fs.readFileSync(filePath);
    const key = `${submissionId}/${file}`;

    const uploadParams = {
      Bucket: BUCKET_NAME,
      Key: key,
      Body: fileBuffer,
      ContentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/MP2T',
    };

    const parallelUploads3 = new Upload({ client: s3Client, params: uploadParams });
    const result = await parallelUploads3.done();
    fileUrlMapping[file] = result.Location;
  }

  return fileUrlMapping;
}

/**
 * API: Upload Video, Convert to HLS, and Create Lock
 */
app.post('/create-lock', upload.single('video'), async (req, res) => {
  try {
    const { platformId, userId, blackoutLocks, folderName } = req.body;
    if (!req.file) throw new Error("No video file provided");

    const inputVideoPath = path.join(TMP_DIR, `${Date.now()}-${req.file.originalname}`);
    fs.writeFileSync(inputVideoPath, req.file.buffer);

    const { normalPlaylistPath, blackoutPlaylistPath } = createM3U8WithExactSegments(inputVideoPath, JSON.parse(blackoutLocks));
    const submissionId = folderName || uuidv4();

    const fileUrlMapping = await uploadHlsFilesToS3(submissionId);
    const updatedNormalUrl = fileUrlMapping['output.m3u8'];
    const updatedBlackoutUrl = fileUrlMapping['blackout.m3u8'];

    fs.unlinkSync(inputVideoPath);

    const newLock = new Lock({
      PlatformID: platformId,
      UserID: userId,
      ContentUrl: updatedNormalUrl,
      LockedContentUrl: updatedBlackoutUrl,
      FolderUrl: `https://${BUCKET_NAME}.s3.amazonaws.com/${submissionId}/`,
      LockJsonObject: JSON.parse(blackoutLocks),
    });

    const savedLock = await newLock.save();
    res.status(201).json({ message: '✅ Lock created successfully', lock: savedLock });

  } catch (err) {
    console.error("❌ Error in /create-lock:", err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

/**
 * API: Get Folder Names from S3
 */
app.get('/get-folder-names', async (req, res) => {
  try {
    const data = await s3Client.send(new ListObjectsV2Command({ Bucket: BUCKET_NAME, Delimiter: '/' }));
    res.status(200).json({ folders: data.CommonPrefixes.map(prefixObj => prefixObj.Prefix) || [] });
  } catch (error) {
    console.error("❌ Error in /get-folder-names:", error);
    res.status(500).json({ error: error.message });
  }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
