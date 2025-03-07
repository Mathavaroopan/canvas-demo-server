const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const PlatformSchema = new Schema({
  PlatformID: { type: String, required: true, unique: true }, // Explicit Platform ID
  PlatformName: { type: String, required: true },
  PlatformType: { type: String, required: true },
  EmailID: { type: String, required: true, unique: true },
  Address: { type: String },
  Description: { type: String },
  CreatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Platform', PlatformSchema);
