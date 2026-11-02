// Local (on-disk) media storage for the VPS-hosted backend.
//
// New uploads are written under `public/uploads/<folder>/<uuid>.<ext>` and
// served statically by index.js at `${PUBLIC_UPLOAD_BASE}/uploads/...`.
// Existing assets that still live on Cloudinary keep working untouched — only
// NEW uploads land on local disk. `destroyAsset` transparently deletes from
// whichever backing store an asset came from (local vs Cloudinary), decided by
// the shape of its public_id (local ids are prefixed with "uploads/").
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import crypto from "crypto";
import sharp from "sharp";
import { v2 as cloudinary } from "cloudinary";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// public/            <- served static content root (index.js mounts /uploads)
// public/uploads/    <- everything created here is web-accessible
export const PUBLIC_DIR = path.join(__dirname, "..", "public");
export const UPLOADS_ROOT = path.join(PUBLIC_DIR, "uploads");

const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".ogg", ".m4v"]);

// Absolute base URL that fronts the /uploads static route — this is baked into
// every stored image URL, so it MUST point at the public backend host. Set
// PUBLIC_UPLOAD_BASE per environment (e.g. http://localhost:5000 in dev). We
// intentionally do NOT fall back to BACKEND_URL, which is localhost in dev and
// would poison stored URLs. The default is the production API host.
function publicBase(override) {
  if (override) return String(override).replace(/\/+$/, "");
  return (process.env.PUBLIC_UPLOAD_BASE || "https://api.applebd.com").replace(
    /\/+$/,
    "",
  );
}

// Work out the base URL to bake into a freshly-stored asset.
//
// In production this is always the configured PUBLIC_UPLOAD_BASE (the file is
// served by the same public backend host for everyone). In development the file
// lives on whatever local backend actually received the upload — usually
// http://localhost:5000 — which is NOT the production PUBLIC_UPLOAD_BASE. If we
// stored the production URL in dev the just-uploaded image would 404 locally
// (the reported "upload doesn't work" symptom). So in non-production we derive
// the base from the incoming request host, which is by definition the host that
// can serve the file back. A dev who explicitly points PUBLIC_UPLOAD_BASE at the
// same host they hit is left untouched (the hosts already match).
//
// Returns a base URL string to use, or undefined to fall back to publicBase().
export function requestUploadBase(req) {
  if (!req || process.env.NODE_ENV === "production") return undefined;
  try {
    const proto = String(
      req.headers["x-forwarded-proto"] || req.protocol || "http",
    )
      .split(",")[0]
      .trim();
    const host = req.headers["x-forwarded-host"] || req.get("host");
    if (!host) return undefined;
    const reqBase = `${proto}://${host}`.replace(/\/+$/, "");
    // If the configured base already serves this host, keep the configured one.
    if (new URL(publicBase()).host === new URL(reqBase).host) return undefined;
    return reqBase;
  } catch {
    return undefined;
  }
}

// Turn an arbitrary folder string ("applebd/products") into a safe relative
// path with no traversal, empty, or unexpected characters.
function sanitizeFolder(folder) {
  const cleaned = String(folder || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) => seg.replace(/[^a-zA-Z0-9_-]/g, ""))
    .filter(Boolean)
    .join("/");
  return cleaned || "misc";
}

// Local public_ids are the file path relative to `public/`, e.g.
// "uploads/applebd/products/ab12.webp". Cloudinary ids never start with that.
export function isLocalPublicId(publicId) {
  return typeof publicId === "string" && publicId.startsWith("uploads/");
}

let cloudinaryConfigured = false;
function ensureCloudinaryConfigured() {
  if (!cloudinaryConfigured) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    cloudinaryConfigured = true;
  }
}

