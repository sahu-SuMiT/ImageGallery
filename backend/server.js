import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  isCloudinaryConfigured,
  getConfigStatus,
  saveConfig,
  uploadToCloudinary,
  deleteFromCloudinary,
} from "./cloudinaryConfig.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Ensure directories exist
const dataDir = path.join(__dirname, "data");
const uploadsDir = path.join(__dirname, "uploads");
const dbPath = path.join(dataDir, "images.json");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
if (!fs.existsSync(dbPath)) {
  fs.writeFileSync(dbPath, JSON.stringify([]), "utf-8");
}

function getStoredImages() {
  try {
    const raw = fs.readFileSync(dbPath, "utf-8");
    return JSON.parse(raw) || [];
  } catch (err) {
    console.error("Error reading images db:", err);
    return [];
  }
}

function saveStoredImages(images) {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(images, null, 2), "utf-8");
  } catch (err) {
    console.error("Error writing images db:", err);
  }
}

// Multer memory storage for direct Cloudinary streaming or fallback
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

app.use(cors());
app.use(express.json());
app.use("/uploads", express.static(uploadsDir));

// Health / Status endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    cloudinary: getConfigStatus(),
  });
});

// Get Cloudinary config status
app.get("/api/config", (req, res) => {
  res.json(getConfigStatus());
});

// Synchronize any local fallback images to Cloudinary once credentials are active
export async function syncLocalImagesToCloudinary() {
  if (!isCloudinaryConfigured()) {
    return { synced: 0, pending: 0, message: "Cloudinary not configured" };
  }

  const currentList = getStoredImages();
  const pendingImages = currentList.filter(
    (img) => img.storage === "local_pending_cloudinary" && img.localPath
  );

  if (!pendingImages.length) {
    return { synced: 0, pending: 0, message: "No local images to sync" };
  }

  let synced = 0;
  for (const img of pendingImages) {
    const filePath = path.join(uploadsDir, img.localPath);
    if (!fs.existsSync(filePath)) continue;

    try {
      const buffer = fs.readFileSync(filePath);
      const ext = path.extname(img.name || img.localPath).toLowerCase();
      const mimetype =
        ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".webp"
          ? "image/webp"
          : "image/png";

      const cloudResult = await uploadToCloudinary(buffer, img.name, mimetype);
      img.url = cloudResult.secure_url || cloudResult.url;
      img.public_id = cloudResult.public_id;
      img.storage = "cloudinary";
      img.format = cloudResult.format;
      img.bytes = cloudResult.bytes;

      // Clean up local file after successful Cloudinary upload
      try {
        fs.unlinkSync(filePath);
      } catch (e) {
        console.warn("Could not remove synced local file:", e.message);
      }
      delete img.localPath;
      synced++;
    } catch (err) {
      console.error(`Failed to auto-sync ${img.name}:`, err.message);
    }
  }

  saveStoredImages(currentList);
  return {
    synced,
    remaining: pendingImages.length - synced,
    total: currentList.length,
  };
}

// Update Cloudinary config dynamically & auto-sync pending local images
app.post("/api/config", async (req, res) => {
  const { cloud_name, api_key, api_secret } = req.body;
  const newStatus = saveConfig({ cloud_name, api_key, api_secret });
  let syncResult = null;
  if (newStatus.configured) {
    syncResult = await syncLocalImagesToCloudinary();
  }
  res.json({
    success: true,
    message: newStatus.configured
      ? "Cloudinary successfully configured!"
      : "Configuration saved, but some credentials are still missing.",
    config: newStatus,
    synced: syncResult,
  });
});

