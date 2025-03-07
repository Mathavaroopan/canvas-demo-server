const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const UserSchema = new Schema({
  UserID: { type: String, required: true, unique: true }, 
  PlatformID: { type: Schema.Types.ObjectId, ref: 'Platform', required: true },
  Name: { type: String, required: true },
  Role: { type: String, required: true, enum: ['Admin', 'User'] },
  EmailID: { type: String, required: true, unique: true },
  Gender: { type: String },
  Phone: { type: String },
  UserDescription: { type: String },
  CreatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', UserSchema);
