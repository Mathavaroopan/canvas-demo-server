// ====================
// CREATE-LOCK API MODULE
// ====================
const express = require('express');
const router = express.Router();
const multer = require('multer');
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const processing = require('../../canvas-processing');
// Import Lock model
const Lock = require('../schemas/Lock');

/**
 * POST /create-lock
 * Handles video upload, conversion using client-provided blackout segments,
 * S3 upload, and creation of a new lock.
 * Input (multipart form-data): video file, platformId, userId, contentId, contentUrl, blackoutLocks.
 * Output: JSON response with lock details.
 */
router.post('/', upload.single('video'), async (req, res) => {
  try {
    const { platformId, userId, contentId, contentUrl, blackoutLocks } = req.body;
    console.log(req.body);
    const parsedBlackoutLocks = JSON.parse(blackoutLocks);
    if (!req.file) throw new Error("No video file provided");
    
    // Save the uploaded video to the temporary directory from processing module.
    const inputVideoPath = path.join(processing.TMP_DIR, `${Date.now()}-${req.file.originalname}`);
    console.log("Input video path:", inputVideoPath);
    fs.writeFileSync(inputVideoPath, req.file.buffer);
    
    // Create HLS playlists using the conversion function.
    const { normalPlaylistPath, blackoutPlaylistPath } = processing.createM3U8WithExactSegments(inputVideoPath, parsedBlackoutLocks);
    
    // Use contentId as folder name for S3 uploads.
    const submissionId = contentId;
    console.log(`Using contentId as folder name: ${submissionId}`);
    
    // Upload all files from the output directory to S3.
    const fileUrlMapping = await processing.uploadHlsFilesToS3(submissionId, processing.outputDir);
    
    // Update playlist files with the correct S3 URLs.
    const updatedNormalPlaylist = processing.updatePlaylistContent(normalPlaylistPath, fileUrlMapping);
    const updatedBlackoutPlaylist = processing.updatePlaylistContent(blackoutPlaylistPath, fileUrlMapping);
    
    // Upload the updated playlists to S3.
    const updatedNormalKey = `${submissionId}/output.m3u8`;
    const updatedBlackoutKey = `${submissionId}/blackout.m3u8`;
    const updatedNormalUrl = await processing.uploadToS3(Buffer.from(updatedNormalPlaylist, 'utf8'), updatedNormalKey, "application/vnd.apple.mpegurl");
    const updatedBlackoutUrl = await processing.uploadToS3(Buffer.from(updatedBlackoutPlaylist, 'utf8'), updatedBlackoutKey, "application/vnd.apple.mpegurl");
    
    // Clean up the temporary input video.
    fs.unlinkSync(inputVideoPath);
    
    // Format the Lock JSON object.
    const lockId = uuidv4();
    const lockJsonObject = {
      lockId: lockId,
      originalcontentUrl: contentUrl,
      contentId: contentId,
      lockedcontenturl: updatedBlackoutUrl,
      locks: {
        "replacement-video-locks": [],
        "image-locks": [],
        "blackout-locks": parsedBlackoutLocks.map(lock => ({
          bl_id: uuidv4(),
          startTime: Number(lock.startTime),
          endTime: Number(lock.endTime)
        }))
      }
    };
    
    // Create and save the Lock document.
    const newLock = new Lock({
      PlatformID: platformId,
      UserID: userId,
      OriginalContentUrl: contentUrl,
      LockedContentUrl: updatedBlackoutUrl,
      LockJsonObject: lockJsonObject
    });
    const savedLock = await newLock.save();
    res.status(201).json({ message: 'Lock created successfully', lock: savedLock });
  } catch (err) {
    console.error("Error in /create-lock:", err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;
