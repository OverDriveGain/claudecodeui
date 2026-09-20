// MYMU: this upstream file carries MyMu modifications — F3 multi-user (linux_user/account_owner/agent_allow + mappings).
// Diff against upstream main to see the exact hunks (see FORK.md).
/**
 * User repository.
 *
 * Provides typed CRUD operations for the `users` table.
 * This is a single-user system, but the schema supports multiple
 * users for forward compatibility.
 */

import { getConnection } from '@/modules/database/connection.js';

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
  last_login: string | null;
  is_active: number;
  git_name: string | null;
  git_email: string | null;
  has_completed_onboarding: number;
  agent_allow: string | null;
  // Per-user agent block-list: comma/space-separated globs this account may NOT
  // see. Overrides agent_allow, path-ownership AND account_owner. NULL = none.
  agent_deny: string | null;
  // One-instance-per-host model: the linux user this account maps to (NULL =
  // same as username) and the operator role that sees everything the
  // deployment surfaces.
  linux_user: string | null;
  account_owner: number;
  // Per-tenant command template to bring an offline agent online (run as
  // linux_user; `{name}` substituted). NULL/empty = feature off.
  agent_start_cmd: string | null;
  // Per-user model block-list: comma/space-separated model values this account
  // may NOT use. NULL/empty = no restriction. Owners are exempt.
  model_deny: string | null;
  // 1 while the password is an admin-issued one-time password the user must
  // replace before reaching the app; 0 once they have set their own.
  must_change_password: number;
  // 1 = authenticate this account against the linux password (PAM/`su`) rather
  // than the bcrypt hash, and reach its files as that linux user. 0 = bcrypt.
  pam_auth: number;
};

export type UserPublicRow = Pick<
  UserRow,
  'id' | 'username' | 'created_at' | 'last_login' | 'agent_allow' | 'agent_deny' | 'linux_user' | 'account_owner' | 'agent_start_cmd' | 'model_deny' | 'must_change_password' | 'pam_auth'
>;

// Admin-view row for the Users management panel — everything the owner needs to
// see, never the password hash.
export type UserAdminRow = UserPublicRow & { is_active: number };

export type CreateUserOptions = {
  accountOwner?: boolean;
  linuxUser?: string | null;
  agentAllow?: string | null;
  mustChangePassword?: boolean;
  pamAuth?: boolean;
};

type UserGitConfig = {
  git_name: string | null;
  git_email: string | null;
};

