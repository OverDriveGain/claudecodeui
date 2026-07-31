import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import mime from 'mime-types';

import type { AnyRecord } from '@/shared/types.js';

/**
 * Global chat-attachment store, same contract as stock claudecodeui: uploads
 * land here via POST /api/assets/images|files and chat.send references them by
 * absolute path. Only direct children of this folder are ever readable through
 * those references, so a crafted path can never reach anything else.
 */
export const ASSETS_DIR = path.join(os.homedir(), '.claudecodeui', 'assets');

export async function ensureAssetsDir(): Promise<string> {
  await fs.mkdir(ASSETS_DIR, { recursive: true });
  return ASSETS_DIR;
}

/**
 * Resolves an asset reference (absolute path or bare filename) to its real
 * path inside the store, or null when it is empty, traverses, or would escape.
 */
export function resolveStoredAssetPath(reference: string): string | null {
  if (!reference || typeof reference !== 'string') {
    return null;
  }
  const resolved = path.resolve(ASSETS_DIR, reference);
  const relative = path.relative(ASSETS_DIR, resolved);
  const isDirectChild =
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative) &&
    !relative.includes(path.sep) &&
    !relative.includes('/');
  return isDirectChild ? resolved : null;
}

/**
 * Converts store-referenced attachment descriptors ({name?, path}) in
 * `options.images` / `options.files` / `options.attachments` into the inline
 * `{name, data: "data:<mime>;base64,…"}` shape the provider pipeline consumes.
 * Entries that already carry inline `data` pass through untouched; references
 * outside the store are dropped. The merged list lands on `options.images`
 * (the field every internal consumer reads).
 */
export async function materializeAttachmentOptions(options: AnyRecord): Promise<void> {
  const candidates: unknown[] = [];
  for (const key of ['images', 'files', 'attachments']) {
    const value = options[key];
    if (Array.isArray(value)) {
      candidates.push(...value);
    }
  }
  if (candidates.length === 0) {
    return;
  }

  const materialized: Array<{ name: string; data: string }> = [];
  const seenPaths = new Set<string>();
  for (const entry of candidates) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as AnyRecord;
    if (typeof record.data === 'string' && record.data.startsWith('data:')) {
      materialized.push({ name: String(record.name ?? 'attachment'), data: record.data });
      continue;
    }
    const reference = typeof record.path === 'string' ? record.path : '';
    const resolved = resolveStoredAssetPath(reference);
    if (!resolved || seenPaths.has(resolved)) {
      if (reference) console.warn(`[Assets] Dropping attachment outside the store: ${reference}`);
      continue;
    }
    seenPaths.add(resolved);
    try {
      const bytes = await fs.readFile(resolved);
      const mimeType =
        (typeof record.mimeType === 'string' && record.mimeType) ||
        mime.lookup(resolved) ||
        'application/octet-stream';
      materialized.push({
        name: String(record.name ?? path.basename(resolved)),
        data: `data:${mimeType};base64,${bytes.toString('base64')}`,
      });
    } catch (error) {
      console.warn(`[Assets] Could not read stored attachment ${resolved}:`, error);
    }
  }

  delete options.files;
  delete options.attachments;
  if (materialized.length > 0) {
    options.images = materialized;
  } else {
    delete options.images;
  }
}
