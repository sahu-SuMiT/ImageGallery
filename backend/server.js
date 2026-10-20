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
import { authMiddleware } from "./authMiddleware.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Standard asyncHandler wrapper for route handlers
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

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
    if (!fs.existsSync(dbPath)) return [];
    const raw = fs.readFileSync(dbPath, "utf-8");
    return JSON.parse(raw) || [];
  } catch (err) {
    console.error("Error reading images DB:", err.message);
    return [];
  }
}

function saveStoredImages(images) {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(images, null, 2), "utf-8");
  } catch (err) {
    console.error("Error writing images DB:", err.message);
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
  res.sendStatus(204);
});

// Get Cloudinary config status
app.get("/api/config", (req, res) => {
  res.json(getConfigStatus());
});

// Verify current authenticated user
app.get("/api/auth/me", authMiddleware, (req, res) => {
  res.json({
    success: true,
    user: req.user,
  });
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

      const userFolder = img.userId
        ? `image_gallery/users/${img.userId}`
        : "image_gallery";

      const cloudResult = await uploadToCloudinary(
        buffer,
        img.name,
        mimetype,
        userFolder
      );
      img.url = cloudResult.secure_url || cloudResult.url;
      img.public_id = cloudResult.public_id;
      img.storage = "cloudinary";
      img.format = cloudResult.format;
      img.bytes = cloudResult.bytes;

      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          console.warn("Could not remove synced local file:", e.message);
        }
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
app.post(
  "/api/config",
  asyncHandler(async (req, res) => {
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
  })
);

// Trigger sync of local fallback images to Cloudinary
app.post(
  "/api/images/sync",
  asyncHandler(async (req, res) => {
    const result = await syncLocalImagesToCloudinary();
    res.json({ success: true, ...result });
  })
);

// Get stored gallery images belonging to the authenticated user
app.get(
  "/api/images",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const allImages = getStoredImages();
    // Return strictly images created by this user
    const userImages = allImages.filter((img) => img.userId === req.user.id);
    res.json({
      success: true,
      images: userImages,
    });
  })
);

// Upload image(s) to Cloudinary for the authenticated user
app.post(
  "/api/images/upload",
  authMiddleware,
  upload.array("images", 20),
  asyncHandler(async (req, res) => {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: "No image files provided" });
    }

    const isConfigured = isCloudinaryConfigured();
    const uploadedImages = [];
    const userFolder = `image_gallery/users/${req.user.id}`;

    for (const file of files) {
      const imageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const originalName = file.originalname || "Pasted image";

      if (isConfigured) {
        try {
          const cloudResult = await uploadToCloudinary(
            file.buffer,
            originalName,
            file.mimetype,
            userFolder
          );

          uploadedImages.push({
            id: imageId,
            userId: req.user.id,
            userEmail: req.user.email,
            name: originalName,
            url: cloudResult.secure_url || cloudResult.url,
            public_id: cloudResult.public_id,
            format: cloudResult.format,
            bytes: cloudResult.bytes,
            storage: "cloudinary",
            createdAt: new Date().toISOString(),
          });
        } catch (uploadErr) {
          console.error(
            `Failed to upload ${originalName} to Cloudinary:`,
            uploadErr.message
          );

          // Graceful fallback to local storage for this specific image
          const ext = path.extname(originalName) || ".png";
          const localFileName = `${imageId}${ext}`;
          const filePath = path.join(uploadsDir, localFileName);
          fs.writeFileSync(filePath, file.buffer);

          const localUrl = `http://localhost:${PORT}/uploads/${localFileName}`;
          uploadedImages.push({
            id: imageId,
            userId: req.user.id,
            userEmail: req.user.email,
            name: originalName,
            url: localUrl,
            public_id: null,
            localPath: localFileName,
            storage: "local_pending_cloudinary",
            bytes: file.size,
            createdAt: new Date().toISOString(),
          });
        }
      } else {
        // Fallback: save to local uploads directory
        const ext = path.extname(originalName) || ".png";
        const localFileName = `${imageId}${ext}`;
        const filePath = path.join(uploadsDir, localFileName);
        fs.writeFileSync(filePath, file.buffer);

        const localUrl = `http://localhost:${PORT}/uploads/${localFileName}`;
        uploadedImages.push({
          id: imageId,
          userId: req.user.id,
          userEmail: req.user.email,
          name: originalName,
          url: localUrl,
          public_id: null,
          localPath: localFileName,
          storage: "local_pending_cloudinary",
          bytes: file.size,
          createdAt: new Date().toISOString(),
        });
      }
    }

    if (uploadedImages.length) {
      const currentList = getStoredImages();
      saveStoredImages([...uploadedImages, ...currentList]);
    }

    return res.json({
      success: true,
      cloudinaryConfigured: isConfigured,
      images: uploadedImages,
    });
  })
);

// Helper to delete an image safely (best-effort deletion so one failure never blocks a batch)
async function removeImageFromStorageAndDb(target) {
  if (target.public_id && isCloudinaryConfigured()) {
    try {
      await deleteFromCloudinary(target.public_id);
    } catch (err) {
      console.warn(`Cloudinary delete warning for ${target.public_id}:`, err.message);
    }
  }

  if (target.localPath) {
    const localFilePath = path.join(uploadsDir, target.localPath);
    try {
      if (fs.existsSync(localFilePath)) {
        fs.unlinkSync(localFilePath);
      }
    } catch (err) {
      console.warn(`Local file unlink warning for ${target.localPath}:`, err.message);
    }
  }
}

// Batch delete endpoint (only deletes images owned by the authenticated user)
app.post(
  "/api/images/batch-delete",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) {
      return res.json({ success: true, deletedCount: 0 });
    }

    const currentList = getStoredImages();
    // Only permit deleting images belonging to this user
    const targetsToDelete = currentList.filter(
      (item) =>
        (ids.includes(item.id) || ids.includes(item.public_id)) &&
        (!item.userId || item.userId === req.user.id)
    );

    for (const target of targetsToDelete) {
      await removeImageFromStorageAndDb(target);
    }

    const updatedList = currentList.filter(
      (item) => !targetsToDelete.some((t) => t.id === item.id)
    );
    saveStoredImages(updatedList);

    return res.json({
      success: true,
      deletedCount: targetsToDelete.length,
    });
  })
);

// Single delete endpoint (only deletes if owned by authenticated user)
app.delete(
  "/api/images/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const currentList = getStoredImages();
    const targetImage = currentList.find(
      (item) => item.id === id || item.public_id === id
    );

    if (!targetImage) {
      return res.status(404).json({ error: "Image not found in gallery" });
    }

    // Authorization check
    if (targetImage.userId && targetImage.userId !== req.user.id) {
      return res.status(403).json({ error: "Forbidden: You do not own this image." });
    }

    await removeImageFromStorageAndDb(targetImage);

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
  })
);

// Central Express error handling middleware
app.use((err, req, res, next) => {
  console.error("API error:", err);
  res.status(err.status || 500).json({
    error: err.message || "Internal server error",
  });
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
