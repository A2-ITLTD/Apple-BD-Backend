// Shared re-compression core for locally-stored media.
//
// Re-encodes every image already sitting in public/uploads at a lower webp
// quality so existing assets shrink the same way new uploads now do (the
// backend default dropped from quality 100 → 80, ~50-69% smaller with no
// visible loss). Only touches LOCAL files on disk — Cloudinary-hosted legacy
// assets and videos are left untouched.
//
// Used by both scripts/recompressUploads.js (CLI, for hosts with shell access)
// and the POST /api/cron/recompress-uploads route (for hosts where only the
// running backend can reach the uploads disk — e.g. no SSH).
//
// Conservative by design:
//  - Each file is re-encoded in its OWN format at the SAME filename, so URLs
//    already stored in MongoDB keep working (no DB changes needed).
//  - A file is only overwritten if the result is at least `minSavings` % smaller,
//    so already-optimized files aren't churned and the run is safe to repeat.
//  - Writes go to a temp sibling then atomically rename over the original, so a
//    file being served is never left half-written.
//  - Dimensions are preserved (no upscaling); pass `maxWidth` to also cap very
//    wide images.
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import sharp from "sharp";
import { UPLOADS_ROOT } from "./assetStore.js";

const IMAGE_EXTS = new Set([".webp", ".jpg", ".jpeg", ".png"]);

// Encode `buffer` back into the same `ext` family at the given quality,
// optionally downscaling to maxWidth. Returns the encoded Buffer.
async function reencode(buffer, ext, quality, maxWidth) {
  let img = sharp(buffer).rotate(); // bake in EXIF orientation if any
  if (maxWidth > 0) {
    img = img.resize({ width: maxWidth, withoutEnlargement: true });
  }
  if (ext === ".png") {
    // PNG is lossless; palette quantization is the only real size lever.
    return img.png({ compressionLevel: 9, quality, palette: true }).toBuffer();
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return img.jpeg({ quality, mozjpeg: true }).toBuffer();
  }
  return img.webp({ quality }).toBuffer();
}

async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(abs);
    } else {
      yield abs;
    }
  }
}

// Run the re-compression. Returns a stats object; emits human-readable lines via
// the optional `log` callback (CLI passes console.log; the route collects them).
export async function recompressUploads({
  quality = 80,
  minSavings = 5,
  maxWidth = 0,
  backup = false,
  dryRun = false,
  log = () => {},
} = {}) {
  quality = Math.min(100, Math.max(1, Number(quality) || 80));
  minSavings = Math.max(0, Number(minSavings) || 0);
  maxWidth = Math.max(0, Number(maxWidth) || 0);

  const stats = {
    root: UPLOADS_ROOT,
    quality,
    minSavings,
    maxWidth,
    dryRun,
    backup,
    scanned: 0,
    rewritten: 0,
    skippedSmall: 0,
    skippedNonImage: 0,
    failed: 0,
    beforeBytes: 0,
    afterBytes: 0,
  };

  for await (const file of walk(UPLOADS_ROOT)) {
    const ext = path.extname(file).toLowerCase();
    if (file.endsWith(".orig")) continue; // never touch our own backups
    if (!IMAGE_EXTS.has(ext)) {
      stats.skippedNonImage++;
      continue;
    }
    stats.scanned++;

    const rel = path.relative(UPLOADS_ROOT, file);
    let original;
    try {
      original = await fs.readFile(file);
    } catch (err) {
      log(`FAIL read   ${rel} — ${err.message}`);
      stats.failed++;
      continue;
    }

    let encoded;
    try {
      encoded = await reencode(original, ext, quality, maxWidth);
    } catch (err) {
      log(`FAIL encode ${rel} — ${err.message}`);
      stats.failed++;
      continue;
    }

    const savingsPct = 100 - (encoded.length / original.length) * 100;
    if (savingsPct < minSavings) {
      stats.skippedSmall++;
      continue;
    }

    stats.beforeBytes += original.length;
    stats.afterBytes += encoded.length;
    stats.rewritten++;
    log(
      `${dryRun ? "WOULD" : "SAVE "} ${(original.length / 1024).toFixed(1)}KB → ${(
        encoded.length / 1024
      ).toFixed(1)}KB (-${savingsPct.toFixed(0)}%) ${rel}`,
    );

    if (dryRun) continue;

    try {
      if (backup) await fs.copyFile(file, `${file}.orig`);
      const tmp = path.join(
        path.dirname(file),
        `.tmp-${crypto.randomUUID()}${ext}`,
      );
      await fs.writeFile(tmp, encoded);
      await fs.rename(tmp, file);
    } catch (err) {
      log(`FAIL write  ${rel} — ${err.message}`);
      stats.failed++;
    }
  }

  stats.savedBytes = stats.beforeBytes - stats.afterBytes;
  return stats;
}
