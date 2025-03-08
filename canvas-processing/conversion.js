// ====================
// VIDEO CONVERSION MODULE
// ====================
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Define directories for temporary video storage and HLS output.
const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}
const outputDir = path.join(__dirname, 'hls_output');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

/**
 * Gets the duration of the video.
 * @param {string} inputPath - The path to the input video file.
 * @returns {number} - Total duration in seconds.
 */
function getVideoDuration(inputPath) {
  const durationOutput = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`
  ).toString().trim();
  const totalDuration = parseFloat(durationOutput);
  console.log(`Video duration: ${totalDuration} seconds`);
  if (!totalDuration || isNaN(totalDuration)) {
    throw new Error('Failed to get video duration');
  }
  return totalDuration;
}

/**
 * Gets the video resolution.
 * @param {string} inputPath - The path to the input video file.
 * @returns {string} - Video resolution (e.g., "1920x1080").
 */
function getVideoResolution(inputPath) {
  const resolutionOutput = execSync(
    `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${inputPath}"`
  ).toString().trim();
  console.log(`Video resolution: ${resolutionOutput}`);
  return resolutionOutput;
}

/**
 * Converts client-provided blackout segments into a standardized format.
 * @param {Array} blackoutSegments - Array of objects { startTime, endTime }.
 * @returns {Array} - Array of objects { start, end } (both numbers).
 */
function convertBlackoutSegments(blackoutSegments) {
  return blackoutSegments.map(seg => ({
    start: Number(seg.startTime),
    end: Number(seg.endTime)
  }));
}

/**
 * Builds a complete list of segments based on total duration and custom segments.
 * @param {number} totalDuration - Total video duration in seconds.
 * @param {Array} customSegments - Array of objects { start, end }.
 * @returns {Array} - Array of segments { start, end, isBlackout }.
 */
function buildSegments(totalDuration, customSegments) {
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
  return allSegments;
}

/**
 * Extracts each segment of the video as a .ts file.
 * @param {string} inputPath - Path to the input video.
 * @param {Array} segments - Array of segment objects { start, end }.
 * @param {string} outputDir - Directory where .ts files will be saved.
 */
function extractRegularSegments(inputPath, segments, outputDir) {
  console.log('Extracting segments:');
  segments.forEach((segment, index) => {
    const segmentPath = path.join(outputDir, `segment_${String(index).padStart(3, '0')}.ts`);
    const segDuration = segment.end - segment.start;
    console.log(`Segment ${index}: ${segment.start}s to ${segment.end}s (${segDuration}s)`);
    execSync(
      `ffmpeg -y -i "${inputPath}" -ss ${segment.start} -to ${segment.end} ` +
      `-c:v libx264 -c:a aac -f mpegts "${segmentPath}"`
    );
  });
}

/**
 * Generates blackout .ts files (black screens) for blackout segments.
 * @param {Array} segments - Array of segment objects { start, end, isBlackout }.
 * @param {string} resolution - Video resolution (e.g., "1920x1080").
 * @param {string} outputDir - Directory where blackout files will be saved.
 */
function generateBlackoutSegments(segments, resolution, outputDir) {
  segments.forEach((segment, index) => {
    if (segment.isBlackout) {
      const blackoutPath = path.join(outputDir, `blackout_${String(index).padStart(3, '0')}.ts`);
      const segDuration = segment.end - segment.start;
      console.log(`Generating blackout segment ${index}: duration ${segDuration}s`);
      execSync(
        `ffmpeg -y -f lavfi -i color=c=black:s=${resolution}:r=30 ` +
        `-f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 ` +
        `-t ${segDuration} -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest ` +
        `-f mpegts "${blackoutPath}"`
      );
    }
  });
}

/**
 * Creates an M3U8 playlist file.
 * @param {Array} segments - Array of segment objects { start, end, isBlackout }.
 * @param {string} playlistType - "normal" or "blackout".
 * @param {string} outputDir - Directory where the playlist file will be saved.
 * @returns {string} - Full path to the generated playlist file.
 */
function createPlaylist(segments, playlistType, outputDir) {
  const targetDuration = Math.ceil(Math.max(...segments.map(s => s.end - s.start)));
  const playlistLines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD'
  ];
  segments.forEach((segment, index) => {
    const segDuration = segment.end - segment.start;
    playlistLines.push(`#EXTINF:${segDuration.toFixed(6)},`);
    if (playlistType === "normal") {
      playlistLines.push(`segment_${String(index).padStart(3, '0')}.ts`);
    } else if (playlistType === "blackout") {
      playlistLines.push(segment.isBlackout
        ? `blackout_${String(index).padStart(3, '0')}.ts`
        : `segment_${String(index).padStart(3, '0')}.ts`
      );
    }
  });
  playlistLines.push('#EXT-X-ENDLIST');
  const playlistFilename = playlistType === "normal" ? 'output.m3u8' : 'blackout.m3u8';
  const playlistPath = path.join(outputDir, playlistFilename);
  fs.writeFileSync(playlistPath, playlistLines.join('\n'));
  console.log(`Generated ${playlistType} M3U8 playlist:`, playlistPath);
  return playlistPath;
}

/**
 * Main function to create HLS playlists with exact segments.
 * @param {string} inputPath - Path to the input MP4 video.
 * @param {Array} blackoutSegments - Array of objects { startTime, endTime }.
 * @returns {Object} - { normalPlaylistPath, blackoutPlaylistPath }.
 */
function createM3U8WithExactSegments(inputPath, blackoutSegments) {
  try {
    const customSegments = convertBlackoutSegments(blackoutSegments);
    const totalDuration = getVideoDuration(inputPath);
    const resolution = getVideoResolution(inputPath);
    const allSegments = buildSegments(totalDuration, customSegments);
    extractRegularSegments(inputPath, allSegments, outputDir);
    generateBlackoutSegments(allSegments, resolution, outputDir);
    const normalPlaylistPath = createPlaylist(allSegments, "normal", outputDir);
    const blackoutPlaylistPath = createPlaylist(allSegments, "blackout", outputDir);
    return { normalPlaylistPath, blackoutPlaylistPath };
  } catch (error) {
    console.error('Error during HLS conversion:', error.message);
    if (error.stderr) console.error(error.stderr.toString());
    throw error;
  }
}

module.exports = {
  TMP_DIR,
  outputDir,
  getVideoDuration,
  getVideoResolution,
  convertBlackoutSegments,
  buildSegments,
  extractRegularSegments,
  generateBlackoutSegments,
  createPlaylist,
  createM3U8WithExactSegments
};
