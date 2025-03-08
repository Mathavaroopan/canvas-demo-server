// ====================
// FOLDER OPERATIONS API MODULE
// ====================
const express = require('express');
const router = express.Router();
const processing = require('../../canvas-processing');

/**
 * GET /download-folder
 * Downloads all files from a specified S3 folder (given by folderPrefix) and saves them locally.
 * Query Parameter: folderPrefix (e.g., "submissionId/")
 * Output: JSON response with list of downloaded files.
 */
router.get('/download-folder', async (req, res) => {
  try {
    const folderPrefix = req.query.folderPrefix;
    console.log("Download folder with prefix:", folderPrefix);
    if (!folderPrefix) {
      return res.status(400).json({ error: "folderPrefix query parameter is required." });
    }
    const downloadedFiles = await processing.downloadFolderFromS3(folderPrefix, processing.outputDir);
    res.status(200).json({ message: "Files downloaded successfully", files: downloadedFiles });
  } catch (error) {
    console.error("Error in /download-folder:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /get-folder-names
 * Retrieves a list of folder names (common prefixes) in the S3 bucket.
 * Output: JSON response with an array of folder names.
 */
router.get('/get-folder-names', async (req, res) => {
  try {
    const folders = await processing.getFolderNamesFromS3();
    res.status(200).json({ folders });
  } catch (error) {
    console.error("Error in /get-folder-names:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
