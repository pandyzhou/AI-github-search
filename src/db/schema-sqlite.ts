import {
  check,
  index,
  integer,
  text,
  sqliteTable,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  githubToken: text("github_token"),
  passwordHash: text("password_hash"),
  email: text("email").unique(),
  name: text("name"),
  avatar: text("avatar"),
  role: text("role", { enum: ["USER", "ADMIN"] }).default("USER"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const collections = sqliteTable("collections", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  isPublic: integer("is_public", { mode: "boolean" }).default(false),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const favorites = sqliteTable("favorites", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  repoFullName: text("repo_full_name").notNull(),
  repoMeta: text("repo_meta", { mode: "json" }),
  note: text("note"),
  collectionId: text("collection_id")
    .notNull()
    .references(() => collections.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const searchHistory = sqliteTable("search_history", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  query: text("query").notNull(),
  filters: text("filters", { mode: "json" }),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 全站 GitHub token 池
export const githubTokens = sqliteTable(
  "github_tokens",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    label: text("label"),
    source: text("source"),
    githubUserId: text("github_user_id").unique(),
    githubLogin: text("github_login"),
    avatarUrl: text("avatar_url"),
    encryptedToken: text("encrypted_token").notNull(),
    fingerprint: text("fingerprint").unique(),
    enabled: integer("enabled", { mode: "boolean" }).default(true),
    status: text("status", { enum: ["active", "exhausted", "invalid", "cooldown"] }).default("active"),
    scopes: text("scopes"),
    coreLimit: integer("core_limit"),
    coreLimitRemaining: integer("core_limit_remaining"),
    coreLimitResetAt: integer("core_limit_reset_at", { mode: "timestamp" }),
    searchLimit: integer("search_limit"),
    searchLimitRemaining: integer("search_limit_remaining"),
    searchLimitResetAt: integer("search_limit_reset_at", { mode: "timestamp" }),
    cooldownUntil: integer("cooldown_until", { mode: "timestamp" }),
    lastError: text("last_error"),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    lastCheckedAt: integer("last_checked_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (table) => [
    index("github_tokens_enabled_idx").on(table.enabled),
    index("github_tokens_status_idx").on(table.status),
    index("github_tokens_github_user_id_idx").on(table.githubUserId),
  ]
);

// token 池单例配置（仅一行，id 固定为 1）
export const githubPoolConfig = sqliteTable(
  "github_pool_config",
  {
    id: integer("id").primaryKey().$defaultFn(() => 1),
    maxConcurrency: integer("max_concurrency").default(4),
    parallelSearchPages: integer("parallel_search_pages").default(1),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (table) => [check("github_pool_config_single_row_check", sql`${table.id} = 1`)]
);
