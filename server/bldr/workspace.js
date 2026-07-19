/**
 * Per-user workspace path resolution — shared by auth (create) and bldr (serve).
 * Each user's project files live under WORKSPACE_BASE/<slug(email)>.
 */
import path from 'path';

export const WORKSPACE_BASE = process.env.BLDR_WORKSPACE_BASE || '/home/bti/customers';

export const slug = (email) =>
  String(email || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const workspacePathFor = (username) => path.join(WORKSPACE_BASE, slug(username));
