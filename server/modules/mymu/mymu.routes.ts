// MYMU: MyMu's own endpoints, kept in one module so upstream files stay pristine.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { type Request, type Response } from 'express';

import { authenticateToken } from '@/modules/auth/index.js';
import { userDb } from '@/modules/database/index.js';

const router = express.Router();

type AuthedRequest = Request & { user?: { id?: number } };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist-server/server/modules/mymu → app root is four levels up at runtime.
const APP_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/**
 * Stack version info — package version, when the server build was produced, and
 * which client bundle this instance serves. Unauthenticated on purpose: it holds
 * nothing sensitive and lets any client (and the Hosts dialog for peer hosts)
 * answer "which build is deployed here?" at a glance.
 */
let versionInfoCache: { name: string; version: string; builtAt: string | null; bundle: string | null } | null = null;
router.get('/version', (_req: Request, res: Response) => {
  if (!versionInfoCache) {
    let version = 'unknown';
    let builtAt: string | null = null;
    let bundle: string | null = null;
    try {
      version = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || 'unknown';
    } catch { /* keep default */ }
    try {
      builtAt = fs.statSync(path.join(__dirname, '..', '..', 'index.js')).mtime.toISOString();
    } catch { /* keep default */ }
    try {
      const html = fs.readFileSync(path.join(APP_ROOT, 'dist', 'index.html'), 'utf8');
      bundle = (html.match(/index-[A-Za-z0-9_-]+\.js/) || [null])[0];
    } catch { /* keep default */ }
    versionInfoCache = { name: 'MyMu', version, builtAt, bundle };
  }
  res.json(versionInfoCache);
});

/**
 * Per-tenant "bring an offline agent online" command (Settings → Agents).
 * A shell template run AS this account's linux_user when a user clicks an
 * offline agent; `{name}` is substituted with the agent name. Empty = off.
 */
router.get('/agent-start-command', authenticateToken, (req: Request, res: Response) => {
  const uid = Number((req as AuthedRequest).user?.id);
  const cfg = userDb.getAgentStartConfig(uid);
  res.json({ command: cfg?.agent_start_cmd ?? null, linuxUser: cfg?.linux_user ?? null });
});

router.put('/agent-start-command', authenticateToken, (req: Request, res: Response) => {
  const uid = Number((req as AuthedRequest).user?.id);
  const raw = (req.body ?? {}).command;
  const command = typeof raw === 'string' ? raw : null;
  userDb.updateAgentStartCmd(uid, command);
  const cfg = userDb.getAgentStartConfig(uid);
  res.json({ command: cfg?.agent_start_cmd ?? null, linuxUser: cfg?.linux_user ?? null });
});

export default router;
