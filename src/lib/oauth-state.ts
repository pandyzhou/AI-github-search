import { randomBytes, timingSafeEqual } from "crypto";

/**
 * OAuth state 校验的纯逻辑，便于单元测试。
 * 不依赖 Next.js 运行时，路由层负责实际的 cookie 读写。
 */

export const OAUTH_STATE_COOKIE = "github_oauth_state";
export const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60; // 10 分钟

export interface StateCookieOptions {
  httpOnly: boolean;
  sameSite: "lax" | "strict" | "none";
  secure: boolean;
  path: string;
  maxAge: number;
}

/** 构造与生产环境一致的 cookie 选项对象。 */
export function buildStateCookieOptions(
  isProduction: boolean,
  maxAgeSeconds: number = OAUTH_STATE_MAX_AGE_SECONDS
): StateCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** 生成高熵随机 state。 */
export function generateOAuthState(byteLength = 24): string {
  return randomBytes(byteLength).toString("hex");
}

/** 常量时间比较两个字符串，防止时序探测。 */
export function constantTimeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * 校验回调：cookie 中保存的 state 必须与 GitHub 回传的 state 严格相等。
 * 返回中文错误信息或 null 表示通过。
 */
export function verifyOAuthState(cookieState: string | null | undefined, queryState: string | null | undefined): string | null {
  if (!queryState) return "缺少 OAuth state 参数";
  if (!cookieState) return "OAuth state 已过期，请重新发起授权";
  if (!constantTimeEqual(cookieState, queryState)) return "OAuth state 校验失败";
  return null;
}