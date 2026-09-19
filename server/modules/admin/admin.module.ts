import { createRequire } from 'node:module';

import { userDb } from '@/modules/database/index.js';

import { createAdminRouter } from './admin.routes.js';
import { createAdminService } from './admin.service.js';
import { generateOneTimePassword } from './one-time-password.js';

type BcryptAdapter = {
  hash(password: string, saltRounds: number): Promise<string>;
};

// bcrypt ships no TypeScript declarations here; narrow its CommonJS surface at
// the composition root, exactly as the auth module does.
const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt') as BcryptAdapter;

const adminService = createAdminService({
  users: {
    listUsers: () => userDb.listUsers(),
    getUserById: (userId) => userDb.getUserById(userId),
    adminCreateUser: (username, passwordHash, options) =>
      userDb.adminCreateUser(username, passwordHash, options),
    updatePassword: (userId, passwordHash, mustChange) =>
      userDb.updatePassword(userId, passwordHash, mustChange),
  },
  hashPassword: (password) => bcrypt.hash(password, 12),
  generateOneTimePassword,
});

/** Owner-only user administration router assembled for the server entrypoint. */
export const adminRoutes = createAdminRouter(adminService);
