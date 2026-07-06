import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { userDb } from '../modules/database/index.js';
import { getConnection } from '../modules/database/connection.js';
import { generateToken, authenticateToken, JWT_SECRET } from '../middleware/auth.js';
import { currentAgentAllow } from '../services/user-context.js';

const router = express.Router();
const db = getConnection();

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
      // Check if users already exist (only allow one user)
      const hasUsers = userDb.hasUsers();
      if (hasUsers) {
        db.prepare('ROLLBACK').run();
        return res.status(403).json({ error: 'User already exists. This is a single-user system.' });
      }
      
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

// Get current user (protected route)
router.get('/user', authenticateToken, (req, res) => {
  res.json({
    user: req.user
  });
});

// Mint an agent-view share token: a JWT bound to ONE agent name. Whoever opens
// the app with it (?token=… or token sign-in) gets a focused single-agent view —
// that agent's conversation + files, nothing else. Server-enforced end to end by
// the standard agent_allow scoping; the UI collapse is cosmetic on top.
// Admin-only: a restricted user (or another share-token bearer) must not be able
// to mint visibility they don't have.
router.post('/agent-view-token', authenticateToken, (req, res) => {
  try {
    if (req.user?.agentView || currentAgentAllow()?.length) {
      return res.status(403).json({ error: 'Only an unrestricted user can mint agent-view tokens' });
    }
    const agent = typeof req.body?.agent === 'string' ? req.body.agent.trim() : '';
    if (!agent) {
      return res.status(400).json({ error: 'agent (name) is required' });
    }
    // Keep the claim a plain name/glob — it becomes the bearer's agent_allow.
    const expiresIn = typeof req.body?.expiresIn === 'string' && req.body.expiresIn ? req.body.expiresIn : '30d';
    const token = jwt.sign({ agentView: agent }, JWT_SECRET, { expiresIn });
    const url = `${req.protocol}://${req.get('host')}/?token=${encodeURIComponent(token)}`;
    res.json({ token, url, agent, expiresIn });
  } catch (error) {
    console.error('Agent-view token error:', error);
    res.status(500).json({ error: 'Failed to mint agent-view token' });
  }
});

// Logout (client-side token removal, but this endpoint can be used for logging)
router.post('/logout', authenticateToken, (req, res) => {
  // In a simple JWT system, logout is mainly client-side
  // This endpoint exists for consistency and potential future logging
  res.json({ success: true, message: 'Logged out successfully' });
});

export default router;
