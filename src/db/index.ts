import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { Pool } from "pg";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import * as schema from "./schema";
import * as sqliteSchema from "./schema-sqlite";

const isSqlite = process.env.DATABASE_PROVIDER === "sqlite";

let dbInstance: any = null;
let poolInstance: Pool | null = null;
let sqliteInstance: Database.Database | null = null;
let memoryIdSequence = 0;

type TableRecord = Record<string, unknown>;

interface MemoryStorage {
  users: TableRecord[];
  collections: TableRecord[];
  favorites: TableRecord[];
  searchHistory: TableRecord[];
  githubTokens: TableRecord[];
  githubPoolConfig: TableRecord[];
}

interface FilterCondition {
  left?: unknown;
  right?: unknown;
  conditions?: Array<{ left?: unknown; right?: unknown }>;
}

type AwaitableQuery<T = TableRecord[]> = {
  limit: (n: number) => Promise<T>;
  orderBy: (...args: unknown[]) => AwaitableQuery<T>;
  then: <TResult1 = T, TResult2 = never>(
    onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ) => Promise<TResult1 | TResult2>;
};

type DrizzleQueryBuilder = {
  where: (condition: FilterCondition | unknown) => DrizzleQueryBuilder;
  limit: (n: number) => Promise<TableRecord[]>;
  orderBy: (...args: unknown[]) => DrizzleQueryBuilder;
};

export type DB = Pick<any, "delete" | "insert" | "select" | "update">;

const memoryStorage: MemoryStorage = {
  users: [],
  collections: [],
  favorites: [],
  searchHistory: [],
  githubTokens: [],
  githubPoolConfig: [],
};

function canUseMemoryDb() {
  return process.env.NODE_ENV === "test" || process.env.ALLOW_MEMORY_DB === "true";
}

function getPool() {
  if (poolInstance) return poolInstance;
  if (!process.env.DATABASE_URL) {
    if (canUseMemoryDb()) return null;
    throw new Error("DATABASE_URL is required");
  }

  poolInstance = new Pool({
    connectionString: process.env.DATABASE_URL,
  });
  return poolInstance;
}