type CreateUserResult = {
  id: number | bigint;
  username: string;
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const userDb = {
  /** Returns true if at least one user exists in the database. */
  hasUsers(): boolean {
    const db = getConnection();
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as {
      count: number;
    };
    return row.count > 0;
  },

  /** Inserts a new user and returns the created ID + username. */
  createUser(username: string, passwordHash: string, agentAllow: string | null = null): CreateUserResult {
    const db = getConnection();
    const result = db
      .prepare('INSERT INTO users (username, password_hash, agent_allow) VALUES (?, ?, ?)')
      .run(username, passwordHash, agentAllow);
    return { id: result.lastInsertRowid, username };
  },

  /**
   * Admin path for creating an additional account (owner-only surface). Unlike
   * `createUser`, it can stamp the operator role, a linux-user mapping, an
   * agent allow-list, and the one-time-password force-change flag in one insert.
   */
  adminCreateUser(username: string, passwordHash: string, options: CreateUserOptions = {}): CreateUserResult {
    const db = getConnection();
    const linuxUser = typeof options.linuxUser === 'string' && options.linuxUser.trim()
      ? options.linuxUser.trim()
      : null;
    const agentAllow = typeof options.agentAllow === 'string' && options.agentAllow.trim()
      ? options.agentAllow.trim()
      : null;
    const result = db
      .prepare(
        'INSERT INTO users (username, password_hash, account_owner, linux_user, agent_allow, must_change_password, pam_auth) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        username,
        passwordHash,
        options.accountOwner ? 1 : 0,
        linuxUser,
        agentAllow,
        options.mustChangePassword ? 1 : 0,
        options.pamAuth ? 1 : 0,
      );
    return { id: result.lastInsertRowid, username };
  },

  /** Toggle whether an account authenticates via the linux password (PAM/`su`). */
  updatePamAuth(userId: number, on: boolean): void {
    const db = getConnection();
    db.prepare('UPDATE users SET pam_auth = ? WHERE id = ?').run(on ? 1 : 0, userId);
  },

  /**
   * Replaces the password hash. `mustChange` records whether the new hash is a
   * temporary one-time password (forces the change-password screen) or the
   * user's own final password (clears the flag).
   */
  updatePassword(userId: number, passwordHash: string, mustChange: boolean): void {
    const db = getConnection();
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?')
      .run(passwordHash, mustChange ? 1 : 0, userId);
  },

  /** Lists every account (active + deactivated) for the owner Users panel. Never returns hashes. */
  listUsers(): UserAdminRow[] {
    const db = getConnection();
    return db
      .prepare(
        'SELECT id, username, created_at, last_login, agent_allow, agent_deny, linux_user, account_owner, agent_start_cmd, model_deny, must_change_password, pam_auth, is_active FROM users ORDER BY id'
      )
      .all() as UserAdminRow[];
  },

  /**
   * Looks up an active user by username.
   * Returns the full row (including password hash) for auth verification.
   */
  getUserByUsername(username: string): UserRow | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT * FROM users WHERE username = ? AND is_active = 1')
      .get(username) as UserRow | undefined;
  },

  /** Updates the last_login timestamp. Non-fatal — logs but does not throw. */
  updateLastLogin(userId: number): void {
    try {
      const db = getConnection();
      db.prepare(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to update last login', { error: message });
    }
  },

  /** Returns public user fields by ID (no password hash). */
  getUserById(userId: number): UserPublicRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        'SELECT id, username, created_at, last_login, agent_allow, agent_deny, linux_user, account_owner, agent_start_cmd, model_deny, must_change_password, pam_auth FROM users WHERE id = ? AND is_active = 1'
      )
      .get(userId) as UserPublicRow | undefined;
  },

  /** Returns the first active user. Used for single-user mode lookups. */
  getFirstUser(): UserPublicRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        'SELECT id, username, created_at, last_login, agent_allow, agent_deny, linux_user, account_owner, agent_start_cmd, model_deny, must_change_password, pam_auth FROM users WHERE is_active = 1 LIMIT 1'
      )
      .get() as UserPublicRow | undefined;
  },

  /** Stores the user's preferred git name and email. */
  updateGitConfig(
    userId: number,
    gitName: string,
    gitEmail: string
  ): void {
    const db = getConnection();
    db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?').run(
      gitName,
      gitEmail,
      userId
    );
  },

  /** Retrieves the user's git identity (name + email). */
  getGitConfig(userId: number): UserGitConfig | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT git_name, git_email FROM users WHERE id = ?')
      .get(userId) as UserGitConfig | undefined;
  },

  /** Marks onboarding as complete for the given user. */
  completeOnboarding(userId: number): void {
    const db = getConnection();
    db.prepare(
      'UPDATE users SET has_completed_onboarding = 1 WHERE id = ?'
    ).run(userId);
  },

  /**
   * Every active account's linux-user mapping (username + optional alias) —
   * drives the cross-user disk layer (user-fs) on one-instance-per-host.
   */
  listLinuxUserMappings(): Array<{ username: string; linux_user: string | null }> {
    const db = getConnection();
    return db
      .prepare('SELECT username, linux_user FROM users WHERE is_active = 1')
      .all() as Array<{ username: string; linux_user: string | null }>;
  },

  /**
   * The per-tenant "bring an offline agent online" command template, plus the
   * linux_user it should run as. Returns null command when the feature is off.
   */
  getAgentStartConfig(userId: number): { agent_start_cmd: string | null; linux_user: string | null } | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT agent_start_cmd, linux_user FROM users WHERE id = ? AND is_active = 1')
      .get(userId) as { agent_start_cmd: string | null; linux_user: string | null } | undefined;
  },

  /** Stores (or clears, with null/empty) the user's offline-agent start command. */
  updateAgentStartCmd(userId: number, cmd: string | null): void {
    const db = getConnection();
    const value = typeof cmd === 'string' && cmd.trim() ? cmd.trim() : null;
    db.prepare('UPDATE users SET agent_start_cmd = ? WHERE id = ?').run(value, userId);
  },

  /**
   * Sets (or clears, with null/empty) the user's model block-list. Stored as a
   * comma-separated string of model values the account may NOT use. Owners are
   * exempt at enforcement time regardless of what is stored here.
   */
  updateModelDeny(userId: number, deny: string | null): void {
    const db = getConnection();
    const value = typeof deny === 'string' && deny.trim() ? deny.trim() : null;
    db.prepare('UPDATE users SET model_deny = ? WHERE id = ?').run(value, userId);
  },

  /**
   * Sets (or clears, with null/empty) the user's agent block-list. Stored as a
   * comma-separated string of name globs the account may NOT see. Applies to
   * whoever it is set on — owners included.
   */
  updateAgentDeny(userId: number, deny: string | null): void {
    const db = getConnection();
    const value = typeof deny === 'string' && deny.trim() ? deny.trim() : null;
    db.prepare('UPDATE users SET agent_deny = ? WHERE id = ?').run(value, userId);
  },

  /** Returns true if the user has finished the onboarding flow. */
  hasCompletedOnboarding(userId: number): boolean {
    const db = getConnection();
    const row = db
      .prepare('SELECT has_completed_onboarding FROM users WHERE id = ?')
      .get(userId) as { has_completed_onboarding: number } | undefined;
    return row?.has_completed_onboarding === 1;
  },
};
