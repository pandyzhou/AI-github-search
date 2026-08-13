-- 新增全站 GitHub token 池与单例配置表。
-- 对已有同名不完整表使用 ADD COLUMN IF NOT EXISTS 补列；
-- 唯一约束通过 DO block 检测不存在后再添加，保证增量安全。

CREATE TABLE IF NOT EXISTS "github_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" varchar(255),
	"source" varchar(64),
	"github_user_id" varchar(128),
	"github_login" varchar(255),
	"avatar_url" text,
	"encrypted_token" text NOT NULL,
	"fingerprint" varchar(64),
	"enabled" boolean DEFAULT true,
	"status" varchar(32) DEFAULT 'active',
	"scopes" text,
	"core_limit" integer,
	"core_limit_remaining" integer,
	"core_limit_reset_at" timestamp with time zone,
	"search_limit" integer,
	"search_limit_remaining" integer,
	"search_limit_reset_at" timestamp with time zone,
	"cooldown_until" timestamp with time zone,
	"last_error" text,
	"last_used_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "github_tokens_fingerprint_unique" UNIQUE("fingerprint"),
	CONSTRAINT "github_tokens_github_user_id_unique" UNIQUE("github_user_id")
);--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "label" varchar(255);--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "source" varchar(64);--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "github_user_id" varchar(128);--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "github_login" varchar(255);--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "avatar_url" text;--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "encrypted_token" text;--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "fingerprint" varchar(64);--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "status" varchar(32) DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "scopes" text;--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "core_limit" integer;--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "core_limit_remaining" integer;--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "core_limit_reset_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "search_limit" integer;--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "search_limit_remaining" integer;--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "search_limit_reset_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "cooldown_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "last_error" text;--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'github_tokens_fingerprint_unique'
  ) THEN
    ALTER TABLE "github_tokens" ADD CONSTRAINT "github_tokens_fingerprint_unique" UNIQUE ("fingerprint");
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'github_tokens_github_user_id_unique'
  ) THEN
    ALTER TABLE "github_tokens" ADD CONSTRAINT "github_tokens_github_user_id_unique" UNIQUE ("github_user_id");
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_tokens_enabled_idx" ON "github_tokens" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_tokens_status_idx" ON "github_tokens" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_tokens_github_user_id_idx" ON "github_tokens" USING btree ("github_user_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_pool_config" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"max_concurrency" integer DEFAULT 4,
	"parallel_search_pages" integer DEFAULT 1,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "github_pool_config_single_row_check" CHECK ("id" = 1)
);--> statement-breakpoint
ALTER TABLE "github_pool_config" ADD COLUMN IF NOT EXISTS "max_concurrency" integer DEFAULT 4;--> statement-breakpoint
ALTER TABLE "github_pool_config" ADD COLUMN IF NOT EXISTS "parallel_search_pages" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "github_pool_config" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "github_pool_config" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'github_pool_config_single_row_check'
  ) THEN
    ALTER TABLE "github_pool_config" ADD CONSTRAINT "github_pool_config_single_row_check" CHECK ("id" = 1);
  END IF;
END $$;