import "server-only";

import { getReadyRedis } from "./cache";
import { GitHubPoolError } from "./github-token-pool";

/**
 * 全站上游并发控制器。
 *
 * 进程内：基于 inUse/max 模型的严格 Semaphore，动态缩容时不超发许可。
 * 跨进程：Redis 可用时使用 ZSET + EVAL 直接执行 Lua 分布式租约（TTL 90s 自愈）。
 *         - Redis 故障/不可用：降级为进程内限流，不卡死。
 *         - Redis 正常且满了：等待直至超时，超时后必须释放已领取的本地 Permit，并抛出 status=503 的 busy 错误。
 */

const DEFAULT_PERMIT_TIMEOUT_MS = 8000;
const REDIS_LEASE_KEY = "github:upstream:semaphore";
const REDIS_LEASE_TTL_SECONDS = 90; // 覆盖两次 15s 请求
const REDIS_RETRY_INTERVAL_MS = 25;

/** 进程内 Semaphore（inUse / max 模型） */
class ProcessSemaphore {
  private inUse = 0;
  private max: number;
  private queue: Array<{
    resolve: (acquired: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(max: number) {
    this.max = max;
  }

  /** 动态更新上限；缩容时不打断现有 inUse，但不会超发新许可。 */
  setMax(next: number): void {
    if (next <= 0) return;
    this.max = next;
    this.drainQueue();
  }

  private drainQueue(): void {
    while (this.inUse < this.max && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      clearTimeout(entry.timer);
      this.inUse += 1;
      entry.resolve(true);
    }
  }

  getMax(): number {
    return this.max;
  }

  getInUse(): number {
    return this.inUse;
  }

  async acquire(timeoutMs: number): Promise<boolean> {
    if (this.inUse < this.max) {
      this.inUse += 1;
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      const entry: { resolve: (v: boolean) => void; timer: ReturnType<typeof setTimeout> } = {
        resolve,
        timer: null as unknown as ReturnType<typeof setTimeout>,
      };
      entry.timer = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) this.queue.splice(idx, 1);
        resolve(false);
      }, Math.max(1, timeoutMs));
      this.queue.push(entry);
    });
  }

  release(): void {
    this.inUse = Math.max(0, this.inUse - 1);
    this.drainQueue();
  }
}

let processSemaphore = new ProcessSemaphore(4);
let configuredMax = 4;

const ACQUIRE_LUA = `
local key = KEYS[1]
local nowMs = tonumber(ARGV[1])
local expireMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
local ttlSec = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', key, '-inf', nowMs)
local count = redis.call('ZCARD', key)
if count >= limit then return 0 end
redis.call('ZADD', key, expireMs, member)
redis.call('EXPIRE', key, ttlSec)
return 1
`;

const RELEASE_LUA = `
local key = KEYS[1]
local member = ARGV[1]
return redis.call('ZREM', key, member)
`;

interface RedisEvalClient {
  eval: (script: string, numkeys: number, ...args: unknown[]) => Promise<unknown>;
}

type RedisLeaseResult =
  | { type: "acquired"; member: string }
  | { type: "full" }
  | { type: "unavailable" };

async function acquireRedisLease(
  client: RedisEvalClient,
  limit: number,
  timeoutMs: number
): Promise<RedisLeaseResult> {
  const deadline = Date.now() + Math.min(timeoutMs, DEFAULT_PERMIT_TIMEOUT_MS);
  const member = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  while (Date.now() <= deadline) {
    try {
      const nowMs = Date.now();
      const expireMs = nowMs + REDIS_LEASE_TTL_SECONDS * 1000;
      const res = (await client.eval(
        ACQUIRE_LUA,
        1,
        REDIS_LEASE_KEY,
        nowMs,
        expireMs,
        limit,
        member,
        REDIS_LEASE_TTL_SECONDS
      )) as number;

      if (res === 1) {
        return { type: "acquired", member };
      }
      // res === 0 说明 Redis 许可满额，重试
    } catch {
      // Redis 执行异常或网络连接断开 -> 视为不可用，降级
      return { type: "unavailable" };
    }
    await new Promise((r) => setTimeout(r, REDIS_RETRY_INTERVAL_MS));
  }

  return { type: "full" };
}

async function releaseRedisLease(client: RedisEvalClient, member: string): Promise<void> {
  try {
    await client.eval(RELEASE_LUA, 1, REDIS_LEASE_KEY, member);
  } catch {
    // 租约有 TTL 兜底，删除失败不抛错
  }
}

export interface GitHubPermit {
  release: () => void;
}

/**
 * 获取上游并发许可。务必在 finally 中调用 release。
 * - 本地 permit 超时 -> 抛出 TIMEOUT (503)
 * - Redis 满了超时 -> 必须释放本地 permit 并抛出 TIMEOUT (503)
 * - Redis 不可用 -> 降级走进程内 Semaphore
 */
export async function acquireGitHubPermit(
  timeoutMs: number = DEFAULT_PERMIT_TIMEOUT_MS
): Promise<GitHubPermit> {
  const max = await resolveConcurrency();
  processSemaphore.setMax(Math.max(1, max));

  const procAcquired = await processSemaphore.acquire(timeoutMs);
  if (!procAcquired) {
    throw new GitHubPoolError("TIMEOUT", "Upstream concurrency busy (process cap reached)", {
      status: 503,
    });
  }

  let redisClient: RedisEvalClient | null = null;
  try {
    const r = await getReadyRedis();
    if (r) redisClient = r as unknown as RedisEvalClient;
  } catch {
    redisClient = null;
  }

  let leaseMember: string | null = null;
  if (redisClient) {
    const leaseRes = await acquireRedisLease(redisClient, max, timeoutMs);
    if (leaseRes.type === "full") {
      // Redis 满额超时 -> 必须释放本地 permit 并抛出 503
      processSemaphore.release();
      throw new GitHubPoolError("TIMEOUT", "Upstream concurrency busy (global Redis cap reached)", {
        status: 503,
      });
    }
    if (leaseRes.type === "acquired") {
      leaseMember = leaseRes.member;
    }
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    if (redisClient && leaseMember) {
      void releaseRedisLease(redisClient, leaseMember).catch(() => undefined);
    }
    processSemaphore.release();
  };

  return { release };
}

let fetchedMax: number | null = null;
let fetchedAt = 0;
const CONFIG_TTL_MS = 60_000;

async function resolveConcurrency(): Promise<number> {
  const now = Date.now();
  if (fetchedMax !== null && now - fetchedAt < CONFIG_TTL_MS) {
    return fetchedMax;
  }
  try {
    const { getGitHubPoolConfig } = await import("./github-token-pool");
    const cfg = await getGitHubPoolConfig();
    fetchedMax = Math.max(1, Math.min(20, cfg.maxConcurrency || 4));
    fetchedAt = now;
    configuredMax = fetchedMax;
  } catch {
    fetchedMax = configuredMax;
  }
  return fetchedMax;
}

/** 管理配置变更后立即清除本进程并发配置缓存。 */
export function invalidateGitHubSemaphoreConfig(): void {
  fetchedMax = null;
  fetchedAt = 0;
}

/** 测试用：重置内部状态 */
export function __resetGitHubSemaphoreForTests(): void {
  processSemaphore = new ProcessSemaphore(4);
  configuredMax = 4;
  fetchedMax = null;
  fetchedAt = 0;
}