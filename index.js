const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const mongoose = require('mongoose');
const { execSync } = require('child_process');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config(); // Loads variables from .env

// AWS S3 SDK modules
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { pipeline } = require("stream");
const { promisify } = require("util");
const streamPipeline = promisify(pipeline);

// Connect to MongoDB using the URI from environment variables.
const connectionString = process.env.MONGO_URI;
mongoose.connect(connectionString, { 
  useNewUrlParser: true, 
  useUnifiedTopology: true 
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => console.error('Error connecting to MongoDB:', err));

// Import Mongoose models from the schemas folder.
const Platform = require('./schemas/Platform');
const User = require('./schemas/User');
const Lock = require('./schemas/Lock');
const Quota = require('./schemas/Quota');

// Configure AWS S3 client.
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});
const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME;

// Configure Multer to use memory storage.
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const app = express();
app.use(cors({
  origin: "http://localhost:5173", // Replace with your frontend URL
  credentials: true, // Allow cookies and credentials
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Serve static files from the hls_output folder.
app.use(express.static(path.join(__dirname, "hls_output")));

// Create a temporary directory for video conversion if it doesn't exist.
const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

// Create a directory for HLS output.
const outputDir = path.join(__dirname, 'hls_output');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

/**
 * Convert an MP4 video (inputPath) to two HLS playlists (normal and blackout)
 * using blackout segments provided by the client.
 * @param {string} inputPath - Path to the MP4 file.
 * @param {Array} blackoutSegments - Array of objects { startTime, endTime } (in seconds)
 * @returns {Object} - { normalPlaylistPath, blackoutPlaylistPath }
 */
function createM3U8WithExactSegments(inputPath, blackoutSegments) {
  try {
    // Convert client-provided segments into our expected format.
    const customSegments = blackoutSegments.map(seg => ({
      start: Number(seg.startTime),
      end: Number(seg.endTime)
    }));
    
    // 1. Get video duration.
    const durationOutput = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`
    ).toString().trim();
    const totalDuration = parseFloat(durationOutput);
    console.log(`Video duration: ${totalDuration} seconds`);
    if (!totalDuration || isNaN(totalDuration)) {
      throw new Error('Failed to get video duration');
    }

    // 1.1. Get video resolution (e.g., "1920x1080").
    const resolutionOutput = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${inputPath}"`
    ).toString().trim();
    console.log(`Video resolution: ${resolutionOutput}`);

    // 2. Build list of segments.
    const allSegments = [];
    let currentTime = 0;
    customSegments.sort((a, b) => a.start - b.start);
    for (const customSeg of customSegments) {
      if (customSeg.start > currentTime) {
        allSegments.push({ start: currentTime, end: customSeg.start, isBlackout: false });
      }
      allSegments.push({ start: customSeg.start, end: customSeg.end, isBlackout: true });
      currentTime = customSeg.end;
    }
    if (currentTime < totalDuration) {
      allSegments.push({ start: currentTime, end: totalDuration, isBlackout: false });
    }

    // 3. Extract each segment as a .ts file.
    console.log('Extracting segments:');
    allSegments.forEach((segment, index) => {
      const segmentPath = path.join(outputDir, `segment_${String(index).padStart(3, '0')}.ts`);
      const segDuration = segment.end - segment.start;
      console.log(`Segment ${index}: ${segment.start}s to ${segment.end}s (${segDuration}s)`);
      execSync(
        `ffmpeg -y -i "${inputPath}" -ss ${segment.start} -to ${segment.end} ` +
        `-c:v libx264 -c:a aac -f mpegts "${segmentPath}"`
      );
    });

    // 4. Create the normal playlist (output.m3u8).
    const normalPlaylist = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...allSegments.map(s => s.end - s.start)))}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD'
    ];
    allSegments.forEach((segment, index) => {
      const segDuration = segment.end - segment.start;
      normalPlaylist.push(`#EXTINF:${segDuration.toFixed(6)},`);
      normalPlaylist.push(`segment_${String(index).padStart(3, '0')}.ts`);
    });
    normalPlaylist.push('#EXT-X-ENDLIST');
    const normalPlaylistPath = path.join(outputDir, 'output.m3u8');
    fs.writeFileSync(normalPlaylistPath, normalPlaylist.join('\n'));
    console.log('Generated normal M3U8 playlist:', normalPlaylistPath);

    // 5. For blackout segments, generate blackout .ts files.
    allSegments.forEach((segment, index) => {
      if (segment.isBlackout) {
        const blackoutPath = path.join(outputDir, `blackout_${String(index).padStart(3, '0')}.ts`);
        const segDuration = segment.end - segment.start;
        console.log(`Generating blackout segment ${index}: duration ${segDuration}s`);
        execSync(
          `ffmpeg -y -f lavfi -i color=c=black:s=${resolutionOutput}:r=30 ` +
          `-f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 ` +
          `-t ${segDuration} -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest ` +
          `-f mpegts "${blackoutPath}"`
        );
      }
    });

    // 6. Create the blackout playlist (blackout.m3u8).
    const blackoutPlaylist = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...allSegments.map(s => s.end - s.start)))}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD'
    ];
    allSegments.forEach((segment, index) => {
      const segDuration = segment.end - segment.start;
      blackoutPlaylist.push(`#EXTINF:${segDuration.toFixed(6)},`);
      if (segment.isBlackout) {
        blackoutPlaylist.push(`blackout_${String(index).padStart(3, '0')}.ts`);
      } else {
        blackoutPlaylist.push(`segment_${String(index).padStart(3, '0')}.ts`);
      }
    });
    blackoutPlaylist.push('#EXT-X-ENDLIST');
    const blackoutPlaylistPath = path.join(outputDir, 'blackout.m3u8');
    fs.writeFileSync(blackoutPlaylistPath, blackoutPlaylist.join('\n'));
    console.log('Generated blackout M3U8 playlist:', blackoutPlaylistPath);

    return { normalPlaylistPath, blackoutPlaylistPath };

  } catch (error) {
    console.error('Error during HLS conversion:', error.message);
    if (error.stderr) console.error(error.stderr.toString());
    throw error;
  }
}

