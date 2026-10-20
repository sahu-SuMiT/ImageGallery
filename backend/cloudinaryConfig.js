import { v2 as cloudinary } from "cloudinary";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, ".env");

dotenv.config({ path: envPath });

let currentConfig = {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME?.trim() || "",
  api_key: process.env.CLOUDINARY_API_KEY?.trim() || "358744838562899",
  api_secret: process.env.CLOUDINARY_API_SECRET?.trim() || "",
};

export function configureCloudinary() {
  if (currentConfig.cloud_name && currentConfig.api_key && currentConfig.api_secret) {
    cloudinary.config({
      cloud_name: currentConfig.cloud_name,
      api_key: currentConfig.api_key,
      api_secret: currentConfig.api_secret,
      secure: true,
    });
    return true;
  }
  return false;
}

configureCloudinary();

export function isCloudinaryConfigured() {
  return Boolean(
    currentConfig.cloud_name &&
    currentConfig.api_key &&
    currentConfig.api_secret
  );
}

export function getConfigStatus() {
  return {
    configured: isCloudinaryConfigured(),
    cloud_name: currentConfig.cloud_name || null,
    api_key: currentConfig.api_key ? `${currentConfig.api_key.slice(0, 4)}...${currentConfig.api_key.slice(-4)}` : null,
    full_api_key: currentConfig.api_key || "358744838562899",
    has_api_secret: Boolean(currentConfig.api_secret),
  };
}

export function saveConfig({ cloud_name, api_key, api_secret }) {
  if (cloud_name !== undefined) currentConfig.cloud_name = cloud_name.trim();
  if (api_key !== undefined) currentConfig.api_key = api_key.trim();
  if (api_secret !== undefined) currentConfig.api_secret = api_secret.trim();

  configureCloudinary();

  // Persist to .env
  const content = `PORT=${process.env.PORT || 5000}
CLOUDINARY_API_KEY=${currentConfig.api_key}
CLOUDINARY_CLOUD_NAME=${currentConfig.cloud_name}
CLOUDINARY_API_SECRET=${currentConfig.api_secret}
`;
  try {
    fs.writeFileSync(envPath, content, "utf-8");
  } catch (err) {
    console.error("Failed to write to .env:", err);
  }

  return getConfigStatus();
}

export async function uploadToCloudinary(
  buffer,
  originalname,
  mimetype,
  folder = "image_gallery"
) {
  if (!isCloudinaryConfigured()) {
    throw new Error(
      "Cloudinary is not fully configured yet. Cloud Name and API Secret are required alongside API Key."
    );
  }

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "image",
        filename_override: originalname,
        use_filename: true,
      },
      (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      }
    );

    uploadStream.end(buffer);
  });
}

export async function deleteFromCloudinary(publicId) {
  if (!isCloudinaryConfigured()) {
    throw new Error("Cloudinary credentials not configured.");
  }
  return await cloudinary.uploader.destroy(publicId, { invalidate: true });
}

export { cloudinary };