// Explicit endpoint to trigger sync of local fallback images to Cloudinary
app.post("/api/images/sync", async (req, res) => {
  try {
    const result = await syncLocalImagesToCloudinary();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all stored gallery images
app.get("/api/images", (req, res) => {
  const images = getStoredImages();
  res.json({
    success: true,
    images,
  });
});

// Upload image(s) to Cloudinary (or local fallback if credentials pending)
app.post("/api/images/upload", upload.array("images", 10), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: "No image files provided" });
    }

    const isConfigured = isCloudinaryConfigured();
    const uploadedImages = [];

    for (const file of files) {
      const imageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const originalName = file.originalname || "Pasted image";

      if (isConfigured) {
        // Upload directly to Cloudinary
        const cloudResult = await uploadToCloudinary(
          file.buffer,
          originalName,
          file.mimetype
        );

        const newImage = {
          id: imageId,
          name: originalName,
          url: cloudResult.secure_url || cloudResult.url,
          public_id: cloudResult.public_id,
          format: cloudResult.format,
          bytes: cloudResult.bytes,
          storage: "cloudinary",
          createdAt: new Date().toISOString(),
        };

        uploadedImages.push(newImage);
      } else {
        // Fallback: save to local uploads directory
        const ext = path.extname(originalName) || ".png";
        const localFileName = `${imageId}${ext}`;
        const filePath = path.join(uploadsDir, localFileName);
        fs.writeFileSync(filePath, file.buffer);

        const host = req.get("host");
        const protocol = req.protocol;
        const localUrl = `${protocol}://${host}/uploads/${localFileName}`;

        const newImage = {
          id: imageId,
          name: originalName,
          url: localUrl,
          public_id: null,
          localPath: localFileName,
          storage: "local_pending_cloudinary",
          bytes: file.size,
          createdAt: new Date().toISOString(),
        };

        uploadedImages.push(newImage);
      }
    }

    // Persist to JSON DB
    const currentList = getStoredImages();
    const updatedList = [...uploadedImages, ...currentList];
    saveStoredImages(updatedList);

    return res.json({
      success: true,
      cloudinaryConfigured: isConfigured,
      images: uploadedImages,
      warning: !isConfigured
        ? "Images stored locally. Cloudinary Cloud Name and API Secret are required to upload directly to Cloudinary."
        : null,
    });
  } catch (error) {
    console.error("Upload error:", error);
    return res.status(500).json({
      error: error.message || "Failed to upload image",
    });
  }
});

// Delete image from Cloudinary and DB
app.delete("/api/images/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const currentList = getStoredImages();
    const targetImage = currentList.find(
      (item) => item.id === id || item.public_id === id
    );

    if (!targetImage) {
      return res.status(404).json({ error: "Image not found in gallery" });
    }

    // If on Cloudinary, destroy it
    if (targetImage.public_id && isCloudinaryConfigured()) {
      try {
        await deleteFromCloudinary(targetImage.public_id);
      } catch (err) {
        console.warn("Cloudinary delete warning:", err.message);
      }
    }

    // If local file, unlink
    if (targetImage.localPath) {
      const localFilePath = path.join(uploadsDir, targetImage.localPath);
      if (fs.existsSync(localFilePath)) {
        try {
          fs.unlinkSync(localFilePath);
        } catch (e) {
          console.warn("Local file unlink error:", e.message);
        }
      }
    }

    // Remove from DB
    const updatedList = currentList.filter(
      (item) => item.id !== targetImage.id && item.public_id !== targetImage.public_id
    );
    saveStoredImages(updatedList);

    return res.json({
      success: true,
      message: "Image successfully deleted",
      deletedId: targetImage.id,
      public_id: targetImage.public_id,
    });
  } catch (error) {
    console.error("Delete error:", error);
    return res.status(500).json({
      error: error.message || "Failed to delete image",
    });
  }
});

app.listen(PORT, async () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  console.log(`Cloudinary status:`, getConfigStatus());

  if (isCloudinaryConfigured()) {
    try {
      const sync = await syncLocalImagesToCloudinary();
      if (sync.synced > 0) {
        console.log(`Auto-synced ${sync.synced} fallback image(s) to Cloudinary on startup!`);
      }
    } catch (err) {
      console.warn("Startup auto-sync warning:", err.message);
    }
  }
});
