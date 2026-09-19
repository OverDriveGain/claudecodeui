import { AppError } from '@/shared/utils.js';
import type { CreateUserOptions, UserAdminRow, UserPublicRow } from '@/modules/database/index.js';

type CreatedUser = { id: number | bigint; username: string };

type AdminDependencies = {
  users: {
    listUsers(): UserAdminRow[];
    getUserById(userId: number): UserPublicRow | undefined;
    adminCreateUser(username: string, passwordHash: string, options: CreateUserOptions): CreatedUser;
    updatePassword(userId: number, passwordHash: string, mustChange: boolean): void;
  };
  hashPassword(password: string): Promise<string>;
  generateOneTimePassword(): string;
};

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

// The admin panel never needs the password hash and the client expects plain
// booleans — normalise the raw row into a safe, stable shape. `is_active` is
// only present on list rows; a row fetched by id is always active (the query
// filters on it), so default it to true.
function toPublicUser(row: UserAdminRow | UserPublicRow) {
  const isActive = 'is_active' in row ? Boolean(row.is_active) : true;
  return {
    id: Number(row.id),
    username: row.username,
    accountOwner: Boolean(row.account_owner),
    linuxUser: row.linux_user,
    agentAllow: row.agent_allow,
    agentDeny: row.agent_deny,
    mustChangePassword: Boolean(row.must_change_password),
    isActive,
    lastLogin: row.last_login,
    createdAt: row.created_at,
  };
}

/**
 * Owner-only account administration: list accounts, create a new account with an
 * admin-issued one-time password, and reset any account's password to a fresh
 * one-time password. Every created/reset password is returned exactly once (it
 * is only stored hashed) and carries the force-change flag so the user must pick
 * their own password on next sign-in.
 */
export function createAdminService(dependencies: AdminDependencies) {
  return {
    listUsers() {
      return { success: true, users: dependencies.users.listUsers().map(toPublicUser) };
    },

    async createUser(usernameInput: unknown, optionsInput: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput.trim() : '';
      if (username.length < 3) {
        throw new AppError('Username must be at least 3 characters', {
          code: 'ADMIN_USERNAME_TOO_SHORT',
          statusCode: 400,
        });
      }

      const options = (typeof optionsInput === 'object' && optionsInput !== null ? optionsInput : {}) as {
        accountOwner?: unknown;
        linuxUser?: unknown;
        agentAllow?: unknown;
      };
      const createOptions: CreateUserOptions = {
        accountOwner: Boolean(options.accountOwner),
        linuxUser: typeof options.linuxUser === 'string' ? options.linuxUser : null,
        agentAllow: typeof options.agentAllow === 'string' ? options.agentAllow : null,
        mustChangePassword: true,
      };

      const oneTimePassword = dependencies.generateOneTimePassword();
      const passwordHash = await dependencies.hashPassword(oneTimePassword);

      let created: CreatedUser;
      try {
        created = dependencies.users.adminCreateUser(username, passwordHash, createOptions);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new AppError('A user with that name already exists', {
            code: 'ADMIN_USERNAME_CONFLICT',
            statusCode: 409,
          });
        }
        throw error;
      }

      const row = dependencies.users.getUserById(Number(created.id));
      return {
        success: true,
        user: row ? toPublicUser(row) : { id: Number(created.id), username: created.username },
        oneTimePassword,
      };
    },

    async resetPassword(userIdInput: unknown) {
      const userId = Number(userIdInput);
      if (!Number.isInteger(userId) || userId <= 0) {
        throw new AppError('A valid user id is required', {
          code: 'ADMIN_USER_ID_INVALID',
          statusCode: 400,
        });
      }

      const row = dependencies.users.getUserById(userId);
      if (!row) {
        throw new AppError('User not found', { code: 'ADMIN_USER_NOT_FOUND', statusCode: 404 });
      }

      const oneTimePassword = dependencies.generateOneTimePassword();
      const passwordHash = await dependencies.hashPassword(oneTimePassword);
      dependencies.users.updatePassword(userId, passwordHash, true);

      return { success: true, username: row.username, oneTimePassword };
    },
  };
}
