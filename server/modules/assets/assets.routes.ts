import express from 'express';
import multer from 'multer';

import {
  buildStoredAttachmentRecords,
  buildStoredImageRecords,
  ensureImageAssetsDir,
  isAllowedImageMimeType,
  openStoredAttachmentAsset,
} from '@/modules/assets/services/image-assets.service.js';

const router = express.Router();

// MYMU: attachment size policy. Derived from the SAME env contract as the
// landing path (`CCUI_MAX_ATTACHMENT_MB`, default 1 GB) and reported by
// `GET /api/limits`, so the upload gate here, the lander, and the client all
// agree — the upload endpoint never accepts a file the landing step would later
// reject. (Read from env rather than importing the constant so this module keeps
// its architectural boundary; the env var is the single source of truth.)
const MYMU_MAX_ASSET_MB = Math.max(
  1,
  Number.parseInt(process.env.CCUI_MAX_ATTACHMENT_MB ?? '', 10) || 1024,
);
const MYMU_MAX_ASSET_SIZE_BYTES = MYMU_MAX_ASSET_MB * 1024 * 1024;

/**
 * MYMU: turn a multer/upload rejection into a specific, user-facing reason.
 * The bare multer messages ("File too large") omit the actual cap, so the user
 * can't tell what limit they hit; spell it out.
 */
function uploadErrorMessage(err: unknown): string {
  const code = (err as { code?: string })?.code;
  if (code === 'LIMIT_FILE_SIZE') {
    const cap = MYMU_MAX_ASSET_MB >= 1024 && MYMU_MAX_ASSET_MB % 1024 === 0
      ? `${MYMU_MAX_ASSET_MB / 1024} GB`
      : `${MYMU_MAX_ASSET_MB} MB`;
    return `File too large — max ${cap} per file. To send a bigger file, open the project's Files and upload it there.`;
  }
  if (code === 'LIMIT_FILE_COUNT') return 'Too many files — up to 10 at once.';
  if (err instanceof Error && err.message) return err.message;
  return 'Upload failed';
}

// Multer writes uploads straight into the global assets folder; the service
// owns the folder location and the response record shape.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureImageAssetsDir()
      .then((assetsDir) => cb(null, assetsDir))
      .catch((error) => cb(error as Error, ''));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${uniqueSuffix}-${sanitizedName}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (isAllowedImageMimeType(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed.'));
    }
  },
  limits: {
    // MYMU: deployment policy allows large attachments (env-tunable, default 200MB)
    fileSize: MYMU_MAX_ASSET_SIZE_BYTES,
    files: 10,
  },
});

const attachmentUpload = multer({
  storage,
  limits: {
    fileSize: MYMU_MAX_ASSET_SIZE_BYTES, // MYMU: same 200MB policy as images
    files: 10,
  },
});

/**
 * Stores chat image attachments in the global `~/.cloudcli/assets` folder and
 * returns their absolute paths for use in provider prompts and chat history.
 */
router.post('/images', (req, res) => {
  upload.array('images', 5)(req, res, (err: unknown) => {
    if (err) {
      return res.status(400).json({ error: uploadErrorMessage(err) });
    }

    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No image files provided' });
    }

    res.json({ images: buildStoredImageRecords(files) });
  });
});

/**
 * Stores provider-neutral chat attachments. Files of any MIME type are
 * accepted because providers inspect them as data through their file-reading
 * tools; uploads are capped at 10 files and the MyMu attachment cap (1 GB) per
 * file — bigger files go through the project Files upload, which streams to disk.
 */
router.post('/files', (req, res) => {
  attachmentUpload.array('files', 10)(req, res, (err: unknown) => {
    if (err) {
      return res.status(400).json({ error: uploadErrorMessage(err) });
    }

    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    res.json({ attachments: buildStoredAttachmentRecords(files) });
  });
});

/**
 * Serves one stored image asset by filename. Only files directly inside the
 * global assets folder are reachable; traversal attempts resolve to null.
 */
router.get('/images/:filename', async (req, res) => {
  const asset = await openStoredAttachmentAsset(req.params.filename);
  if (asset.status === 'invalid') {
    return res.status(400).json({ error: 'Invalid asset filename' });
  }
  if (asset.status === 'missing') {
    return res.status(404).json({ error: 'Asset not found' });
  }

  res.setHeader('Content-Type', asset.contentType);
  // Stored-XSS hardening: never let the browser sniff a different type, and
  // force SVGs (which can carry scripts when rendered as a document) to
  // download instead of rendering inline. The chat UI is unaffected — it
  // fetches assets as blobs and shows them through <img>, where SVG scripts
  // never execute.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (asset.contentType === 'image/svg+xml') {
    res.setHeader('Content-Disposition', 'attachment');
  }
  asset.stream.pipe(res);
  asset.stream.on('error', (error) => {
    console.error('Error streaming image asset:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error reading asset' });
    }
  });
});

/**
 * Downloads one stored non-image attachment. Content-Disposition prevents
 * uploaded HTML or other active formats from rendering in the application.
 */
router.get('/files/:filename', async (req, res) => {
  const asset = await openStoredAttachmentAsset(req.params.filename);
  if (asset.status === 'invalid') {
    return res.status(400).json({ error: 'Invalid asset filename' });
  }
  if (asset.status === 'missing') {
    return res.status(404).json({ error: 'Asset not found' });
  }

  res.setHeader('Content-Type', asset.contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename.replace(/["\r\n]/g, '_')}"`);
  asset.stream.pipe(res);
  asset.stream.on('error', (error) => {
    console.error('Error streaming attachment asset:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error reading asset' });
    }
  });
});

export default router;