/**
 * Uploads all files in the output directory to S3 under a folder named submissionId.
 * Returns a mapping from local file names to S3 URLs.
 */
async function uploadHlsFilesToS3(submissionId) {
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
 * Update a playlist file's content to replace segment filenames with their corresponding S3 URLs.
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

// Function to upload file buffer to S3.
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

// Endpoint to handle video upload, conversion using client-provided blackout segments, and lock creation.
app.post('/create-lock', upload.single('video'), async (req, res) => {
  try {
    const { platformId, userId, contentId, contentUrl, blackoutLocks, folderName } = req.body;
    console.log(req.body);
    console.log("\n\n\n\n\nfoldername:" + folderName);
    const parsedBlackoutLocks = JSON.parse(blackoutLocks);

    if (!req.file) throw new Error("No video file provided");
    const inputVideoPath = path.join(TMP_DIR, `${Date.now()}-${req.file.originalname}`);
    console.log("Input video path:", inputVideoPath);
    fs.writeFileSync(inputVideoPath, req.file.buffer);

    const { normalPlaylistPath, blackoutPlaylistPath } = createM3U8WithExactSegments(inputVideoPath, parsedBlackoutLocks);

    // Use provided folderName if available; otherwise, generate a new one.
    let submissionId;
    if (folderName && typeof folderName === 'string' && folderName.trim() !== "") {
      // Normalize folder name - remove leading/trailing slashes
      submissionId = folderName.trim().replace(/^\/+|\/+$/g, '');
      console.log(`Using provided folder name: ${submissionId}`);
    } else {
      submissionId = uuidv4();
      console.log(`No valid folder name provided, generated UUID: ${submissionId}`);
    }

    const folderUrl = `https://${BUCKET_NAME}.s3.amazonaws.com/${submissionId}/`;
    console.log("Folder url final: " + folderUrl);
    // Upload all files from the HLS output directory to S3 under submissionId.
    const fileUrlMapping = await uploadHlsFilesToS3(submissionId);

    const updatedNormalPlaylist = updatePlaylistContent(normalPlaylistPath, fileUrlMapping);
    const updatedBlackoutPlaylist = updatePlaylistContent(blackoutPlaylistPath, fileUrlMapping);

    const updatedNormalKey = `${submissionId}/output.m3u8`;
    const updatedBlackoutKey = `${submissionId}/blackout.m3u8`;
    const updatedNormalUrl = await uploadToS3(Buffer.from(updatedNormalPlaylist, 'utf8'), updatedNormalKey, "application/vnd.apple.mpegurl");
    const updatedBlackoutUrl = await uploadToS3(Buffer.from(updatedBlackoutPlaylist, 'utf8'), updatedBlackoutKey, "application/vnd.apple.mpegurl");

    fs.unlinkSync(inputVideoPath);

    const newLock = new Lock({
      PlatformID: platformId,
      UserID: userId,
      ContentUrl: updatedNormalUrl,
      LockedContentUrl: updatedBlackoutUrl,
      FolderUrl: folderUrl,
      LockJsonObject: parsedBlackoutLocks,
    });

    const savedLock = await newLock.save();
    res.status(201).json({ message: 'Lock created successfully', lock: savedLock });
  } catch (err) {
    console.error("Error in /create-lock:", err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

/**
 * GET /download-folder
 * Given a folder prefix (folderUrl) from S3 (e.g., "submissionId/"), download all files from that folder
 * and store them in the local outputDir.
 * Example request: GET /download-folder?folderPrefix=362d2d1e-9e77-437f-b400-cb5043d39ef2/
 */
app.get('/download-folder', async (req, res) => {
  try {
    const folderPrefix = req.query.folderPrefix;
    console.log("Download folder with prefix:", folderPrefix);
    if (!folderPrefix) {
      return res.status(400).json({ error: "folderPrefix query parameter is required." });
    }

    // **Recreate an empty `hls_output` folder**
    fs.mkdirSync(outputDir, { recursive: true });
    console.log("Created new hls_output folder.");


    const listParams = {
      Bucket: BUCKET_NAME,
      Prefix: folderPrefix,
    };
    const listCommand = new ListObjectsV2Command(listParams);
    const data = await s3Client.send(listCommand);
    if (!data.Contents || data.Contents.length === 0) {
      return res.status(404).json({ error: "No files found in the specified folder." });
    }

    const downloadedFiles = [];
    // Construct the URL prefix to remove from m3u8 files.
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

      // If the downloaded file is an m3u8 playlist, remove the S3 URL prefix.
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
    res.status(200).json({ message: "Files downloaded successfully", files: downloadedFiles });
  } catch (error) {
    console.error("Error in /download-folder:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /get-folder-names
 * List folder names (common prefixes) in the S3 bucket.
 * Example request: GET /get-folder-names
 */
app.get('/get-folder-names', async (req, res) => {
  try {
    console.log("Getting the folders");
    const listParams = {
      Bucket: BUCKET_NAME,
      Delimiter: '/'
    };
    const listCommand = new ListObjectsV2Command(listParams);
    const data = await s3Client.send(listCommand);
    const folders = data.CommonPrefixes ? data.CommonPrefixes.map(prefixObj => prefixObj.Prefix) : [];
    res.status(200).json({ folders });
  } catch (error) {
    console.error("Error in /get-folder-names:", error);
    res.status(500).json({ error: error.message });
  }
});

// Start the Express server on port 3000.
const PORT = 4000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});