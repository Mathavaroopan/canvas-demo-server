const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const mongoose = require('mongoose');
const { execSync } = require('child_process');
const fs = require('fs');
const { createProxyMiddleware } = require("http-proxy-middleware");
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// AWS S3 SDK modules
const { 
  S3Client, 
  ListObjectsV2Command, 
  GetObjectCommand, 
  DeleteObjectsCommand 
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { pipeline } = require("stream");
const { promisify } = require("util");
const streamPipeline = promisify(pipeline);

// Connect to MongoDB.
const connectionString = process.env.MONGO_URI;
mongoose.connect(connectionString, { 
  useNewUrlParser: true, 
  useUnifiedTopology: true 
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => console.error('Error connecting to MongoDB:', err));

// Import Mongoose models.
const Platform = require('./schemas/Platform');
const User = require('./schemas/User');
const Lock = require('./schemas/Lock');
const Quota = require('./schemas/Quota');

// Configure AWS S3 client using environment variables (for endpoints that rely on them).
const s3ClientEnv = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});
const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME;

// Configure Multer for file uploads.
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const app = express();
app.use(cors({
  origin: ["http://localhost:5173", "https://canvas-demo-client.vercel.app/"],
  credentials: true,
}));
app.use(
  "/api",
  createProxyMiddleware({
    target: "http://54.90.83.226:4000",
    changeOrigin: true,
    secure: false,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Serve static files from the hls_output folder.
app.use(express.static(path.join(__dirname, "hls_output")));

// Create directories for temporary and HLS output.
const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}
const outputDir = path.join(__dirname, 'hls_output');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

/**
 * Convert an MP4 video to two HLS playlists (normal and blackout)
 * using provided blackout segments.
 * Returns: { normalPlaylistPath, blackoutPlaylistPath }
 */
function createM3U8WithExactSegments(inputPath, blackoutSegments) {
  try {
    const customSegments = blackoutSegments.map(seg => ({
      start: Number(seg.startTime),
      end: Number(seg.endTime)
    }));
    
    // Get video duration.
    const durationOutput = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`
    ).toString().trim();
    const totalDuration = parseFloat(durationOutput);
    console.log(`Video duration: ${totalDuration} seconds`);
    if (!totalDuration || isNaN(totalDuration)) {
      throw new Error('Failed to get video duration');
    }
    
    // Get video resolution.
    const resolutionOutput = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${inputPath}"`
    ).toString().trim();
    console.log(`Video resolution: ${resolutionOutput}`);
    
    // Build list of segments.
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
    
    // Extract each segment as a .ts file.
    console.log('Extracting segments:');
    allSegments.forEach((segment, index) => {
      const segmentPath = path.join(outputDir, `segment_${String(index).padStart(3, '0')}.ts`);
      const segDuration = segment.end - segment.start;
      console.log(`Segment ${index}: ${segment.start}s to ${segment.end}s (${segDuration}s)`);
      execSync(
        `ffmpeg -y -i "${inputPath}" -ss ${segment.start} -to ${segment.end} -c:v libx264 -c:a aac -f mpegts "${segmentPath}"`
      );
    });
    
    // Create the normal playlist.
    const maxDuration = Math.ceil(Math.max(...allSegments.map(s => s.end - s.start)));
    const normalPlaylist = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${maxDuration}`,
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
    
    // Generate blackout .ts files.
    allSegments.forEach((segment, index) => {
      if (segment.isBlackout) {
        const blackoutPath = path.join(outputDir, `blackout_${String(index).padStart(3, '0')}.ts`);
        const segDuration = segment.end - segment.start;
        console.log(`Generating blackout segment ${index}: duration ${segDuration}s`);
        execSync(
          `ffmpeg -y -f lavfi -i color=c=black:s=${resolutionOutput}:r=30 -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 -t ${segDuration} -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest -f mpegts "${blackoutPath}"`
        );
      }
    });
    
    // Create the blackout playlist.
    const blackoutPlaylist = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${maxDuration}`,
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
 * Uploads all files in the output directory to S3 under the given prefix.
 * Returns a mapping from local file names to S3 URLs.
 */
async function uploadHlsFilesToS3(s3Client, bucketName, prefix) {
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
    const key = `${prefix}${file}`;
    const url = await uploadToS3(s3Client, fileBuffer, bucketName, key, contentType);
    fileUrlMapping[file] = url;
  }
  return fileUrlMapping;
}

/**
 * Updates a playlist file's content by replacing local segment filenames with their corresponding S3 URLs.
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
 * Uploads a file buffer to S3.
 */
async function uploadToS3(s3Client, fileBuffer, bucketName, key, contentType) {
  try {
    const uploadParams = {
      Bucket: bucketName,
      Key: key,
      Body: fileBuffer,
      ContentType: contentType,
    };
    const parallelUploads3 = new Upload({
      client: s3Client,
      params: uploadParams,
    });
    const result = await parallelUploads3.done();
    return result.Location || `https://${bucketName}.s3.amazonaws.com/${key}`;
  } catch (error) {
    console.error("S3 upload error:", error);
    throw error;
  }
}

app.post('/get-video-names', async (req, res) => {
    try {
      const { awsData } = req.body;
      // If folderPrefix is not provided at top-level, try to get it from awsData.
      const folderPrefix = req.body.folderPrefix || awsData.folderPrefix;
      if (!awsData) {
        return res.status(400).json({ message: "Missing awsData in request body." });
      }
      const { awsAccessKeyId, awsSecretAccessKey, awsRegion, awsBucketName } = awsData;
      if (!awsAccessKeyId || !awsSecretAccessKey || !awsRegion || !awsBucketName) {
        return res.status(400).json({ message: "Invalid or missing AWS data." });
      }
      if (!folderPrefix) {
        return res.status(400).json({ message: "Missing folderPrefix in request body." });
      }
      const prefix = folderPrefix.endsWith('/') ? folderPrefix : folderPrefix + '/';
      const s3Client = new S3Client({
        region: awsRegion,
        credentials: {
          accessKeyId: awsAccessKeyId,
          secretAccessKey: awsSecretAccessKey
        }
      });
      const listParams = {
        Bucket: awsBucketName,
        Delimiter: '/',
        Prefix: prefix
      };
      const command = new ListObjectsV2Command(listParams);
      const data = await s3Client.send(command);
      let folders = [];
      if (data.CommonPrefixes) {
        folders = data.CommonPrefixes.map((p) => p.Prefix);
      }
      return res.status(200).json({ folders });
    } catch (error) {
      console.error("Error in /get-folder-names-from-json:", error);
      return res.status(500).json({ message: error.message });
    }
  });

/**
 * GET /get-lockjsonobject/:lockId
 * Returns the LockJsonObject for the given lock id.
 */
app.get('/get-lockjsonobject/:lockId', async (req, res) => {
    try {
      const { lockId } = req.params;
      const lock = await Lock.findOne({ _id: lockId });
      if (!lock) {
        return res.status(404).json({ message: "Lock not found." });
      }
      return res.status(200).json({ lockJsonObject: lock.LockJsonObject });
    } catch (error) {
      console.error("Error in /get-lockjsonobject:", error);
      return res.status(500).json({ message: error.message });
    }
  });
  
  app.get('/get-lock-by-contentid/:contentId', async (req, res) => {
    try {
      const { contentId } = req.params;
      // Find the lock document using LockJsonObject.contentId field.
      const lock = await Lock.findOne({ "LockJsonObject.contentId": contentId });
      if (!lock) {
        return res.status(404).json({ message: "Lock not found." });
      }
      return res.status(200).json({ lock });
    } catch (error) {
      console.error("Error in /get-lock-by-contentid:", error);
      return res.status(500).json({ message: error.message });
    }
  });

/**
 * POST /create-lock-from-json
 * Expects: {
 *   awsData: { awsAccessKeyId, awsSecretAccessKey, awsRegion, awsBucketName, awsOriginalKey, awsDestinationFolder },
 *   platformId, userId, contentId, blackoutLocks
 * }
 * Creates a subfolder (named after contentId) inside awsDestinationFolder and uploads the processed HLS files.
 * Now also returns the generated lock id.
 */
app.post('/create-AES', async (req, res) => {
  try {
    const {
      awsData,
      platformId,
      userId,
      contentId,
      blackoutLocks
    } = req.body || {};
    
    if (!awsData) {
      return res.status(400).json({ message: "Missing awsData in request body." });
    }
    const {
      awsAccessKeyId,
      awsSecretAccessKey,
      awsRegion,
      awsBucketName,
      awsOriginalKey,
      awsDestinationFolder
    } = awsData;
    
    if (!awsAccessKeyId || !awsSecretAccessKey) {
      return res.status(400).json({ message: "Missing AWS credentials." });
    }
    if (!awsBucketName || !awsOriginalKey || !awsDestinationFolder) {
      return res.status(400).json({ message: "Missing bucketName/originalKey/destinationFolder." });
    }
    if (!contentId) {
      return res.status(400).json({ message: "Missing contentId." });
    }
    
    const s3Client = new S3Client({
      region: awsRegion,
      credentials: {
        accessKeyId: awsAccessKeyId,
        secretAccessKey: awsSecretAccessKey
      }
    });
    
    // Download the original MP4 to local temp.
    const getCommand = new GetObjectCommand({
      Bucket: awsBucketName,
      Key: awsOriginalKey,
    });
    const data = await s3Client.send(getCommand);
    const localMp4Path = path.join(TMP_DIR, `${Date.now()}-original.mp4`);
    await streamPipeline(data.Body, fs.createWriteStream(localMp4Path));
    
    // Process the video into HLS playlists.
    const { normalPlaylistPath, blackoutPlaylistPath } = createM3U8WithExactSegments(
      localMp4Path,
      blackoutLocks || []
    );
    
    // Create a subfolder named after contentId inside awsDestinationFolder.
    const baseFolder = awsDestinationFolder.endsWith('/') ? awsDestinationFolder : awsDestinationFolder + '/';
    const uniqueSubfolder = baseFolder + contentId + '/';
    
    // Upload HLS files to the unique subfolder.
    const fileUrlMapping = await uploadHlsFilesToS3(
      s3Client,
      awsBucketName,
      uniqueSubfolder
    );
    
    // Update the M3U8 playlists to use S3 URLs.
    const updatedNormalPlaylist = updatePlaylistContent(normalPlaylistPath, fileUrlMapping);
    const updatedBlackoutPlaylist = updatePlaylistContent(blackoutPlaylistPath, fileUrlMapping);
    
    // Upload the updated playlists.
    const finalNormalKey = uniqueSubfolder + 'output.m3u8';
    const finalBlackoutKey = uniqueSubfolder + 'blackout.m3u8';
    const normalUrl = await uploadToS3(
      s3Client,
      Buffer.from(updatedNormalPlaylist, 'utf8'),
      awsBucketName,
      finalNormalKey,
      'application/vnd.apple.mpegurl'
    );
    const blackoutUrl = await uploadToS3(
      s3Client,
      Buffer.from(updatedBlackoutPlaylist, 'utf8'),
      awsBucketName,
      finalBlackoutKey,
      'application/vnd.apple.mpegurl'
    );
    
    // Clean up local files.
    fs.unlinkSync(localMp4Path);
    const hlsFiles = fs.readdirSync(outputDir);
    for (const file of hlsFiles) {
      fs.unlinkSync(path.join(outputDir, file));
    }
    
    // (Optional) Save record in the database.
    const lockId = uuidv4();
    const lockJsonObject = {
      lockId,
      originalcontentUrl: `https://${awsBucketName}.s3.${awsRegion}.amazonaws.com/${awsOriginalKey}`,
      contentId,
      lockedcontenturl: blackoutUrl,
      locks: {
        "replacement-video-locks": [],
        "image-locks": [],
        "blackout-locks": (blackoutLocks || []).map(lock => ({
          bl_id: uuidv4(),
          startTime: Number(lock.startTime),
          endTime: Number(lock.endTime)
        }))
      }
    };
    
    const newLock = new Lock({
      PlatformID: platformId,
      UserID: userId,
      OriginalContentUrl: lockJsonObject.originalcontentUrl,
      LockedContentUrl: blackoutUrl,
      LockJsonObject: lockJsonObject
    });
    const savedLock = await newLock.save();
    
    return res.status(201).json({
      message: 'Lock created successfully',
      lock_id: lockJsonObject.lockId,
      normalUrl,
      blackoutUrl
    });
  } catch (error) {
    console.error("Error in /create-lock-from-json:", error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
});

/**
 * POST /download-folder-from-json
 * Expects: { awsData, folderPrefix }
 * Downloads all files from the given S3 folder into the local hls_output directory.
 */
app.post('/download-video', async (req, res) => {
  try {
    const { awsData, folderPrefix } = req.body;
    const s3Client = new S3Client({
      region: awsData.awsRegion,
      credentials: {
        accessKeyId: awsData.awsAccessKeyId,
        secretAccessKey: awsData.awsSecretAccessKey
      }
    });
    
    // Recreate (or clean) the output directory.
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir);
    } else {
      const oldFiles = fs.readdirSync(outputDir);
      for (const file of oldFiles) {
        fs.unlinkSync(path.join(outputDir, file));
      }
    }
    
    // List objects in the given folderPrefix.
    const listParams = {
      Bucket: awsData.awsBucketName,
      Prefix: folderPrefix
    };
    const listCommand = new ListObjectsV2Command(listParams);
    const data = await s3Client.send(listCommand);
    if (!data.Contents || data.Contents.length === 0) {
      return res.status(404).json({ message: "No files found in that prefix." });
    }
    
    // Download each file.
    const s3UrlPrefix = `https://${awsData.awsBucketName}.s3.${awsData.awsRegion}.amazonaws.com/${folderPrefix}`;
    for (const obj of data.Contents) {
      if (obj.Key.endsWith('/')) continue;
      const getObjectParams = { Bucket: awsData.awsBucketName, Key: obj.Key };
      const getObjectCommand = new GetObjectCommand(getObjectParams);
      const fileResponse = await s3Client.send(getObjectCommand);
      
      const relative = obj.Key.substring(folderPrefix.length);
      const localFilePath = path.join(outputDir, relative);
      await streamPipeline(fileResponse.Body, fs.createWriteStream(localFilePath));
      
      // If the file is an m3u8 playlist, remove the S3 URL prefix.
      if (localFilePath.endsWith('.m3u8')) {
        let content = fs.readFileSync(localFilePath, 'utf-8');
        content = content
          .split('\n')
          .map(line => {
            if (line.startsWith(s3UrlPrefix)) {
              return line.replace(s3UrlPrefix, '');
            }
            return line;
          })
          .join('\n');
        fs.writeFileSync(localFilePath, content);
      }
    }
    
    return res.json({ message: "Folder downloaded successfully" });
  } catch (error) {
    console.error("Error in /download-folder-from-json:", error);
    return res.status(500).json({ message: error.message });
  }
});

/**
 * POST /modify-AES
 * Expects a JSON body with:
 * {
 *   lockId,
 *   awsData: {
 *     awsAccessKeyId,
 *     awsSecretAccessKey,
 *     awsRegion,
 *     awsBucketName,
 *     awsDestinationFolder
 *   },
 *   newBlackoutLocks: [ { startTime, endTime }, ... ]
 * }
 * 
 * This endpoint fetches the existing lock record, downloads the original video from S3 (inferring the original key from the stored URL),
 * re-processes it with the new blackout lock timings (using createM3U8WithExactSegments),
 * deletes the old folder content in S3,
 * uploads the new HLS files, and then updates the lock record with the new blackout locks and locked content URL.
 */
app.post('/modify-AES', async (req, res) => {
    try {
      // Expect awsData, lockId, newBlackoutLocks and folder in the payload.
      const { awsData, lockId, newBlackoutLocks, folder } = req.body;
      console.log("Lock ID:", lockId);
      if (!awsData || !lockId || !newBlackoutLocks || !folder) {
        return res.status(400).json({ message: "Missing required fields." });
      }
      const { awsAccessKeyId, awsSecretAccessKey, awsRegion, awsBucketName } = awsData;
      if (!awsAccessKeyId || !awsSecretAccessKey || !awsRegion || !awsBucketName) {
        return res.status(400).json({ message: "Missing required AWS data." });
      }
      
      // Find the lock document using lockId.
      const lock = await Lock.findOne({ _id: lockId });
      if (!lock) {
        return res.status(404).json({ message: "Lock not found." });
      }
      
      // Extract original video key from the stored originalcontentUrl.
      const originalUrl = lock.LockJsonObject.originalcontentUrl;
      const urlParts = originalUrl.split('.amazonaws.com/');
      if (urlParts.length < 2) {
        return res.status(500).json({ message: "Invalid original content URL." });
      }
      const awsOriginalKey = urlParts[1];
      
      // Create an S3 client.
      const s3Client = new S3Client({
        region: awsRegion,
        credentials: {
          accessKeyId: awsAccessKeyId,
          secretAccessKey: awsSecretAccessKey
        }
      });
      
      // Download the original MP4 to a local temporary file.
      const getCommand = new GetObjectCommand({ Bucket: awsBucketName, Key: awsOriginalKey });
      const data = await s3Client.send(getCommand);
      const localMp4Path = path.join(TMP_DIR, `${Date.now()}-original.mp4`);
      await streamPipeline(data.Body, fs.createWriteStream(localMp4Path));
      
      // Process the video into new HLS playlists using the new blackout locks.
      const { normalPlaylistPath, blackoutPlaylistPath } = createM3U8WithExactSegments(localMp4Path, newBlackoutLocks);
      
      // Use the folder provided by the client.
      // It is assumed that the folder string already contains the full destination path,
      // e.g., "AES-videos/first-json-show-videos/".
      const uniqueSubfolder = folder;
      
      // Delete existing folder content in S3.
      const listParams = { Bucket: awsBucketName, Prefix: uniqueSubfolder };
      const listCommand = new ListObjectsV2Command(listParams);
      const listData = await s3Client.send(listCommand);
      if (listData.Contents && listData.Contents.length > 0) {
        const objectsToDelete = listData.Contents.map(obj => ({ Key: obj.Key }));
        const deleteParams = { Bucket: awsBucketName, Delete: { Objects: objectsToDelete, Quiet: false } };
        const deleteCommand = new DeleteObjectsCommand(deleteParams);
        await s3Client.send(deleteCommand);
      }
      
      // Upload new HLS files to S3.
      const fileUrlMapping = await uploadHlsFilesToS3(s3Client, awsBucketName, uniqueSubfolder);
      // Update the playlists to replace local segment filenames with S3 URLs.
      const updatedNormalPlaylist = updatePlaylistContent(normalPlaylistPath, fileUrlMapping);
      const updatedBlackoutPlaylist = updatePlaylistContent(blackoutPlaylistPath, fileUrlMapping);
      
      // Upload the updated playlists.
      const finalNormalKey = uniqueSubfolder + 'output.m3u8';
      const finalBlackoutKey = uniqueSubfolder + 'blackout.m3u8';
      const normalUrl = await uploadToS3(
        s3Client,
        Buffer.from(updatedNormalPlaylist, 'utf8'),
        awsBucketName,
        finalNormalKey,
        'application/vnd.apple.mpegurl'
      );
      const blackoutUrl = await uploadToS3(
        s3Client,
        Buffer.from(updatedBlackoutPlaylist, 'utf8'),
        awsBucketName,
        finalBlackoutKey,
        'application/vnd.apple.mpegurl'
      );
      
      // Clean up local temporary files.
      fs.unlinkSync(localMp4Path);
      const hlsFiles = fs.readdirSync(outputDir);
      for (const file of hlsFiles) {
        fs.unlinkSync(path.join(outputDir, file));
      }
      
      // Update the lock document.
      // Map the new blackout locks to include a new bl_id for each.
      const updatedBlackoutLocks = newBlackoutLocks.map(b => ({
        bl_id: uuidv4(),
        startTime: Number(b.startTime),
        endTime: Number(b.endTime)
      }));
      lock.LockJsonObject.locks["blackout-locks"] = updatedBlackoutLocks;
      lock.LockJsonObject.lockedcontenturl = blackoutUrl;
      await lock.save();
      
      return res.status(200).json({
        message: "Lock modified successfully",
        lock: lock,
        normalUrl,
        blackoutUrl
      });
    } catch (error) {
      console.error("Error in /modify-AES:", error);
      return res.status(500).json({ message: error.message });
    }
  });
  

/**
 * POST /delete-folder-from-json
 * Expects a JSON body with:
 * {
 *   awsData: { awsAccessKeyId, awsSecretAccessKey, awsRegion, awsBucketName, folderPrefix },
 *   lockId
 * }
 * Looks up the lock using lockId to get the contentId, then deletes the folder
 * (i.e. all objects with key prefix: folderPrefix + contentId + '/') from S3.
 */
app.post('/delete-AES', async (req, res) => {
  try {
    const { awsData, lockId } = req.body;
    if (!awsData || !lockId) {
      return res.status(400).json({ message: "Missing awsData or lockId in request body." });
    }
    const { awsAccessKeyId, awsSecretAccessKey, awsRegion, awsBucketName, folderPrefix } = awsData;
    if (!awsAccessKeyId || !awsSecretAccessKey || !awsRegion || !awsBucketName || !folderPrefix) {
      return res.status(400).json({ message: "Missing required AWS data." });
    }
    
    // Find the lock document using the provided lockId.
    const lock = await Lock.findOne({ "LockJsonObject.lockId": lockId });
    if (!lock) {
      return res.status(404).json({ message: "Lock not found." });
    }
    const contentId = lock.LockJsonObject.contentId;
    if (!contentId) {
      return res.status(400).json({ message: "Content ID not found in lock document." });
    }
    
    // Normalize the folderPrefix and build the full folder key.
    const normalizedPrefix = folderPrefix.endsWith('/') ? folderPrefix : folderPrefix + '/';
    const folderToDelete = normalizedPrefix + contentId + '/';
    
    // Create a new S3 client.
    const s3Client = new S3Client({
      region: awsRegion,
      credentials: {
        accessKeyId: awsAccessKeyId,
        secretAccessKey: awsSecretAccessKey
      }
    });
    
    // List objects in the folder.
    const listParams = {
      Bucket: awsBucketName,
      Prefix: folderToDelete
    };
    const listCommand = new ListObjectsV2Command(listParams);
    const listData = await s3Client.send(listCommand);
    
    if (!listData.Contents || listData.Contents.length === 0) {
      return res.status(404).json({ message: "No objects found in the specified folder." });
    }
    
    // Prepare objects for deletion.
    const objectsToDelete = listData.Contents.map(obj => ({ Key: obj.Key }));
    const deleteParams = {
      Bucket: awsBucketName,
      Delete: {
        Objects: objectsToDelete,
        Quiet: false
      }
    };
    const deleteCommand = new DeleteObjectsCommand(deleteParams);
    const deleteResult = await s3Client.send(deleteCommand);
    
    return res.status(200).json({ message: "Folder deleted successfully", deleteResult });
  } catch (error) {
    console.error("Error in /delete-folder-from-json:", error);
    return res.status(500).json({ message: error.message });
  }
});

// Start the Express server on port 3000.
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
