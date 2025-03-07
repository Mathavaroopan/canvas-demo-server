const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const QuotaSchema = new Schema({
  LockID: { type: Schema.Types.ObjectId, ref: 'Lock', required: true }, // Reference to Lock _id
  PlatformID: { type: Schema.Types.ObjectId, ref: 'Platform', required: true },
  ContentID: { type: String, required: true },
  UserID: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  LockAction: { type: String, required: true, enum: ['Lock', 'Unlock'] },
  Timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Quota', QuotaSchema);
