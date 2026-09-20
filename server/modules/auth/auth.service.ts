import { AppError } from '@/shared/utils.js';

type AuthUser = {
  id: number | bigint;
  username: string;
};

type AuthLoginUser = AuthUser & {
  password_hash: string;
  must_change_password?: number;
  // model (b): authenticate against the linux password + which linux user to use.
  pam_auth?: number;
  linux_user?: string | null;
};

type AuthDependencies = {
  users: {
    hasUsers(): boolean;
    createUser(username: string, passwordHash: string): AuthUser;
    getUserByUsername(username: string): AuthLoginUser | undefined;
    updateLastLogin(userId: number): void;
    updatePassword(userId: number, passwordHash: string, mustChange: boolean): void;
  };
  // PAM/linux-password auth for opt-in (pam_auth) accounts. Absent behavior is
  // impossible — always injected; verify returns false when it can't authenticate.
  pam: {
    verifyLinuxPassword(linuxUser: string, password: string): Promise<boolean>;
    setSecret(linuxUser: string, password: string): void;
    clearSecret(linuxUser: string): void;
  };
  transaction: {
    begin(): void;
    commit(): void;
    rollback(): void;
  };
  hashPassword(password: string): Promise<string>;
  comparePassword(password: string, passwordHash: string): Promise<boolean>;
  generateToken(user: AuthUser): string;
};

