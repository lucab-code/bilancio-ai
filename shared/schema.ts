import { pgTable, text, serial, integer, jsonb, primaryKey, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── Subscription tiers ──
export const TIERS = ["free", "single", "pro", "business"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LIMITS: Record<Exclude<Tier, "free" | "single">, { analysesPerMonth: number }> = {
  pro: { analysesPerMonth: 5 },
  business: { analysesPerMonth: 15 },
};

export const PREMIUM_FEATURES = [
  "recommendations",
  "competitors",
  "web_profile",
  "pdf_export",
] as const;
export type PremiumFeature = (typeof PREMIUM_FEATURES)[number];

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  authId: text("auth_id"), // Supabase auth.user id (uuid)
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
});

export const wallets = pgTable("wallets", {
  userId: integer("user_id").primaryKey(),
  balanceCents: integer("balance_cents").notNull().default(0),
  currency: text("currency").notNull().default("eur"),
  updatedAt: text("updated_at").notNull(),
});

export const walletTransactions = pgTable("wallet_transactions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  kind: text("kind").notNull(), // credit | debit | refund
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("eur"),
  description: text("description").notNull(),
  source: text("source").notNull(),
  reference: text("reference"),
  metadata: jsonb("metadata"),
  createdAt: text("created_at").notNull(),
});

export const billingCheckouts = pgTable("billing_checkouts", {
  sessionId: text("session_id").primaryKey(),
  userId: integer("user_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("eur"),
  status: text("status").notNull(),
  stripePaymentStatus: text("stripe_payment_status"),
  checkoutUrl: text("checkout_url"),
  metadata: jsonb("metadata"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const analyses = pgTable("analyses", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  mode: text("mode").notNull(), // 'business' | 'competitor'
  companyName: text("company_name").notNull(),
  companyId: text("company_id"),
  taxCode: text("tax_code"),
  address: text("address"),
  status: text("status").notNull().default("pending"), // pending | loading | complete | error
  companyDetails: jsonb("company_details"),
  financialData: jsonb("financial_data"),
  aiAnalysis: jsonb("ai_analysis"),
  competitors: jsonb("competitors"),
  createdAt: text("created_at"),
});

// Sessioni (token -> user_id) per auth
export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  userId: integer("user_id").notNull(),
});

// Chiavi API e config (Supabase / env)
export const appConfig = pgTable("app_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// ── Subscriptions ──
export const subscriptions = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  tier: text("tier").notNull(), // 'pro' | 'business'
  stripeSubscriptionId: text("stripe_subscription_id"),
  stripeCustomerId: text("stripe_customer_id"),
  status: text("status").notNull().default("active"), // active | canceled | past_due | trialing
  currentPeriodStart: text("current_period_start").notNull(),
  currentPeriodEnd: text("current_period_end").notNull(),
  analysesUsed: integer("analyses_used").notNull().default(0),
  analysesLimit: integer("analyses_limit").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type Subscription = typeof subscriptions.$inferSelect;

// Cache bilanci Camera di Commercio (evita ri-acquisto)
export const bilanciCache = pgTable(
  "bilanci_cache",
  {
    companyId: text("company_id").notNull(),
    taxCode: text("tax_code").notNull(),
    data: jsonb("data").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.taxCode] })]
);

// Cache dettagli azienda OpenAPI IT-advanced (evita richieste ripetute = meno crediti)
export const companyDetailsCache = pgTable("company_details_cache", {
  companyId: text("company_id").primaryKey(),
  data: jsonb("data").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Cache Full Company OpenAPI (flow business grafico ricavi + EBITDA)
export const companyFullCache = pgTable(
  "company_full_cache",
  {
    companyId: text("company_id").notNull(),
    taxCode: text("tax_code").notNull(),
    data: jsonb("data").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.taxCode] })]
);

export const userUploadedBilanci = pgTable("user_uploaded_bilanci", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  companyId: text("company_id").notNull(),
  taxCode: text("tax_code"),
  year: text("year").notNull(),
  mimeType: text("mime_type").notNull(),
  storagePath: text("storage_path").notNull(),
  bucket: text("bucket"),
  storageBackend: text("storage_backend").notNull().default("supabase"),
  originalName: text("original_name"),
  sizeBytes: integer("size_bytes"),
  extractedData: jsonb("extracted_data"),
  source: text("source").notNull().default("user_upload"),
  createdAt: text("created_at").notNull(),
});

export const insertAnalysisSchema = createInsertSchema(analyses).omit({
  id: true,
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
});

export type InsertAnalysis = z.infer<typeof insertAnalysisSchema>;
export type Analysis = typeof analyses.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type UserUploadedBilancio = typeof userUploadedBilanci.$inferSelect;

// Types for OpenAPI.it responses
export interface CompanySearchResult {
  id: string;
  denominazione: string;
  indirizzo?: string;
  comune?: string;
  provincia?: string;
  piva?: string;
  cf?: string;
}

export interface CompanyDetail {
  cf: string;
  denominazione: string;
  piva: string;
  indirizzo: string;
  comune: string;
  provincia: string;
  stato_attivita: string;
  cap: string;
  id: string;
  pec?: string;
  telefono?: string;
  dettaglio?: {
    rea?: string;
    cciaa?: string;
    pec?: string;
    descrizione_ateco?: string;
    codice_ateco?: string;
    data_inizio_attivita?: string;
    bilanci?: Record<string, {
      data_chiusura_bilancio: string;
      fatturato: number;
      patrimonio_netto: number;
      capitale_sociale: number;
      costo_personale: number;
      totale_attivo: number;
      dipendenti: number;
    }>;
    soci?: Array<{
      denominazione: string;
      cf_socio: string;
      quota: number;
    }>;
  };
}

export interface FinancialStatement {
  year: string;
  balanceSheetDate: string;
  totaleAttivo?: number;
  totalePassivo?: number;
  patrimonioNetto?: number;
  immobilizzazioni?: number;
  attivoCorrCorrenti?: number;
  debitiBreveTermine?: number;
  debitiLungoTermine?: number;
  ricaviVendite?: number;
  valoreProduzioneAzione?: number;
  costiProduzione?: number;
  risultatoOperativo?: number;
  utilePerditaEsercizio?: number;
  ebitda?: number;
  ebit?: number;
  cashFlowOperativo?: number;
  cashFlowInvestimenti?: number;
  cashFlowFinanziamento?: number;
  roi?: number;
  roe?: number;
  ros?: number;
  currentRatio?: number;
  debtEquityRatio?: number;
  rawData?: Record<string, any>;
}

export interface AIAnalysisResult {
  summary: string;
  strengths: string[];
  weaknesses: string[];
  opportunities: string[];
  threats: string[];
  recommendations: string[];
  marketComparison: string;
  incomeStatementAnalysis: string;
  balanceSheetAnalysis: string;
  cashFlowAnalysis: string;
  keyMetrics: {
    label: string;
    value: string;
    trend: 'up' | 'down' | 'stable';
    description: string;
  }[];
}
