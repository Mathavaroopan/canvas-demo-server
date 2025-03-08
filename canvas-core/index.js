// ====================
// MAIN EXPRESS SERVER SETUP (canvas-core)
// ====================
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config();

// Mongoose Connection
const connectionString = process.env.MONGO_URI;
mongoose.connect(connectionString, { 
  useNewUrlParser: true, 
  useUnifiedTopology: true 
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => console.error('Error connecting to MongoDB:', err));

const app = express();
app.use(cors({
  origin: ["http://localhost:5173", "https://canvas-demo-client.vercel.app/"],
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from the hls_output folder.
app.use(express.static(path.join(__dirname, "hls_output")));

// Mount API routes.
const createLockRouter = require('./apis/create-lock');
const folderOpsRouter = require('./apis/folder-ops');

app.use('/create-lock', createLockRouter);
app.use('/', folderOpsRouter); // This router handles /download-folder and /get-folder-names

// (Optional) Proxy middleware for /api routes.
const { createProxyMiddleware } = require("http-proxy-middleware");
app.use(
  "/api",
  createProxyMiddleware({
    target: "http://54.90.83.226:4000",
    changeOrigin: true,
    secure: false,
  })
);

// Start the server.
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