// Store an uploaded file on local disk. Images are optimized to webp with sharp
// (mirrors the old server-side Cloudinary pipeline); videos are stored as-is.
// Returns the same asset shape the frontend/DB already expect.
export async function saveLocalUpload({
  buffer,
  mimetype,
  originalName,
  folder,
  baseUrl,
}) {
  const rel = sanitizeFolder(folder);
  const dir = path.join(UPLOADS_ROOT, rel);
  await fs.mkdir(dir, { recursive: true });

  const id = crypto.randomUUID();
  const isVideo = String(mimetype || "").startsWith("video/");

  if (isVideo) {
    const ext = (path.extname(originalName || "") || ".mp4").toLowerCase();
    const filename = `${id}${ext}`;
    await fs.writeFile(path.join(dir, filename), buffer);
    const publicId = `uploads/${rel}/${filename}`;
    return {
      public_id: publicId,
      url: `${publicBase(baseUrl)}/${publicId}`,
      format: ext.replace(".", ""),
      resourceType: "video",
    };
  }

  const maxWidth = Number(process.env.IMG_MAX_WIDTH) || 2560;
  // webp quality 80 is visually indistinguishable from 100 for product/banner
  // imagery (text + photos stay crisp) but ~69% smaller on disk and over the
  // wire — the single biggest lever on the backend's image egress. 100 was
  // wasteful: it tripled file sizes for no perceptible gain. Override via
  // IMG_QUALITY if a specific asset ever needs more.
  const quality = Number(process.env.IMG_QUALITY) || 80;

  // The browser (lib/uploadImage.js) already resizes to <= maxWidth and encodes
  // to webp before upload. Re-encoding that webp here would stack a second lossy
  // generation on top — the exact cause of visibly "blurry" uploads even for HD
  // source images. So: if the incoming file is already webp and within maxWidth,
  // store it verbatim (single generation). Only images that are larger than
  // maxWidth or not-yet-webp (e.g. direct/non-browser uploads) get the resize +
  // encode pass, and at high quality so the loss is minimal.
  const meta = await sharp(buffer).metadata().catch(() => ({}));
  const alreadyOptimized =
    meta.format === "webp" && (meta.width || 0) <= maxWidth;

  let data, info;
  if (alreadyOptimized) {
    data = buffer;
    info = { width: meta.width, height: meta.height };
  } else {
    ({ data, info } = await sharp(buffer)
      .rotate()
      .resize({ width: maxWidth, withoutEnlargement: true })
      .webp({ quality })
      .toBuffer({ resolveWithObject: true }));
  }

  const filename = `${id}.webp`;
  await fs.writeFile(path.join(dir, filename), data);
  const publicId = `uploads/${rel}/${filename}`;
  return {
    public_id: publicId,
    url: `${publicBase(baseUrl)}/${publicId}`,
    width: info.width,
    height: info.height,
    format: "webp",
    resourceType: "image",
  };
}

// Copy a locally-stored asset to a brand-new file with its own public_id, so a
// duplicated product owns an independent copy of every image instead of sharing
// the original's file. Returns { public_id, url } for the new file, or null if
// the source isn't a local asset or can't be read (caller then keeps the
// original reference). Legacy Cloudinary assets are left shared — deletion of
// those is guarded by a sibling-in-use check elsewhere.
export async function copyLocalAsset(publicId, { folder } = {}) {
  if (!isLocalPublicId(publicId)) return null;
  const srcFull = path.join(PUBLIC_DIR, publicId.replace(/^\/+/, ""));
  if (!srcFull.startsWith(UPLOADS_ROOT)) return null;
  try {
    const buffer = await fs.readFile(srcFull);
    const srcRel = publicId.replace(/^uploads\//, "");
    const ext = path.extname(srcRel) || ".webp";
    const rel = folder
      ? sanitizeFolder(folder)
      : srcRel.split("/").slice(0, -1).join("/") || "misc";
    const dir = path.join(UPLOADS_ROOT, rel);
    await fs.mkdir(dir, { recursive: true });
    const filename = `${crypto.randomUUID()}${ext}`;
    await fs.writeFile(path.join(dir, filename), buffer);
    const newPublicId = `uploads/${rel}/${filename}`;
    return { public_id: newPublicId, url: `${publicBase()}/${newPublicId}` };
  } catch {
    return null;
  }
}

// Delete a locally-stored file. No-op (returns false) for non-local ids.
export async function deleteLocalAsset(publicId) {
  if (!isLocalPublicId(publicId)) return false;
  const full = path.join(PUBLIC_DIR, publicId.replace(/^\/+/, ""));
  // Guard against path traversal — must resolve inside the uploads root.
  if (!full.startsWith(UPLOADS_ROOT)) return false;
  await fs.unlink(full).catch(() => {});
  return true;
}

// Delete an asset from whichever store it lives in. Safe to call for either
// local or legacy Cloudinary ids. Errors are swallowed (best-effort cleanup).
export async function destroyAsset(publicId, opts = {}) {
  if (!publicId) return;
  if (isLocalPublicId(publicId)) {
    await deleteLocalAsset(publicId);
    return;
  }
  try {
    ensureCloudinaryConfigured();
    await cloudinary.uploader.destroy(publicId, opts);
  } catch {
    /* ignore Cloudinary errors */
  }
}

// List locally-stored media (for the admin Media Library), optionally scoped to
// a folder prefix and filtered by a query string. Returns newest-first.
export async function listLocalMedia({ folder = "", q = "" } = {}) {
  const prefix = folder ? sanitizeFolder(folder) : "";
  const start = prefix ? path.join(UPLOADS_ROOT, prefix) : UPLOADS_ROOT;
  const results = [];

  async function walk(dir, relPrefix) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // folder doesn't exist yet
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat) continue;
      const ext = path.extname(e.name).toLowerCase();
      const isVideo = VIDEO_EXTS.has(ext);
      results.push({
        public_id: `uploads/${rel}`,
        url: `${publicBase()}/uploads/${rel}`,
        resource_type: isVideo ? "video" : "image",
        bytes: stat.size,
        format: ext.replace(".", ""),
        created_at: stat.mtime.toISOString(),
        folder: rel.split("/").slice(0, -1).join("/"),
      });
    }
  }

  await walk(start, prefix);
  let items = results;
  if (q) {
    const lower = q.toLowerCase();
    items = items.filter((i) => i.public_id.toLowerCase().includes(lower));
  }
  return items.sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at),
  );
}
