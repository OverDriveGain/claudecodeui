import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

import express from 'express';
import mime from 'mime-types';
import multer from 'multer';

import { ASSETS_DIR, ensureAssetsDir, resolveStoredAssetPath } from '@/modules/assets/asset-store.js';

const router = express.Router();

// Stock-claudecodeui asset-store contract (same routes, fields, and response
// shapes) so one client attachment flow works against MyMu and stock servers
// alike. Caps follow this deployment's 200MB attachment policy instead of
// stock's 5/10MB.
const MAX_ASSET_SIZE_BYTES = 200 * 1024 * 1024;
const MAX_ASSET_FILES = 10;

type MulterNameCallback = (error: Error | null, value: string) => void;

const storage = multer.diskStorage({
  destination: (_req: express.Request, _file: { originalname: string }, cb: MulterNameCallback) => {
    ensureAssetsDir()
      .then((dir) => cb(null, dir))
      .catch((error) => cb(error as Error, ''));
  },
  filename: (_req: express.Request, file: { originalname: string }, cb: MulterNameCallback) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${uniqueSuffix}-${sanitizedName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_ASSET_SIZE_BYTES, files: MAX_ASSET_FILES },
});

type StoredFile = { originalname: string; filename: string; size: number; mimetype: string };

const toRecords = (files: StoredFile[]) =>
  files.map((file) => ({
    name: file.originalname,
    path: path.join(ASSETS_DIR, file.filename).split(path.sep).join('/'),
    size: file.size,
    mimeType: file.mimetype,
  }));

/** Stores chat image attachments; returns absolute store paths (stock shape). */
router.post('/images', (req, res) => {
  upload.array('images', MAX_ASSET_FILES)(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      return res.status(400).json({ error: message });
    }
    const uploaded = (req as express.Request & { files?: unknown }).files;
    const files = Array.isArray(uploaded) ? (uploaded as StoredFile[]) : [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No image files provided' });
    }
    res.json({ images: toRecords(files) });
  });
});

/** Stores provider-neutral chat attachments of any type (stock shape). */
router.post('/files', (req, res) => {
  upload.array('files', MAX_ASSET_FILES)(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      return res.status(400).json({ error: message });
    }
    const uploaded = (req as express.Request & { files?: unknown }).files;
    const files = Array.isArray(uploaded) ? (uploaded as StoredFile[]) : [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }
    res.json({ attachments: toRecords(files) });
  });
});

/**
 * Serves one stored asset by filename; only direct children of the store are
 * reachable. Sniffing is disabled and SVGs download instead of rendering, so a
 * stored file can never run as a document on this origin.
 */
router.get('/images/:filename', async (req, res) => {
  const resolved = resolveStoredAssetPath(req.params.filename);
  if (!resolved) {
    return res.status(400).json({ error: 'Invalid asset filename' });
  }
  try {
    await fs.access(resolved);
  } catch {
    return res.status(404).json({ error: 'Asset not found' });
  }
  const contentType = mime.lookup(resolved) || 'application/octet-stream';
  res.setHeader('Content-Type', String(contentType));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (String(contentType).includes('svg')) {
    res.setHeader('Content-Disposition', 'attachment');
  }
  createReadStream(resolved).pipe(res);
});

export default router;