function getSqliteDb() {
  if (sqliteInstance) return sqliteInstance;
  const dbPath = process.env.SQLITE_DATABASE_PATH || "./data/github-search-mirror.sqlite";
  
  // Ensure directory exists
  try {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } catch {
    // ignore
  }
  
  sqliteInstance = new Database(dbPath);
  sqliteInstance.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      github_token TEXT,
      password_hash TEXT,
      email TEXT UNIQUE,
      name TEXT,
      avatar TEXT,
      role TEXT DEFAULT 'USER',
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_public INTEGER DEFAULT 0,
      user_id TEXT NOT NULL,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS favorites (
      id TEXT PRIMARY KEY,
      repo_full_name TEXT NOT NULL,
      repo_meta TEXT,
      note TEXT,
      collection_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS search_history (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      filters TEXT,
      user_id TEXT,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS github_tokens (
      id TEXT PRIMARY KEY,
      label TEXT,
      source TEXT,
      github_user_id TEXT,
      github_login TEXT,
      avatar_url TEXT,
      encrypted_token TEXT,
      fingerprint TEXT,
      enabled INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active',
      scopes TEXT,
      core_limit INTEGER,
      core_limit_remaining INTEGER,
      core_limit_reset_at INTEGER,
      search_limit INTEGER,
      search_limit_remaining INTEGER,
      search_limit_reset_at INTEGER,
      cooldown_until INTEGER,
      last_error TEXT,
      last_used_at INTEGER,
      last_checked_at INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS github_pool_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      max_concurrency INTEGER DEFAULT 4,
      parallel_search_pages INTEGER DEFAULT 1,
      created_at INTEGER,
      updated_at INTEGER,
      CHECK (id = 1)
    );
  `);

  // 兼容旧版本不完整的同名表：通过 PRAGMA table_info 检测缺失列并 ALTER TABLE 补列。
  const ensureColumns = (
    table: string,
    columns: Array<{ name: string; def: string }>
  ) => {
    const existing = new Set(
      sqliteInstance!.prepare(`PRAGMA table_info(${table})`).all().map(
        (row: unknown) => (row as { name: string }).name
      )
    );
    for (const col of columns) {
      if (!existing.has(col.name)) {
        sqliteInstance!.exec(`ALTER TABLE ${table} ADD COLUMN ${col.def};`);
      }
    }
  };

  ensureColumns("github_tokens", [
    { name: "label", def: "label TEXT" },
    { name: "source", def: "source TEXT" },
    { name: "github_user_id", def: "github_user_id TEXT" },
    { name: "github_login", def: "github_login TEXT" },
    { name: "avatar_url", def: "avatar_url TEXT" },
    { name: "encrypted_token", def: "encrypted_token TEXT" },
    { name: "fingerprint", def: "fingerprint TEXT" },
    { name: "enabled", def: "enabled INTEGER DEFAULT 1" },
    { name: "status", def: "status TEXT DEFAULT 'active'" },
    { name: "scopes", def: "scopes TEXT" },
    { name: "core_limit", def: "core_limit INTEGER" },
    { name: "core_limit_remaining", def: "core_limit_remaining INTEGER" },
    { name: "core_limit_reset_at", def: "core_limit_reset_at INTEGER" },
    { name: "search_limit", def: "search_limit INTEGER" },
    { name: "search_limit_remaining", def: "search_limit_remaining INTEGER" },
    { name: "search_limit_reset_at", def: "search_limit_reset_at INTEGER" },
    { name: "cooldown_until", def: "cooldown_until INTEGER" },
    { name: "last_error", def: "last_error TEXT" },
    { name: "last_used_at", def: "last_used_at INTEGER" },
    { name: "last_checked_at", def: "last_checked_at INTEGER" },
    { name: "created_at", def: "created_at INTEGER" },
    { name: "updated_at", def: "updated_at INTEGER" },
  ]);

  ensureColumns("github_pool_config", [
    { name: "max_concurrency", def: "max_concurrency INTEGER DEFAULT 4" },
    { name: "parallel_search_pages", def: "parallel_search_pages INTEGER DEFAULT 1" },
    { name: "created_at", def: "created_at INTEGER" },
    { name: "updated_at", def: "updated_at INTEGER" },
  ]);

  // SQLite 无法 ALTER TABLE ADD CONSTRAINT，改用唯一索引保证 fingerprint / github_user_id 唯一。
  sqliteInstance.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS github_tokens_fingerprint_unique
      ON github_tokens(fingerprint);
    CREATE UNIQUE INDEX IF NOT EXISTS github_tokens_github_user_id_unique
      ON github_tokens(github_user_id);
    CREATE INDEX IF NOT EXISTS github_tokens_enabled_idx ON github_tokens(enabled);
    CREATE INDEX IF NOT EXISTS github_tokens_status_idx ON github_tokens(status);
    CREATE INDEX IF NOT EXISTS github_tokens_github_user_id_idx ON github_tokens(github_user_id);
  `);
  return sqliteInstance;
}

function initDb() {
  if (dbInstance) return dbInstance;
  if (process.env.NODE_ENV === "test" && process.env.USE_POSTGRES_IN_TEST !== "true") {
    return null;
  }

  try {
    if (isSqlite) {
      const sqliteDb = getSqliteDb();
      if (!sqliteDb) return null;
      dbInstance = drizzleSqlite(sqliteDb, { schema: sqliteSchema });
      return dbInstance;
    } else {
      const pool = getPool();
      if (!pool) return null;
      dbInstance = drizzlePg(pool, { schema });
      return dbInstance;
    }
  } catch {
    if (!canUseMemoryDb()) {
      throw new Error("Database initialization failed");
    }
    return null;
  }
}

export async function checkDatabaseHealth() {
  if (canUseMemoryDb()) {
    return { ok: true, mode: "memory" };
  }

  if (isSqlite) {
    try {
      const sqliteDb = getSqliteDb();
      sqliteDb.prepare("SELECT 1").run();
      return { ok: true, mode: "sqlite" };
    } catch {
      return { ok: false, mode: "unavailable" };
    }
  }

  const pool = getPool();
  if (!pool) {
    return { ok: false, mode: "unavailable" };
  }

  await pool.query("select 1");
  return { ok: true, mode: "postgres" };
}

function getTableName(table: unknown): keyof MemoryStorage {
  if (!table) return "users";
  let name: string | undefined;
  try {
    const t = table as Record<symbol, string>;
    name = t[Symbol.for("drizzle:Name")] || t[Symbol.for("drizzle:BaseName")];
  } catch {
    name = undefined;
  }
  if (name === "users") return "users";
  if (name === "collections") return "collections";
  if (name === "favorites") return "favorites";
  if (name === "search_history") return "searchHistory";
  if (name === "github_tokens") return "githubTokens";
  if (name === "github_pool_config") return "githubPoolConfig";
  return "users";
}

function getColumnPropName(column: unknown): string {
  if (!column) return "";
  const col = column as Record<string, unknown>;
  const table = col.table as Record<symbol, Record<string, unknown>> | undefined;
  if (table) {
    const cols = table[Symbol.for("drizzle:Columns")];
    if (cols) {
      for (const [propName, c] of Object.entries(cols)) {
        if (c === column) return propName;
      }
    }
    for (const key of Object.keys(table)) {
      if ((table as Record<string, unknown>)[key] === column) return key;
    }
  }
  return (col.name as string) || "";
}

function getRecordValue(item: TableRecord, propName: string) {
  if (propName in item) return item[propName];
  const camelPropName = propName.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
  return item[camelPropName];
}

function getChunkText(chunk: unknown): string {
  const value = (chunk as { value?: unknown }).value;
  return Array.isArray(value) ? value.join("") : typeof value === "string" ? value : "";
}

function getParamValue(chunk: unknown): unknown {
  if (chunk && typeof chunk === "object" && "value" in chunk) {
    return (chunk as { value: unknown }).value;
  }
  return chunk;
}

function hasQueryChunks(value: unknown): value is { queryChunks: unknown[] } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Array.isArray((value as { queryChunks?: unknown }).queryChunks)
  );
}

