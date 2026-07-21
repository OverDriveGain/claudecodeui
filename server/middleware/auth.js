import jwt from 'jsonwebtoken';

import { userDb, appConfigDb } from '../modules/database/index.js';
import { IS_PLATFORM } from '../constants/config.js';
import { runWithUserContext } from '../services/user-context.js';

// Use env var if set, otherwise auto-generate a unique secret per installation
const JWT_SECRET = process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();

// BTI open-access mode: no login at all. /api/auth/status hands every new
// browser a signed guest token; tokens carry a `guest` claim instead of a DB
// user id. Guest tokens only verify while the mode is ON, so switching it off
// re-enables the login gate and orphans all guest sessions at once.
const OPEN_ACCESS = process.env.OPEN_ACCESS === 'true';

// A guest is a full (non-admin) user identity without a DB row — same shape the
// agent-view share tokens use. username drives the per-user workspace path.
const guestUserFrom = (decoded) => ({
  id: `guest:${decoded.guest}`,
  username: `guest-${decoded.guest}`,
  guest: true,
  // Same visibility as regular customer accounts on this instance (unrestricted).
  agent_allow: null,
});

// Optional API key middleware
const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }
  
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// JWT authentication middleware
const authenticateToken = async (req, res, next) => {
  // Platform mode:  use single database user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: 'Platform mode: No user found in database' });
      }
      req.user = user;
      // Carry the user's per-agent visibility for the rest of the request.
      return runWithUserContext(user.agent_allow, next);
    } catch (error) {
      console.error('Platform mode error:', error);
      return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
    }
  }

  // Normal OSS JWT validation
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  // Also check query param for SSE endpoints (EventSource can't set headers)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  // BTI: also accept the httpOnly cookie set by the email-magic-code login,
  // so a browser session works without the client attaching a header.
  if (!token && req.headers.cookie) {
    const match = req.headers.cookie.match(/(?:^|;\s*)bldr_token=([^;]+)/);
    if (match) {
      token = decodeURIComponent(match[1]);
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Agent-view token: a share token bound to ONE agent name, not a DB user.
    // The bearer gets exactly that agent's view — the standard per-user scoping
    // (agent_allow) enforces it across list/history/files/drive, so nothing else
    // is reachable. No DB row backs it; identity is the signed claim itself.
    if (typeof decoded.agentView === 'string' && decoded.agentView.length > 0) {
      req.user = {
        id: 'agent-view',
        username: `agent-view:${decoded.agentView}`,
        agentView: decoded.agentView,
        agent_allow: decoded.agentView,
      };
      return runWithUserContext(decoded.agentView, next);
    }

    // Open-access guest token: no DB row backs it; identity is the signed claim.
    if (OPEN_ACCESS && typeof decoded.guest === 'string' && decoded.guest) {
      const guest = guestUserFrom(decoded);
      req.user = guest;
      return runWithUserContext(guest.agent_allow, next);
    }

    // Verify user still exists and is active
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token. User not found.' });
    }

    // Auto-refresh: if token is past halfway through its lifetime, issue a new one
    if (decoded.exp && decoded.iat) {
      const now = Math.floor(Date.now() / 1000);
      const halfLife = (decoded.exp - decoded.iat) / 2;
      if (now > decoded.iat + halfLife) {
        const newToken = generateToken(user);
        res.setHeader('X-Refreshed-Token', newToken);
      }
    }

    req.user = user;
    // Carry the user's per-agent visibility for the rest of the request.
    return runWithUserContext(user.agent_allow, next);
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// Generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// WebSocket authentication function
const authenticateWebSocket = (token) => {
  // Platform mode: bypass token validation, return first user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (user) {
        return { id: user.id, userId: user.id, username: user.username, agent_allow: user.agent_allow };
      }
      return null;
    } catch (error) {
      console.error('Platform mode WebSocket error:', error);
      return null;
    }
  }

  // Normal OSS JWT validation
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Agent-view share token — same scoped identity as the REST path above.
    if (typeof decoded.agentView === 'string' && decoded.agentView.length > 0) {
      return {
        userId: 'agent-view',
        username: `agent-view:${decoded.agentView}`,
        agentView: decoded.agentView,
        agent_allow: decoded.agentView,
      };
    }
    // Open-access guest token — same guest identity as the REST path above.
    if (OPEN_ACCESS && typeof decoded.guest === 'string' && decoded.guest) {
      const guest = guestUserFrom(decoded);
      return { userId: guest.id, username: guest.username, guest: true, agent_allow: guest.agent_allow };
    }
    // Verify user actually exists in database (matches REST authenticateToken behavior)
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return null;
    }
    return { userId: user.id, username: user.username, agent_allow: user.agent_allow };
  } catch (error) {
    console.error('WebSocket token verification error:', error);
    return null;
  }
};

export {
  validateApiKey,
  authenticateToken,
  generateToken,
  authenticateWebSocket,
  JWT_SECRET,
  OPEN_ACCESS
};
