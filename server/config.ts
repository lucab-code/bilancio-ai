import { appConfig } from "@shared/schema";

const CONFIG_KEYS = {
  OPENAI_API_KEY: "openai_api_key",
  OPENAPI_BEARER: "openapi_bearer",
  OPENAI_CHAT_MODEL: "openai_chat_model",
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
    [CONFIG_KEYS.OPENAI_API_KEY]: fromDb[CONFIG_KEYS.OPENAI_API_KEY] ?? process.env.OPENAI_API_KEY ?? "",
    [CONFIG_KEYS.OPENAPI_BEARER]: fromDb[CONFIG_KEYS.OPENAPI_BEARER] ?? process.env.OPENAPI_BEARER ?? "",
    [CONFIG_KEYS.OPENAI_CHAT_MODEL]:
      fromDb[CONFIG_KEYS.OPENAI_CHAT_MODEL] ?? process.env.OPENAI_CHAT_MODEL ?? "gpt-5.3-chat-latest",
  };
  loaded = true;
}

export function getOpenaiApiKey(): string {
  return cache[CONFIG_KEYS.OPENAI_API_KEY] ?? "";
}

export function getOpenapiBearer(): string {
  return cache[CONFIG_KEYS.OPENAPI_BEARER] ?? "";
}

export function getOpenaiChatModel(): string {
  return cache[CONFIG_KEYS.OPENAI_CHAT_MODEL] || "gpt-5.3-chat-latest";
}

export function getAuthHeaders(): { Authorization: string } {
  return { Authorization: `Bearer ${getOpenapiBearer()}` };
}
