import { appConfig } from "@shared/schema";

const CONFIG_KEYS = {
  AI_PROVIDER: "ai_provider",
  AI_MODEL: "ai_model",
  OPENAI_API_KEY: "openai_api_key",
  ANTHROPIC_API_KEY: "anthropic_api_key",
  OPENAPI_BEARER: "openapi_bearer",
  OPENAPI_BEARER_SANDBOX: "openapi_bearer_sandbox",
  OPENAPI_USE_SANDBOX: "openapi_use_sandbox",
  OPENAI_CHAT_MODEL: "openai_chat_model",
  STRIPE_SECRET_KEY: "stripe_secret_key",
  STRIPE_WEBHOOK_SECRET: "stripe_webhook_secret",
  BILLING_BUSINESS_ANALYSIS_CENTS: "billing_business_analysis_cents",
  BILLING_SUBSCRIBER_EXTRA_ANALYSIS_CENTS: "billing_subscriber_extra_analysis_cents",
  STRIPE_PRO_PRICE_ID: "stripe_pro_price_id",
  STRIPE_BUSINESS_PRICE_ID: "stripe_business_price_id",
} as const;

let cache: Record<string, string> = {};
let loaded = false;

async function loadFromDb(): Promise<Record<string, string>> {
  if (!process.env.DATABASE_URL) return {};
  try {
    const { getDb } = await import("./db");
    const rows = await getDb().select().from(appConfig);
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  } catch {
    return {};
  }
}

/**
 * Carica la config: da Supabase (tabella app_config) se DATABASE_URL è impostato,
 * altrimenti da process.env. Va chiamato all'avvio del server.
 */
export async function loadConfig(): Promise<void> {
  if (loaded) return;
  const fromDb = await loadFromDb();
  cache = {
    [CONFIG_KEYS.AI_PROVIDER]: fromDb[CONFIG_KEYS.AI_PROVIDER] ?? process.env.AI_PROVIDER ?? "",
    [CONFIG_KEYS.AI_MODEL]: fromDb[CONFIG_KEYS.AI_MODEL] ?? process.env.AI_MODEL ?? "",
    [CONFIG_KEYS.OPENAI_API_KEY]: fromDb[CONFIG_KEYS.OPENAI_API_KEY] ?? process.env.OPENAI_API_KEY ?? "",
    [CONFIG_KEYS.ANTHROPIC_API_KEY]: fromDb[CONFIG_KEYS.ANTHROPIC_API_KEY] ?? process.env.ANTHROPIC_API_KEY ?? "",
    [CONFIG_KEYS.OPENAPI_BEARER]: fromDb[CONFIG_KEYS.OPENAPI_BEARER] ?? process.env.OPENAPI_BEARER ?? "",
    [CONFIG_KEYS.OPENAPI_BEARER_SANDBOX]: fromDb[CONFIG_KEYS.OPENAPI_BEARER_SANDBOX] ?? process.env.OPENAPI_BEARER_SANDBOX ?? "",
    [CONFIG_KEYS.OPENAPI_USE_SANDBOX]: fromDb[CONFIG_KEYS.OPENAPI_USE_SANDBOX] ?? process.env.OPENAPI_USE_SANDBOX ?? "false",
    [CONFIG_KEYS.OPENAI_CHAT_MODEL]:
      fromDb[CONFIG_KEYS.OPENAI_CHAT_MODEL] ?? process.env.OPENAI_CHAT_MODEL ?? "gpt-5.4",
    [CONFIG_KEYS.STRIPE_SECRET_KEY]:
      fromDb[CONFIG_KEYS.STRIPE_SECRET_KEY] ?? process.env.STRIPE_SECRET_KEY ?? "",
    [CONFIG_KEYS.STRIPE_WEBHOOK_SECRET]:
      fromDb[CONFIG_KEYS.STRIPE_WEBHOOK_SECRET] ?? process.env.STRIPE_WEBHOOK_SECRET ?? "",
    [CONFIG_KEYS.BILLING_BUSINESS_ANALYSIS_CENTS]:
      fromDb[CONFIG_KEYS.BILLING_BUSINESS_ANALYSIS_CENTS] ?? process.env.BILLING_BUSINESS_ANALYSIS_CENTS ?? "2900",
    [CONFIG_KEYS.BILLING_SUBSCRIBER_EXTRA_ANALYSIS_CENTS]:
      fromDb[CONFIG_KEYS.BILLING_SUBSCRIBER_EXTRA_ANALYSIS_CENTS] ?? process.env.BILLING_SUBSCRIBER_EXTRA_ANALYSIS_CENTS ?? "1200",
    [CONFIG_KEYS.STRIPE_PRO_PRICE_ID]:
      fromDb[CONFIG_KEYS.STRIPE_PRO_PRICE_ID] ?? process.env.STRIPE_PRO_PRICE_ID ?? "",
    [CONFIG_KEYS.STRIPE_BUSINESS_PRICE_ID]:
      fromDb[CONFIG_KEYS.STRIPE_BUSINESS_PRICE_ID] ?? process.env.STRIPE_BUSINESS_PRICE_ID ?? "",
  };
  loaded = true;
}