function numericUserId(userId: number | bigint): number {
  return Number(userId);
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/**
 * Creates the Auth application service around explicit persistence, crypto,
 * transaction, and token dependencies.
 */
export function createAuthService(dependencies: AuthDependencies) {
  return {
    getStatus() {
      return {
        needsSetup: !dependencies.users.hasUsers(),
        isAuthenticated: false,
      };
    },

    async register(usernameInput: unknown, passwordInput: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';

      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }
      if (username.length < 3 || password.length < 6) {
        throw new AppError(
          'Username must be at least 3 characters, password at least 6 characters',
          { code: 'AUTH_CREDENTIALS_TOO_SHORT', statusCode: 400 },
        );
      }

      dependencies.transaction.begin();
      try {
        if (dependencies.users.hasUsers()) {
          throw new AppError('User already exists. This is a single-user system.', {
            code: 'AUTH_USER_ALREADY_CONFIGURED',
            statusCode: 403,
          });
        }

        const passwordHash = await dependencies.hashPassword(password);
        const user = dependencies.users.createUser(username, passwordHash);
        const token = dependencies.generateToken(user);
        dependencies.transaction.commit();
        dependencies.users.updateLastLogin(numericUserId(user.id));

        return {
          success: true,
          user: { id: user.id, username: user.username },
          token,
        };
      } catch (error) {
        dependencies.transaction.rollback();
        if (isUniqueConstraintError(error)) {
          throw new AppError('Username already exists', {
            code: 'AUTH_USERNAME_CONFLICT',
            statusCode: 409,
          });
        }
        throw error;
      }
    },

    async login(usernameInput: unknown, passwordInput: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }

      const user = dependencies.users.getUserByUsername(username);
      let validPassword = false;
      if (user) {
        if (user.pam_auth) {
          // model (b): authenticate against the LINUX password via `su`/PAM and,
          // on success, stash it for this session so file access can become the
          // linux user without any root sudo seam.
          const linuxUser = (user.linux_user && user.linux_user.trim()) || user.username;
          validPassword = await dependencies.pam.verifyLinuxPassword(linuxUser, password);
          if (validPassword) {
            dependencies.pam.setSecret(linuxUser, password);
          }
        } else {
          validPassword = await dependencies.comparePassword(password, user.password_hash);
        }
      }
      if (!user || !validPassword) {
        throw new AppError('Invalid username or password', {
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 401,
        });
      }

      dependencies.users.updateLastLogin(numericUserId(user.id));
      return {
        success: true,
        user: {
          id: user.id,
          username: user.username,
          // Tells the client to route straight to the forced change-password
          // screen when this login used an admin-issued one-time password.
          must_change_password: user.must_change_password ? 1 : 0,
        },
        token: dependencies.generateToken(user),
      };
    },

    /**
     * Sets a new password for the authenticated user.
     *
     * Two modes, both landing here:
     *  - Forced (must_change_password set): the user just signed in with an
     *    admin-issued one-time password, so no current-password re-check is
     *    required — the valid session token already proves the OTP was correct.
     *  - Voluntary (from Settings): the current password must be supplied and
     *    verified, and the new one must differ.
     * Either way the one-time-password flag is cleared and a fresh token issued.
     */
    async changePassword(
      authUser: unknown,
      currentPasswordInput: unknown,
      newPasswordInput: unknown,
    ) {
      if (
        typeof authUser !== 'object'
        || authUser === null
        || !('username' in authUser)
        || typeof (authUser as AuthUser).username !== 'string'
      ) {
        throw new AppError('Authenticated user is required', {
          code: 'AUTH_USER_REQUIRED',
          statusCode: 401,
        });
      }

      const newPassword = typeof newPasswordInput === 'string' ? newPasswordInput : '';
      const currentPassword = typeof currentPasswordInput === 'string' ? currentPasswordInput : '';
      if (newPassword.length < 6) {
        throw new AppError('New password must be at least 6 characters', {
          code: 'AUTH_PASSWORD_TOO_SHORT',
          statusCode: 400,
        });
      }

      const user = dependencies.users.getUserByUsername((authUser as AuthUser).username);
      if (!user) {
        throw new AppError('Invalid username or password', {
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 401,
        });
      }

      // PAM accounts authenticate against the linux password, which MyMu does not
      // manage — changing it belongs to the OS (`passwd`), not this endpoint.
      if (user.pam_auth) {
        throw new AppError('This account’s password is managed by the system', {
          code: 'AUTH_PAM_MANAGED',
          statusCode: 400,
        });
      }

      const forced = Boolean(user.must_change_password);
      if (!forced) {
        const validPassword = currentPassword
          ? await dependencies.comparePassword(currentPassword, user.password_hash)
          : false;
        if (!validPassword) {
          throw new AppError('Current password is incorrect', {
            code: 'AUTH_INVALID_CREDENTIALS',
            statusCode: 401,
          });
        }
        if (currentPassword === newPassword) {
          throw new AppError('New password must be different from the current one', {
            code: 'AUTH_PASSWORD_UNCHANGED',
            statusCode: 400,
          });
        }
      }

      const passwordHash = await dependencies.hashPassword(newPassword);
      dependencies.users.updatePassword(numericUserId(user.id), passwordHash, false);

      const updatedUser: AuthUser = { id: user.id, username: user.username };
      return {
        success: true,
        user: { id: user.id, username: user.username, must_change_password: 0 },
        token: dependencies.generateToken(updatedUser),
      };
    },

    getCurrentUser(user: unknown) {
      return { user };
    },

    refreshSession(user: unknown) {
      if (
        typeof user !== 'object'
        || user === null
        || !('id' in user)
        || !('username' in user)
        || (typeof user.id !== 'number' && typeof user.id !== 'bigint')
        || typeof user.username !== 'string'
      ) {
        throw new AppError('Authenticated user is required', {
          code: 'AUTH_USER_REQUIRED',
          statusCode: 401,
        });
      }

      return { token: dependencies.generateToken(user as AuthUser) };
    },

    logout(authUser?: unknown) {
      // Drop any in-memory linux-password secret held for this session (model b).
      if (
        typeof authUser === 'object'
        && authUser !== null
        && 'username' in authUser
        && typeof (authUser as AuthLoginUser).username === 'string'
      ) {
        const u = authUser as AuthLoginUser;
        if (u.pam_auth) {
          const linuxUser = (u.linux_user && u.linux_user.trim()) || u.username;
          dependencies.pam.clearSecret(linuxUser);
        }
      }
      return { success: true, message: 'Logged out successfully' };
    },
  };
}
