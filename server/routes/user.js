import express from 'express';
import { userDb, userHiddenAgentsDb } from '../modules/database/index.js';
import { authenticateToken } from '../middleware/auth.js';
import { getSystemGitConfig } from '../utils/gitConfig.js';
import { spawn } from 'child_process';

const router = express.Router();

function spawnAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('error', (error) => { reject(error); });
    child.on('close', (code) => {
      if (code === 0) { resolve({ stdout, stderr }); return; }
      const error = new Error(`Command failed: ${command} ${args.join(' ')}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

router.get('/git-config', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    let gitConfig = userDb.getGitConfig(userId);

    // If database is empty, try to get from system git config
    if (!gitConfig || (!gitConfig.git_name && !gitConfig.git_email)) {
      const systemConfig = await getSystemGitConfig();

      // If system has values, save them to database for this user
      if (systemConfig.git_name || systemConfig.git_email) {
        userDb.updateGitConfig(userId, systemConfig.git_name, systemConfig.git_email);
        gitConfig = systemConfig;
        console.log(`Auto-populated git config from system for user ${userId}: ${systemConfig.git_name} <${systemConfig.git_email}>`);
      }
    }

    res.json({
      success: true,
      gitName: gitConfig?.git_name || null,
      gitEmail: gitConfig?.git_email || null
    });
  } catch (error) {
    console.error('Error getting git config:', error);
    res.status(500).json({ error: 'Failed to get git configuration' });
  }
});

// Apply git config globally via git config --global
router.post('/git-config', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { gitName, gitEmail } = req.body;

    if (!gitName || !gitEmail) {
      return res.status(400).json({ error: 'Git name and email are required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(gitEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    userDb.updateGitConfig(userId, gitName, gitEmail);

    try {
      await spawnAsync('git', ['config', '--global', 'user.name', gitName]);
      await spawnAsync('git', ['config', '--global', 'user.email', gitEmail]);
      console.log(`Applied git config globally: ${gitName} <${gitEmail}>`);
    } catch (gitError) {
      console.error('Error applying git config:', gitError);
    }

    res.json({
      success: true,
      gitName,
      gitEmail
    });
  } catch (error) {
    console.error('Error updating git config:', error);
    res.status(500).json({ error: 'Failed to update git configuration' });
  }
});

router.post('/complete-onboarding', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    userDb.completeOnboarding(userId);

    res.json({
      success: true,
      message: 'Onboarding completed successfully'
    });
  } catch (error) {
    console.error('Error completing onboarding:', error);
    res.status(500).json({ error: 'Failed to complete onboarding' });
  }
});

router.get('/onboarding-status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const hasCompleted = userDb.hasCompletedOnboarding(userId);

    res.json({
      success: true,
      hasCompletedOnboarding: hasCompleted
    });
  } catch (error) {
    console.error('Error checking onboarding status:', error);
    res.status(500).json({ error: 'Failed to check onboarding status' });
  }
});

// --- Per-user hidden agents (display preference for the agents view) ----------
// `agent_key` is a STABLE agent identity (account label + title) minted by the
// client, NOT the volatile relay session id, so a hide survives an agent restart.
// This is a pure display layer scoped to req.user.id — it never affects another
// user's view or any access/security filter.

function readAgentKey(req) {
  const raw = req.body?.agentKey;
  return typeof raw === 'string' ? raw.trim() : '';
}

router.get('/hidden-agents', authenticateToken, (req, res) => {
  try {
    const hiddenAgentKeys = userHiddenAgentsDb.listKeys(req.user.id);
    res.json({ success: true, hiddenAgentKeys });
  } catch (error) {
    console.error('Error listing hidden agents:', error);
    res.status(500).json({ error: 'Failed to list hidden agents' });
  }
});

router.post('/hidden-agents', authenticateToken, (req, res) => {
  try {
    const agentKey = readAgentKey(req);
    if (!agentKey) {
      return res.status(400).json({ error: 'agentKey is required' });
    }
    userHiddenAgentsDb.hide(req.user.id, agentKey);
    res.json({ success: true, hiddenAgentKeys: userHiddenAgentsDb.listKeys(req.user.id) });
  } catch (error) {
    console.error('Error hiding agent:', error);
    res.status(500).json({ error: 'Failed to hide agent' });
  }
});

router.delete('/hidden-agents', authenticateToken, (req, res) => {
  try {
    const agentKey = readAgentKey(req);
    if (!agentKey) {
      return res.status(400).json({ error: 'agentKey is required' });
    }
    userHiddenAgentsDb.unhide(req.user.id, agentKey);
    res.json({ success: true, hiddenAgentKeys: userHiddenAgentsDb.listKeys(req.user.id) });
  } catch (error) {
    console.error('Error unhiding agent:', error);
    res.status(500).json({ error: 'Failed to unhide agent' });
  }
});

export default router;