function evaluateSqlCondition(item: TableRecord, condition: unknown): boolean {
  if (!hasQueryChunks(condition)) return true;

  for (let idx = 0; idx < condition.queryChunks.length - 2; idx++) {
    const column = condition.queryChunks[idx];
    const operator = getChunkText(condition.queryChunks[idx + 1]);
    if (!operator.includes("=")) continue;

    const propName = getColumnPropName(column);
    if (!propName) continue;

    return getRecordValue(item, propName) === getParamValue(condition.queryChunks[idx + 2]);
  }

  const childConditions = condition.queryChunks.filter(hasQueryChunks);
  return childConditions.length > 0
    ? childConditions.every((child) => evaluateSqlCondition(item, child))
    : true;
}

function applyCondition(
  items: TableRecord[],
  condition: FilterCondition | undefined
): TableRecord[] {
  if (!condition) return items;
  return items.filter((item) => {
    if (condition.left && condition.right !== undefined) {
      const propName = getColumnPropName(condition.left);
      return getRecordValue(item, propName) === condition.right;
    }
    if (condition.conditions) {
      return condition.conditions.every((c) => {
        const propName = getColumnPropName(c.left);
        return getRecordValue(item, propName) === c.right;
      });
    }
    return evaluateSqlCondition(item, condition);
  });
}

function sortByCreatedAt(items: TableRecord[]) {
  return [...items].sort(
    (a, b) =>
      new Date((b.createdAt as string) || 0).getTime() -
      new Date((a.createdAt as string) || 0).getTime()
  );
}

function makeAwaitable<T = TableRecord[]>(limitFn: (n: number) => Promise<T>): AwaitableQuery<T> {
  const query: AwaitableQuery<T> = {
    limit: limitFn,
    orderBy: () => makeAwaitable(limitFn),
    then: (onFulfilled, onRejected) => limitFn(1000).then(onFulfilled, onRejected),
  };
  return query;
}

function memQuery(tableName: keyof MemoryStorage): AwaitableQuery {
  const items = memoryStorage[tableName];

  return {
    limit: (n: number) => Promise.resolve(items.slice(0, n)),
    orderBy: () => makeAwaitable((n) => Promise.resolve(sortByCreatedAt(items).slice(0, n))),
    then: (onFulfilled, onRejected) =>
      Promise.resolve(items.slice(0, 1000)).then(onFulfilled, onRejected),
  };
}

function memSelect() {
  return {
    from: (table: unknown) => {
      const tableName = getTableName(table);
      const base = memQuery(tableName);
      return {
        ...base,
        where: (condition: FilterCondition) => {
          const filtered = applyCondition([...memoryStorage[tableName]], condition);
          return makeAwaitable((n) => Promise.resolve(filtered.slice(0, n)));
        },
      };
    },
  };
}

function memInsert(table: unknown) {
  return {
    values: (data: TableRecord | TableRecord[]) => ({
      returning: () => {
        const tableName = getTableName(table);
        const items = Array.isArray(data) ? data : [data];
        const results = items.map((item, idx) => {
          const record = {
            ...item,
            id: item.id ?? `mem-${Date.now()}-${memoryIdSequence++}-${idx}`,
            createdAt: item.createdAt ?? new Date(),
            updatedAt: item.updatedAt ?? new Date(),
          };
          memoryStorage[tableName].push(record);
          return record;
        });
        return Promise.resolve(results);
      },
    }),
  };
}

