import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const userRoleEnum = pgEnum("user_role", ["USER", "ADMIN"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubToken: text("github_token"),
  passwordHash: text("password_hash"),
  email: varchar("email", { length: 255 }).unique(),
  name: varchar("name", { length: 255 }),
  avatar: text("avatar"),
  role: userRoleEnum("role").default("USER"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const collections = pgTable(
  "collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    isPublic: boolean("is_public").default(false),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("collections_user_id_idx").on(table.userId)]
);

export const favorites = pgTable(
  "favorites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoFullName: varchar("repo_full_name", { length: 255 }).notNull(),
    repoMeta: jsonb("repo_meta"),
    note: text("note"),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("favorites_user_id_idx").on(table.userId),
    index("favorites_collection_id_idx").on(table.collectionId),
  ]
);

export const searchHistory = pgTable(
  "search_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    query: text("query").notNull(),
    filters: jsonb("filters"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("search_history_user_id_idx").on(table.userId)]
);

// 全站 GitHub token 池
export const githubTokens = pgTable(
  "github_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: varchar("label", { length: 255 }),
    source: varchar("source", { length: 64 }),
    githubUserId: varchar("github_user_id", { length: 128 }).unique(),
    githubLogin: varchar("github_login", { length: 255 }),
    avatarUrl: text("avatar_url"),
    encryptedToken: text("encrypted_token").notNull(),
    fingerprint: varchar("fingerprint", { length: 64 }).unique(),
    enabled: boolean("enabled").default(true),
    status: varchar("status", { length: 32 }).default("active"),
    scopes: text("scopes"),
    coreLimit: integer("core_limit"),
    coreLimitRemaining: integer("core_limit_remaining"),
    coreLimitResetAt: timestamp("core_limit_reset_at", { withTimezone: true }),
    searchLimit: integer("search_limit"),
    searchLimitRemaining: integer("search_limit_remaining"),
    searchLimitResetAt: timestamp("search_limit_reset_at", { withTimezone: true }),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    lastError: text("last_error"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("github_tokens_enabled_idx").on(table.enabled),
    index("github_tokens_status_idx").on(table.status),
    index("github_tokens_github_user_id_idx").on(table.githubUserId),
  ]
);

// token 池单例配置（仅一行，id 固定为 1）
export const githubPoolConfig = pgTable(
  "github_pool_config",
  {
    id: integer("id").primaryKey().default(1),
    maxConcurrency: integer("max_concurrency").default(4),
    parallelSearchPages: integer("parallel_search_pages").default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [check("github_pool_config_single_row_check", sql`${table.id} = 1`)]
);