type AiProvider = "openai" | "anthropic";

function normalizeAiProvider(value: string | undefined): AiProvider | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "claude") return "anthropic";
  if (normalized === "openai" || normalized === "gpt") return "openai";
  return null;
}

function inferProviderFromModel(value: string | undefined): AiProvider | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized.startsWith("claude-")) return "anthropic";
  if (normalized.startsWith("gpt-") || normalized.startsWith("o")) return "openai";
  return null;
}

export function getAiProvider(): AiProvider {
  return (
    normalizeAiProvider(cache[CONFIG_KEYS.AI_PROVIDER]) ||
    inferProviderFromModel(cache[CONFIG_KEYS.AI_MODEL]) ||
    inferProviderFromModel(cache[CONFIG_KEYS.OPENAI_CHAT_MODEL]) ||
    normalizeAiProvider(process.env.AI_PROVIDER) ||
    inferProviderFromModel(process.env.AI_MODEL) ||
    inferProviderFromModel(process.env.OPENAI_CHAT_MODEL) ||
    "openai"
  );
}

export function getAiChatModel(): string {
  const configuredModel =
    cache[CONFIG_KEYS.AI_MODEL] ||
    process.env.AI_MODEL ||
    cache[CONFIG_KEYS.OPENAI_CHAT_MODEL] ||
    process.env.OPENAI_CHAT_MODEL;

  if (configuredModel?.trim()) return configuredModel.trim();
  return getAiProvider() === "anthropic" ? "claude-opus-4-6" : "gpt-5.4";
}

export function getAiApiKey(): string {
  return getAiProvider() === "anthropic"
    ? (cache[CONFIG_KEYS.ANTHROPIC_API_KEY] ?? process.env.ANTHROPIC_API_KEY ?? "")
    : (cache[CONFIG_KEYS.OPENAI_API_KEY] ?? process.env.OPENAI_API_KEY ?? "");
}

export function getAnthropicApiKey(): string {
  return cache[CONFIG_KEYS.ANTHROPIC_API_KEY] ?? process.env.ANTHROPIC_API_KEY ?? "";
}

export function getOpenaiApiKey(): string {
  return getAiApiKey();
}

export function getOpenapiBearer(): string {
  return cache[CONFIG_KEYS.OPENAPI_BEARER] ?? "";
}

export function getOpenapiSandboxBearer(): string {
  return cache[CONFIG_KEYS.OPENAPI_BEARER_SANDBOX] ?? "";
}

function isTruthy(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/** true solo se OPENAPI_USE_SANDBOX è attivo esplicitamente. */
export function isOpenApiSandbox(): boolean {
  return isTruthy(cache[CONFIG_KEYS.OPENAPI_USE_SANDBOX] ?? process.env.OPENAPI_USE_SANDBOX);
}

export function getOpenaiChatModel(): string {
  return getAiChatModel();
}

export function getStripeSecretKey(): string {
  return cache[CONFIG_KEYS.STRIPE_SECRET_KEY] ?? "";
}

export function getStripeWebhookSecret(): string {
  return cache[CONFIG_KEYS.STRIPE_WEBHOOK_SECRET] ?? "";
}

export function getBusinessAnalysisPriceCents(): number {
  const raw = cache[CONFIG_KEYS.BILLING_BUSINESS_ANALYSIS_CENTS] ?? process.env.BILLING_BUSINESS_ANALYSIS_CENTS ?? "2900";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2900;
}

export function getSubscriberExtraAnalysisPriceCents(): number {
  const raw = cache[CONFIG_KEYS.BILLING_SUBSCRIBER_EXTRA_ANALYSIS_CENTS] ?? process.env.BILLING_SUBSCRIBER_EXTRA_ANALYSIS_CENTS ?? "1200";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1200;
}

export function getStripeProPriceId(): string {
  return cache[CONFIG_KEYS.STRIPE_PRO_PRICE_ID] ?? "";
}

export function getStripeBusinessPriceId(): string {
  return cache[CONFIG_KEYS.STRIPE_BUSINESS_PRICE_ID] ?? "";
}

/** Restituisce l'header Authorization con il token corretto (sandbox se disponibile, altrimenti produzione). */
export function getAuthHeaders(): { Authorization: string } {
  const token = isOpenApiSandbox()
    ? (getOpenapiSandboxBearer() || getOpenapiBearer())
    : getOpenapiBearer();
  return { Authorization: `Bearer ${token}` };
}

export function getCompanyBaseUrl(): string {
  return isOpenApiSandbox()
    ? "https://test.company.openapi.com"
    : "https://company.openapi.com";
}

export function getDocuEngineBaseUrl(): string {
  return isOpenApiSandbox()
    ? "https://test.docuengine.openapi.com"
    : "https://docuengine.openapi.com";
}
