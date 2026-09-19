#!/usr/bin/env node
// ccui-passwd — host-side one-time-password admin for MyMu / claude-code-cli-ui.
//
// Emergency / bootstrap fallback for the in-app owner "Users" panel. Mints an
// admin-issued one-time password: the account signs in with it and is then
// forced to choose its own password before the app loads.
//
//   node scripts/ccui-passwd.mjs list
//   node scripts/ccui-passwd.mjs reset  <username>
//   node scripts/ccui-passwd.mjs create <username> [--owner] [--linux-user <lu>] [--agent-allow "<globs>"]
//
// Reads the same DB as the server: $DATABASE_PATH, else ~/.cloudcli/auth.db.
// Requires node 22 (better-sqlite3 / bcrypt NODE_MODULE_VERSION) — run from the
// repo (or deployed app) root so node_modules resolves.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomInt } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateOneTimePassword() {
  const groups = [];
  for (let g = 0; g < 3; g += 1) {
    let chunk = '';
    for (let i = 0; i < 4; i += 1) chunk += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(chunk);
  }
  return groups.join('-');
}

function resolveDbPath() {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  return path.join(os.homedir(), '.cloudcli', 'auth.db');
}

function ensureColumn(db) {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('must_change_password')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  }
}

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseFlags(args) {
  const flags = { owner: false, linuxUser: null, agentAllow: null };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--owner') flags.owner = true;
    else if (a === '--linux-user') flags.linuxUser = args[(i += 1)] ?? null;
    else if (a === '--agent-allow') flags.agentAllow = args[(i += 1)] ?? null;
    else die(`unknown option: ${a}`);
  }
  return flags;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) die(`database not found at ${dbPath} (set DATABASE_PATH?)`);
  const db = new Database(dbPath);
  ensureColumn(db);

  if (command === 'list') {
    const rows = db
      .prepare('SELECT id, username, account_owner, linux_user, must_change_password, last_login FROM users ORDER BY id')
      .all();
    if (!rows.length) return console.log('(no users)');
    for (const r of rows) {
      const tags = [
        r.account_owner ? 'owner' : null,
        r.linux_user ? `linux=${r.linux_user}` : null,
        r.must_change_password ? 'must-change-pw' : null,
      ].filter(Boolean).join(' ');
      console.log(`#${r.id}\t${r.username}\t${tags}\t${r.last_login ? `last-login ${r.last_login}` : 'never'}`);
    }
    return;
  }

  if (command === 'reset') {
    const username = rest[0];
    if (!username) die('usage: reset <username>');
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (!user) die(`no such user: ${username}`);
    const otp = generateOneTimePassword();
    const hash = await bcrypt.hash(otp, 12);
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash, user.id);
    console.log(`\nOne-time password for ${username}:\n\n    ${otp}\n\nThey sign in with it, then must set their own password.\n`);
    return;
  }

  if (command === 'create') {
    const username = rest[0];
    if (!username || username.length < 3) die('usage: create <username> (min 3 chars) [--owner] [--linux-user <lu>] [--agent-allow "<globs>"]');
    const flags = parseFlags(rest.slice(1));
    const otp = generateOneTimePassword();
    const hash = await bcrypt.hash(otp, 12);
    try {
      db.prepare(
        'INSERT INTO users (username, password_hash, account_owner, linux_user, agent_allow, must_change_password) VALUES (?, ?, ?, ?, ?, 1)'
      ).run(username, hash, flags.owner ? 1 : 0, flags.linuxUser, flags.agentAllow);
    } catch (e) {
      if (String(e?.code) === 'SQLITE_CONSTRAINT_UNIQUE') die(`user already exists: ${username}`);
      throw e;
    }
    console.log(`\nCreated user ${username}${flags.owner ? ' (owner)' : ''}. One-time password:\n\n    ${otp}\n\nThey sign in with it, then must set their own password.\n`);
    return;
  }

  console.error('usage:\n  ccui-passwd list\n  ccui-passwd reset  <username>\n  ccui-passwd create <username> [--owner] [--linux-user <lu>] [--agent-allow "<globs>"]');
  process.exit(1);
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
