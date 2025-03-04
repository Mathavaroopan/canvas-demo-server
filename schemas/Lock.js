const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const LockSchema = new Schema({
  PlatformID: { type: Schema.Types.ObjectId, ref: 'Platform', required: true },
  UserID: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  ContentUrl: { type: String, required: true },
  LockedContentUrl: { type: String },
  FolderUrl: { type: String }, // New field to store the submission folder URL
  LockJsonObject: { type: Schema.Types.Mixed, required: true },
  CreatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Lock', LockSchema);
