const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const LockSchema = new Schema({
  PlatformID: { type: Schema.Types.ObjectId, ref: 'Platform', required: true },
  UserID: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  OriginalContentUrl: { type: String, required: true }, // Renamed ContentUrl
  LockedContentUrl: { type: String, default: null }, // Can be null
  LockJsonObject: { 
    type: {
      lockId: { type: String, required: true },
      originalcontentUrl: { type: String, required: true },
      contentId: { type: String, required: true },
      lockedcontenturl: { type: String, default: null },
      locks: {
        "replacement-video-locks": [{
          vl_id: { type: String, required: true },
          startTime: { type: Number, required: true },
          endTime: { type: Number, required: true },
          replacementVideo: { type: String, required: true }
        }],
        "image-locks": [{
          il_id: { type: String, required: true },
          time: { type: Number, required: true },
          imageUrl: { type: String, required: true }
        }],
        "blackout-locks": [{
          bl_id: { type: String, required: true },
          startTime: { type: Number, required: true },
          endTime: { type: Number, required: true }
        }]
      },
      awsMetadata: {
        AWS_ACCESS_KEY_ID: { type: String, required: true },
        AWS_SECRET_ACCESS_KEY: { type: String, required: true },
        AWS_REGION: { type: String, required: true },
        AWS_S3_BUCKET_NAME: { type: String, required: true }
      }
    },
    required: true
  },
  CreatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Lock', LockSchema);
