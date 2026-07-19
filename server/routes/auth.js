import express from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { userDb } from '../modules/database/index.js';
import { getConnection } from '../modules/database/connection.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';
import { sendLoginToken } from '../modules/email/login-email.js';
import { seedWorkspace } from '../bldr/seed.js';
import { workspacePathFor } from '../bldr/workspace.js';

const router = express.Router();
const db = getConnection();

// --- BTI passwordless email-token login -----------------------------------
// The user enters their EMAIL → we email them a durable login TOKEN. That token
// *is* their login: pasting it (now or any time later) signs them in. The prompt
// accepts either an email (to get a token) or a token (to sign in).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_PREFIX = 'bldr_';
const TOKEN_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000; // ~10y — effectively durable
const AUTH_COOKIE = 'bldr_token';

// Login tokens are high-entropy, so hash the token alone (no email needed at
// sign-in time — the token resolves to its owner).
const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

const newLoginToken = () => `${TOKEN_PREFIX}${crypto.randomBytes(24).toString('hex')}`;

// Each user gets their own workspace directory — the agent runs there, so their
// conversations/files are physically separated by path. (Process-level isolation
// + encryption are the deferred docker step; this gives the per-user landing.)
// workspacePathFor lives in ../bldr/workspace.js (shared with the bldr routes).
const ensureWorkspace = (username) => {
  const wp = workspacePathFor(username);
  try {
    fs.mkdirSync(wp, { recursive: true });
    seedWorkspace(wp); // idempotent: mock bldr.json + assets + bldr-backend CLAUDE.md
  } catch (err) {
    console.error('[workspace] failed to create', wp, err?.message || err);
  }
  return wp;
};

const setAuthCookie = (res, token) => {
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7d, matches JWT lifetime
    path: '/',
  });
};

// Check auth status and setup requirements
router.get('/status', async (req, res) => {
  try {
    const hasUsers = await userDb.hasUsers();
    res.json({ 
      needsSetup: !hasUsers,
      isAuthenticated: false // Will be overridden by frontend if token exists
    });
  } catch (error) {
    console.error('Auth status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// User registration (setup) - only allowed if no users exist
router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Validate input
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    if (username.length < 3 || password.length < 6) {
      return res.status(400).json({ error: 'Username must be at least 3 characters, password at least 6 characters' });
    }
    
    // Use a transaction to prevent race conditions
    db.prepare('BEGIN').run();
    try {
      // BTI: multi-user signup. The upstream single-user lock is removed so each
      // customer can create their own account. Username uniqueness is still
      // enforced by the DB constraint (handled in the catch below).

      // Hash password
      const saltRounds = 12;
      const passwordHash = await bcrypt.hash(password, saltRounds);
      
      // Create user
      const user = userDb.createUser(username, passwordHash);
      
      // Generate token
      const token = generateToken(user);
      
      db.prepare('COMMIT').run();

      // Update last login (non-fatal, outside transaction)
      userDb.updateLastLogin(user.id);

      res.json({
        success: true,
        user: { id: user.id, username: user.username },
        token
      });
    } catch (error) {
      db.prepare('ROLLBACK').run();
      throw error;
    }
    
  } catch (error) {
    console.error('Registration error:', error);
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: 'Username already exists' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// User login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Validate input
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    // Get user from database
    const user = userDb.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    // Generate token
    const token = generateToken(user);
    
    // Update last login
    userDb.updateLastLogin(user.id);
    
    res.json({
      success: true,
      user: { id: user.id, username: user.username },
      token
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Enter email → email a durable login token (rotates any previous one).
router.post('/request-token', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }

    // One active token per email: drop the old, store the hash of the new.
    const token = newLoginToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
    db.prepare('DELETE FROM login_tokens WHERE email = ?').run(email);
    db.prepare(
      'INSERT INTO login_tokens (email, token_hash, expires_at) VALUES (?, ?, ?)',
    ).run(email, hashToken(token), expiresAt);

    const result = await sendLoginToken(email, token);

    // Never reveal whether the email already had an account; always say "sent".
    res.json({
      success: true,
      delivered: result.delivered,
      ...(result.devToken ? { devToken: result.devToken } : {}),
    });
  } catch (error) {
    console.error('request-token error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Paste token → resolve its owner, sign them in (reusable, not consumed).
router.post('/token-login', async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token.startsWith(TOKEN_PREFIX)) {
      return res.status(400).json({ error: 'That is not a valid login token.' });
    }

    const row = db.prepare(
      'SELECT email, expires_at FROM login_tokens WHERE token_hash = ? LIMIT 1',
    ).get(hashToken(token));

    if (!row) {
      return res.status(401).json({ error: 'This token is not valid. Enter your email to get a new one.' });
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(401).json({ error: 'This token has expired. Enter your email to get a new one.' });
    }

    // Create the user on first sign-in; the token maps to this email/account.
    const throwawayHash = `magic:${crypto.randomBytes(16).toString('hex')}`;
    const user = userDb.getOrCreateByEmail(row.email, throwawayHash);

    // Ensure their workspace exists so the agent has a valid cwd to land in.
    const workspacePath = ensureWorkspace(user.username);

    const jwt = generateToken({ id: user.id, username: user.username });
    userDb.updateLastLogin(user.id);
    setAuthCookie(res, jwt);

    res.json({
      success: true,
      user: { id: user.id, username: user.username, workspacePath },
      token: jwt,
    });
  } catch (error) {
    console.error('token-login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user (protected route). Include the per-user workspace path so a
// reloaded session lands back in the user's own project (and make sure it exists).
router.get('/user', authenticateToken, (req, res) => {
  const workspacePath = req.user?.username ? ensureWorkspace(req.user.username) : undefined;
  res.json({
    user: { ...req.user, workspacePath },
  });
});

// Logout (client-side token removal, but this endpoint can be used for logging)
router.post('/logout', authenticateToken, (req, res) => {
  // Clear the httpOnly auth cookie; client also drops its stored token.
  res.clearCookie(AUTH_COOKIE, { path: '/' });
  res.json({ success: true, message: 'Logged out successfully' });
});

export default router;
