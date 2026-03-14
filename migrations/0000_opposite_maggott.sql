CREATE TABLE "analyses" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"mode" text NOT NULL,
	"company_name" text NOT NULL,
	"company_id" text,
	"tax_code" text,
	"address" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"company_details" jsonb,
	"financial_data" jsonb,
	"ai_analysis" jsonb,
	"competitors" jsonb,
	"created_at" text
);
--> statement-breakpoint
CREATE TABLE "app_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bilanci_cache" (
	"company_id" text NOT NULL,
	"tax_code" text NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "bilanci_cache_company_id_tax_code_pk" PRIMARY KEY("company_id","tax_code")
);
--> statement-breakpoint
CREATE TABLE "billing_checkouts" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'eur' NOT NULL,
	"status" text NOT NULL,
	"stripe_payment_status" text,
	"checkout_url" text,
	"metadata" jsonb,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_details_cache" (
	"company_id" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_full_cache" (
	"company_id" text NOT NULL,
	"tax_code" text NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "company_full_cache_company_id_tax_code_pk" PRIMARY KEY("company_id","tax_code")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"tier" text NOT NULL,
	"stripe_subscription_id" text,
	"stripe_customer_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"current_period_start" text NOT NULL,
	"current_period_end" text NOT NULL,
	"analyses_used" integer DEFAULT 0 NOT NULL,
	"analyses_limit" integer NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"auth_id" text,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'eur' NOT NULL,
	"description" text NOT NULL,
	"source" text NOT NULL,
	"reference" text,
	"metadata" jsonb,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"balance_cents" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'eur' NOT NULL,
	"updated_at" text NOT NULL
);