function memDelete(table: unknown) {
  return {
    where: (condition: FilterCondition) => {
      const tableName = getTableName(table);
      const toDelete = new Set(
        applyCondition(memoryStorage[tableName], condition).map((item) => item.id)
      );
      memoryStorage[tableName] = memoryStorage[tableName].filter((item) => !toDelete.has(item.id));
      return Promise.resolve();
    },
  };
}

function memUpdate(table: unknown) {
  return {
    set: (data: TableRecord) => ({
      where: (condition: FilterCondition) => {
        const tableName = getTableName(table);
        const itemsToUpdate = new Set(
          applyCondition(memoryStorage[tableName], condition).map((item) => item.id)
        );
        memoryStorage[tableName] = memoryStorage[tableName].map((item) =>
          itemsToUpdate.has(item.id) ? { ...item, ...data } : item
        );
        return Promise.resolve();
      },
    }),
  };
}

function wrapQuery(
  realQuery: DrizzleQueryBuilder,
  table: unknown
): AwaitableQuery & {
  where: (condition: FilterCondition | unknown) => AwaitableQuery;
} {
  const tableName = getTableName(table);
  const fallback = memQuery(tableName);
  const run = async (query: DrizzleQueryBuilder, n: number) => {
    try {
      return await query.limit(n);
    } catch (error) {
      if (!canUseMemoryDb()) throw error;
      return fallback.limit(n);
    }
  };

  return {
    limit: (n: number) => run(realQuery, n),
    orderBy: (...args: unknown[]) => makeAwaitable((n) => run(realQuery.orderBy(...args), n)),
    where: (condition: FilterCondition | unknown) => {
      const filtered = applyCondition([...memoryStorage[tableName]], condition as FilterCondition);
      const memory = makeAwaitable((n) => Promise.resolve(filtered.slice(0, n)));
      return {
        limit: async (n: number) => {
          try {
            return await realQuery.where(condition).limit(n);
          } catch (error) {
            if (!canUseMemoryDb()) throw error;
            return memory.limit(n);
          }
        },
        orderBy: (...args: unknown[]) =>
          makeAwaitable(async (n) => {
            try {
              return await realQuery
                .where(condition)
                .orderBy(...args)
                .limit(n);
            } catch (error) {
              if (!canUseMemoryDb()) throw error;
              return memory.orderBy(...args).limit(n);
            }
          }),
        then: (onFulfilled, onRejected) => memory.then(onFulfilled, onRejected),
      };
    },
    then: (onFulfilled, onRejected) => run(realQuery, 1000).then(onFulfilled, onRejected),
  };
}

export const db: DB = {
  insert: (table: unknown) => ({
    values: (data: TableRecord | TableRecord[]) => ({
      returning: async (columns?: unknown) => {
        const realDb = initDb();
        if (realDb) {
          try {
            const query = (realDb as any).insert(table as never).values(data as never);
            const result = columns
              ? await query.returning(columns as never)
              : await query.returning();
            return result as TableRecord[];
          } catch (error) {
            if (!canUseMemoryDb()) throw error;
          }
        }
        if (!canUseMemoryDb()) {
          throw new Error("Database unavailable");
        }
        return memInsert(table).values(data).returning();
      },
    }),
  }),

  select: () => ({
    from: (table: unknown) => {
      const realDb = initDb();
      if (realDb) {
        try {
          return wrapQuery(
            (realDb as any).select().from(table as never) as unknown as DrizzleQueryBuilder,
            table
          );
        } catch (error) {
          if (!canUseMemoryDb()) throw error;
        }
      }
      if (!canUseMemoryDb()) {
        throw new Error("Database unavailable");
      }
      return memSelect().from(table);
    },
  }),

  delete: (table: unknown) => ({
    where: async (condition: FilterCondition) => {
      const realDb = initDb();
      if (realDb) {
        try {
          await (realDb as any).delete(table as never).where(condition as never);
          return;
        } catch (error) {
          if (!canUseMemoryDb()) throw error;
        }
      }
      if (!canUseMemoryDb()) {
        throw new Error("Database unavailable");
      }
      await memDelete(table).where(condition);
    },
  }),

  update: (table: unknown) => ({
    set: (data: TableRecord) => ({
      where: async (condition: FilterCondition) => {
        const realDb = initDb();
        if (realDb) {
          try {
            await (realDb as any)
              .update(table as never)
              .set(data as never)
              .where(condition as never);
            return;
          } catch (error) {
            if (!canUseMemoryDb()) {
              const message = error instanceof Error ? error.message : String(error);
              throw new Error("Database update failed: " + message);
            }
          }
        }
        if (!canUseMemoryDb()) {
          throw new Error("Database unavailable");
        }
        await memUpdate(table).set(data).where(condition);
      },
    }),
  }),
} as unknown as DB;

export { memoryStorage };
