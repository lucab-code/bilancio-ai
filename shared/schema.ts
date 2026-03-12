import { pgTable, text, serial, integer, jsonb, primaryKey } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  authId: text("auth_id"), // Supabase auth.user id (uuid)
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
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
