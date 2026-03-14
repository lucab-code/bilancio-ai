/**
 * Carica .env e inserisce le chiavi in Supabase (tabella app_config).
 * Esegui: DATABASE_URL="..." npm run db:seed
 * oppure crea .env con DATABASE_URL, OPENAI_API_KEY, OPENAPI_BEARER e lancia npm run db:seed
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

// Carica .env dalla root del progetto
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) {
      const value = m[2].replace(/^["']|["']$/g, "").trim();
      if (!process.env[m[1]]) process.env[m[1]] = value;
    }
  }
}

async function main() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error("DATABASE_URL mancante. Imposta in .env o: DATABASE_URL=... npm run db:seed");
    process.exit(1);
  }

  const openaiApiKey = process.env.OPENAI_API_KEY ?? "";
  const openapiBearer = process.env.OPENAPI_BEARER ?? "";
  const openaiChatModel = process.env.OPENAI_CHAT_MODEL ?? "gpt-5.4";

  if (!openaiApiKey || !openapiBearer) {
    console.error("Imposta OPENAI_API_KEY e OPENAPI_BEARER in .env (o sulla riga di comando) e riprova.");
    process.exit(1);
  }

  const { getDb } = await import("../server/db");
  const { appConfig } = await import("../shared/schema");
  const db = getDb();

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY ?? "";
  const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
  const stripeProPriceId = process.env.STRIPE_PRO_PRICE_ID ?? "";
  const stripeBusinessPriceId = process.env.STRIPE_BUSINESS_PRICE_ID ?? "";

  const rows = [
    { key: "openai_api_key", value: openaiApiKey },
    { key: "openapi_bearer", value: openapiBearer },
    { key: "openai_chat_model", value: openaiChatModel },
    ...(stripeSecretKey ? [{ key: "stripe_secret_key", value: stripeSecretKey }] : []),
    ...(stripeWebhookSecret ? [{ key: "stripe_webhook_secret", value: stripeWebhookSecret }] : []),
    ...(stripeProPriceId ? [{ key: "stripe_pro_price_id", value: stripeProPriceId }] : []),
    ...(stripeBusinessPriceId ? [{ key: "stripe_business_price_id", value: stripeBusinessPriceId }] : []),
    { key: "billing_business_analysis_cents", value: process.env.BILLING_BUSINESS_ANALYSIS_CENTS ?? "1500" },
    { key: "billing_subscriber_extra_analysis_cents", value: process.env.BILLING_SUBSCRIBER_EXTRA_ANALYSIS_CENTS ?? "1200" },
  ];

  for (const row of rows) {
    await db
      .insert(appConfig)
      .values(row)
      .onConflictDoUpdate({ target: appConfig.key, set: { value: row.value } });
  }

  console.log("Config scritta in Supabase (app_config): openai_api_key, openapi_bearer, openai_chat_model");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
