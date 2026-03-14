import type { Express, Request, Response } from "express";
import type { Server } from "http";
import Stripe from "stripe";
import { storage } from "./storage";
import { deleteStoredBilancioDocument, isStoredInlineBilancioDocument, isStoredPdfDocument, persistBilancioDocument, persistPrivateBilancioDocument, readStoredBilancioDocument } from "./bilancio-files";
import { buildOfficialWebsiteProfile, inferOfficialWebsiteUrl, pickOfficialWebsiteUrl } from "./company-web-profile";
import { BILANCIO_OTTICO_XBRL_SOURCE, extractStructuredBilancioData } from "./xbrl-parser";
import {
  getOpenaiApiKey,
  getOpenaiChatModel,
  getCompanyBaseUrl,
  getDocuEngineBaseUrl,
  getAuthHeaders,
  getBusinessAnalysisPriceCents,
  getSubscriberExtraAnalysisPriceCents,
  getStripeSecretKey,
  getStripeWebhookSecret,
  getStripeProPriceId,
  getStripeBusinessPriceId,
} from "./config";
import { createStructuredResponse, createTextResponse, OpenAIResponsesError } from "./openai";
import { getOrCreateUserFromSupabaseToken, isSupabaseAuthConfigured } from "./supabase-auth";
import {
  BILLING_CURRENCY,
  consumeBusinessAnalysisCredits,
  createPendingCheckout,
  getWalletSummary,
  markCheckoutAsCompleted,
  refundBusinessAnalysisCredits,
  getUserTier,
  getActiveSubscription,
  canAccessFeature,
  consumeSubscriptionAnalysis,
  createSubscription,
  resetSubscriptionAnalyses,
  cancelSubscription,
} from "./billing";
import type { Tier, UserUploadedBilancio } from "@shared/schema";

function getCompanyBase(): string {
  return getCompanyBaseUrl();
}

function getDocuEngineBase(): string {
  return getDocuEngineBaseUrl();
}

function getStripeClient(): Stripe {
  const secretKey = getStripeSecretKey();
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY non configurata");
  }

  if (!stripeClient) {
    stripeClient = new Stripe(secretKey);
  }

  return stripeClient;
}

function isCreditBillingEnabled(): boolean {
  return Boolean(getStripeSecretKey().trim());
}

function getFrontendOrigin(req: Request): string {
  const configured = (process.env.FRONTEND_ORIGIN || "").trim();
  if (configured) return configured.replace(/\/$/, "");

  if (process.env.NODE_ENV === "production") {
    throw new Error("FRONTEND_ORIGIN non configurato");
  }

  const origin = typeof req.headers.origin === "string" ? req.headers.origin.trim() : "";
  if (origin) return origin.replace(/\/$/, "");

  const host = typeof req.headers.host === "string" ? req.headers.host.trim() : "127.0.0.1:3000";
  const protoHeader = typeof req.headers["x-forwarded-proto"] === "string" ? req.headers["x-forwarded-proto"] : "";
  const protocol = protoHeader || req.protocol || "http";
  return `${protocol}://${host}`;
}

// In-memory search result cache (TTL: 10 min)
const searchCache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 10 * 60 * 1000;
const DOCUENGINE_DOCUMENT_IDS = {
  BILANCIO_RICLASSIFICATO: "669533fe6d4f51cbde8da353",
  BILANCIO_OTTICO: "667443c29e6f0e447bc265aa",
} as const;
const BILANCIO_OTTICO_COMPARATIVE_SOURCE = "bilancio-ottico-comparative-4y-v1";
const BILANCIO_OTTICO_PDF_SOURCE = "bilancio-ottico-pdf-v1";
const COMPANY_DESCRIPTION_WEB_VERSION = "web-v4";
const BUSINESS_INSIGHTS_VERSION = "insights-v3";
let stripeClient: Stripe | null = null;

function getLatestPurchasedBilancio(purchasedBilanci: Record<string, any> | undefined) {
  if (!purchasedBilanci || typeof purchasedBilanci !== "object") return null;

  const years = Object.keys(purchasedBilanci).sort((a, b) => b.localeCompare(a));
  if (years.length === 0) return null;

  const year = years[0];
  const item = purchasedBilanci[year];
  if (!item || typeof item !== "object") return null;

  return { year, ...item };
}

const LEGAL_FORM_TOKENS = new Set([
  "spa",
  "srl",
  "srls",
  "sas",
  "snc",
  "sap",
  "scarl",
  "coop",
  "cooperativa",
  "societa",
  "societaa",
]);

function normalizeCompanySearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bs[\W_]*p[\W_]*a\b/g, " spa ")
    .replace(/\bs[\W_]*r[\W_]*l[\W_]*s\b/g, " srls ")
    .replace(/\bs[\W_]*r[\W_]*l\b/g, " srl ")
    .replace(/\bs[\W_]*a[\W_]*s\b/g, " sas ")
    .replace(/\bs[\W_]*n[\W_]*c\b/g, " snc ")
    .replace(/\bs[\W_]*a[\W_]*p[\W_]*a\b/g, " sapa ")
    .replace(/\bs[\W_]*c[\W_]*a[\W_]*r[\W_]*l\b/g, " scarl ")
    .replace(/societa'/g, " societa ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenizeCompanySearchText(value: string): string[] {
  return normalizeCompanySearchText(value).split(" ").filter(Boolean);
}

function buildCompanySearchQueries(query: string): string[] {
  const normalizedQuery = normalizeCompanySearchText(query);
  const tokens = tokenizeCompanySearchText(query);
  const candidates: string[] = [];

  const pushCandidate = (candidate: string) => {
    const normalizedCandidate = normalizeCompanySearchText(candidate);
    if (!normalizedCandidate || normalizedCandidate.length < 2) return;
    if (!candidates.includes(normalizedCandidate)) {
      candidates.push(normalizedCandidate);
    }
  };

  pushCandidate(normalizedQuery);

  for (let length = tokens.length - 1; length >= 1 && candidates.length < 4; length--) {
    pushCandidate(tokens.slice(0, length).join(" "));
  }

  const significantTokens = tokens.filter((token) => token.length > 1 && !LEGAL_FORM_TOKENS.has(token));
  if (significantTokens.length >= 2) {
    pushCandidate(significantTokens.join(" "));
  } else if (significantTokens.length === 1 && significantTokens[0].length >= 3) {
    pushCandidate(significantTokens[0]);
  }

  return candidates;
}

function scoreCompanySearchResult(query: string, company: {
  denominazione?: string;
  indirizzo?: string;
  comune?: string;
  provincia?: string;
  cap?: string;
}, sourceRank: number): number {
  const normalizedQuery = normalizeCompanySearchText(query);
  const queryTokens = tokenizeCompanySearchText(query);
  const significantTokens = queryTokens.filter((token) => token.length > 1 && !LEGAL_FORM_TOKENS.has(token));
  const name = normalizeCompanySearchText(company.denominazione || "");
  const location = normalizeCompanySearchText(
    [company.indirizzo, company.cap, company.comune, company.provincia].filter(Boolean).join(" "),
  );

  let score = Math.max(0, 300 - sourceRank * 5);

  if (name === normalizedQuery) score += 800;
  if (normalizedQuery && name.startsWith(normalizedQuery)) score += 500;
  if (normalizedQuery && name.includes(normalizedQuery)) score += 250;

  const significantPhrase = significantTokens.join(" ");
  if (significantPhrase && name.startsWith(significantPhrase)) score += 240;
  if (significantPhrase && name.includes(significantPhrase)) score += 140;
  if (significantPhrase && location.includes(significantPhrase)) score += 80;

  const tokensToScore = significantTokens.length > 0 ? significantTokens : queryTokens;
  let matchedTokens = 0;

  for (const token of tokensToScore) {
    if (name.includes(token)) {
      score += 60;
      matchedTokens += 1;
      continue;
    }

    if (location.includes(token)) {
      score += 32;
      matchedTokens += 1;
      continue;
    }

    score -= 35;
  }

  if (tokensToScore.length > 0 && matchedTokens === tokensToScore.length) {
    score += 180;
  }

  if (significantTokens.some((token) => location.includes(token))) {
    score += 60;
  }

  return score;
}

function buildCompanySearchResultFromCachedDetails(
  query: string,
  sourceRank: number,
  companyDetails: any,
) {
  if (!companyDetails || typeof companyDetails !== "object") return null;

  const result = {
    id: typeof companyDetails.id === "string" ? companyDetails.id : "",
    denominazione:
      (typeof companyDetails.denominazione === "string" && companyDetails.denominazione) ||
      (typeof companyDetails.companyName === "string" && companyDetails.companyName) ||
      "",
    indirizzo: typeof companyDetails.indirizzo === "string" ? companyDetails.indirizzo : "",
    comune: typeof companyDetails.comune === "string" ? companyDetails.comune : "",
    provincia: typeof companyDetails.provincia === "string" ? companyDetails.provincia : "",
    cap: typeof companyDetails.cap === "string" ? companyDetails.cap : "",
    piva:
      (typeof companyDetails.partita_iva === "string" && companyDetails.partita_iva) ||
      (typeof companyDetails.vatCode === "string" && companyDetails.vatCode) ||
      "",
    cf:
      (typeof companyDetails.codice_fiscale === "string" && companyDetails.codice_fiscale) ||
      (typeof companyDetails.taxCode === "string" && companyDetails.taxCode) ||
      "",
    stato_attivita:
      (typeof companyDetails.stato_attivita === "string" && companyDetails.stato_attivita) ||
      (typeof companyDetails.activityStatus === "string" && companyDetails.activityStatus) ||
      "",
    _score: 0,
    _sourceRank: sourceRank,
  };

  if (!result.id || !result.denominazione) return null;
  result._score = scoreCompanySearchResult(query, result, sourceRank);
  return result;
}

function buildCompanySearchResultFromAnalysis(
  query: string,
  sourceRank: number,
  analysis: any,
) {
  if (!analysis || typeof analysis !== "object") return null;

  const fromCompanyDetails = buildCompanySearchResultFromCachedDetails(
    query,
    sourceRank,
    analysis.companyDetails,
  );
  if (fromCompanyDetails) {
    return fromCompanyDetails;
  }

  const result = {
    id: typeof analysis.companyId === "string" ? analysis.companyId : "",
    denominazione: typeof analysis.companyName === "string" ? analysis.companyName : "",
    indirizzo: typeof analysis.address === "string" ? analysis.address : "",
    comune: "",
    provincia: "",
    cap: "",
    piva: "",
    cf: typeof analysis.taxCode === "string" ? analysis.taxCode : "",
    stato_attivita: "",
    _score: 0,
    _sourceRank: sourceRank,
  };

  if (!result.id || !result.denominazione) return null;
  result._score = scoreCompanySearchResult(query, result, sourceRank);
  return result;
}

type ScoredCompanySearchResult = NonNullable<ReturnType<typeof buildCompanySearchResultFromAnalysis>>;

async function searchLocalCompanyResults(query: string) {
  const analyses = await storage.listAnalyses();
  const seen = new Set<string>();
  const results: ScoredCompanySearchResult[] = [];

  for (const analysis of [...analyses].reverse()) {
    const dedupeKey =
      (typeof analysis?.companyId === "string" && analysis.companyId.trim()) ||
      (typeof analysis?.taxCode === "string" && analysis.taxCode.trim()) ||
      normalizeCompanySearchText(String(analysis?.companyName || ""));

    if (!dedupeKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const result = buildCompanySearchResultFromAnalysis(query, results.length, analysis);
    if (!result) continue;
    if (result._score < 120) continue;
    results.push(result);
  }

  return results
    .sort((a, b) => {
      if ((b?._score || 0) !== (a?._score || 0)) return (b?._score || 0) - (a?._score || 0);
      return (a?._sourceRank || 0) - (b?._sourceRank || 0);
    })
    .slice(0, 8)
    .map(({ _score, _sourceRank, ...company }) => company);
}

function findNumericValue(values: unknown[]): { found: boolean; value: number } {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return { found: true, value };
    }

    if (typeof value === "string") {
      const normalized = value.trim().replace(/\s+/g, "").replace(",", ".");
      if (!normalized) continue;
      const parsed = Number.parseFloat(normalized);
      if (Number.isFinite(parsed)) {
        return { found: true, value: parsed };
      }
    }
  }

  return { found: false, value: 0 };
}

function buildStructuredEbitdaResponse(
  bilanci: Record<string, any> | undefined,
  purchasedBilanci: Record<string, any> | undefined,
) {
  const response = {
    ebitda: {} as Record<string, { value: number; margin_pct: number; confidence: "high"; method: string }>,
    revenue: {} as Record<string, number>,
  };

  const years = Array.from(
    new Set([
      ...Object.keys(bilanci || {}),
      ...Object.keys(purchasedBilanci || {}),
    ]),
  ).sort();

  for (const year of years) {
    const summaryYear = bilanci?.[year];
    const bilancioData = purchasedBilanci?.[year]?.bilancioData;
    const revenue = findNumericValue([
      bilancioData?.fatturato,
      bilancioData?.ricavi_vendite,
      bilancioData?.ricavi,
      bilancioData?.turnover,
      bilancioData?.valore_produzione,
      summaryYear?.fatturato,
      summaryYear?.turnover,
    ]);

    if (revenue.found) {
      response.revenue[year] = revenue.value;
    }

    if (!bilancioData || typeof bilancioData !== "object") continue;

    const directEbitda = findNumericValue([bilancioData?.ebitda]);
    if (directEbitda.found) {
      response.ebitda[year] = {
        value: directEbitda.value,
        margin_pct: revenue.found && revenue.value > 0 ? Number(((directEbitda.value / revenue.value) * 100).toFixed(2)) : 0,
        confidence: "high",
        method: "Valore EBITDA restituito direttamente da OpenAPI nel bilancio riclassificato.",
      };
    }
  }

  return response;
}

const EBITDA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    years: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          year: { type: "string" },
          revenue: { type: "number" },
          ebitda: {
            type: "object",
            additionalProperties: false,
            properties: {
              value: { type: "number" },
              margin_pct: { type: "number" },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              method: { type: "string" },
            },
            required: ["value", "margin_pct", "confidence", "method"],
          },
        },
        required: ["year", "revenue", "ebitda"],
      },
    },
  },
  required: ["years"],
} as const;

const BILANCIO_OTTICO_PDF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    years: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          year: { type: "string" },
          sourcePurchaseYear: { type: "string" },
          sourcePeriod: { type: "string", enum: ["current", "comparative"] },
          data_chiusura_bilancio: { type: ["string", "null"] },
          revenue: { type: ["number", "null"] },
          ebit: { type: ["number", "null"] },
          amortization: { type: ["number", "null"] },
          ebitda: { type: ["number", "null"] },
          netIncome: { type: ["number", "null"] },
          taxes: { type: ["number", "null"] },
          changeNwc: { type: ["number", "null"] },
          capex: { type: ["number", "null"] },
          unleveredFreeCashFlow: { type: ["number", "null"] },
          tradeReceivables: { type: ["number", "null"] },
          inventory: { type: ["number", "null"] },
          tradePayables: { type: ["number", "null"] },
          cash: { type: ["number", "null"] },
          shortTermFinancialDebt: { type: ["number", "null"] },
          longTermFinancialDebt: { type: ["number", "null"] },
          totalFinancialDebt: { type: ["number", "null"] },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: [
          "year",
          "sourcePurchaseYear",
          "sourcePeriod",
          "data_chiusura_bilancio",
          "revenue",
          "ebit",
          "amortization",
          "ebitda",
          "netIncome",
          "taxes",
          "changeNwc",
          "capex",
          "unleveredFreeCashFlow",
          "tradeReceivables",
          "inventory",
          "tradePayables",
          "cash",
          "shortTermFinancialDebt",
          "longTermFinancialDebt",
          "totalFinancialDebt",
          "confidence",
        ],
      },
    },
  },
  required: ["years"],
} as const;

const MARKET_BENCHMARK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    metrics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          metric: { type: "string" },
          companyValue: { type: ["number", "null"] },
          marketRangeLow: { type: ["number", "null"] },
          marketRangeHigh: { type: ["number", "null"] },
          status: { type: "string", enum: ["below", "in_line", "above", "insufficient_data"] },
          comment: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          sources: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                url: { type: "string" },
              },
              required: ["title", "url"],
            },
          },
        },
        required: [
          "metric",
          "companyValue",
          "marketRangeLow",
          "marketRangeHigh",
          "status",
          "comment",
          "confidence",
          "sources",
        ],
      },
    },
  },
  required: ["metrics"],
} as const;

const WORKING_CAPITAL_RECOMMENDATIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    workingCapitalDebt: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string" },
        bullets: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["summary", "bullets"],
    },
    recommendations: {
      type: "array",
      minItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          theme: {
            type: "string",
            enum: [
              "margini_pricing",
              "capitale_circolante",
              "debito_struttura",
              "allocazione_capitale",
              "crescita_posizionamento",
            ],
          },
          title: { type: "string" },
          description: { type: "string" },
          rationale: { type: "string" },
          evidence: { type: "string" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["theme", "title", "description", "rationale", "evidence", "priority"],
      },
    },
  },
  required: ["workingCapitalDebt", "recommendations"],
} as const;

const COMPANY_DESCRIPTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: "string" },
  },
  required: ["description"],
} as const;

const COMPANY_WEB_PROFILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: "string" },
    keyProducts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          tagline: { type: ["string", "null"] },
          imageUrl: { type: ["string", "null"] },
          pageUrl: { type: ["string", "null"] },
        },
        required: ["name", "tagline", "imageUrl", "pageUrl"],
      },
    },
  },
  required: ["description", "keyProducts"],
} as const;

const COMPANY_WEB_RESEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    officialWebsiteUrl: { type: ["string", "null"] },
    researchNotes: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["officialWebsiteUrl", "researchNotes"],
} as const;

const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    keyMetrics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          value: { type: "string" },
          trend: { type: "string", enum: ["up", "down", "stable"] },
          description: { type: "string" },
        },
        required: ["label", "value", "trend", "description"],
      },
    },
    incomeStatementAnalysis: { type: "string" },
    balanceSheetAnalysis: { type: "string" },
    cashFlowAnalysis: { type: "string" },
    marketComparison: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    opportunities: { type: "array", items: { type: "string" } },
    threats: { type: "array", items: { type: "string" } },
    recommendations: { type: "array", items: { type: "string" } },
  },
  required: [
    "summary",
    "keyMetrics",
    "incomeStatementAnalysis",
    "balanceSheetAnalysis",
    "cashFlowAnalysis",
    "marketComparison",
    "strengths",
    "weaknesses",
    "opportunities",
    "threats",
    "recommendations",
  ],
} as const;

const COMPETITORS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    competitors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          reason: { type: "string" },
        },
        required: ["name", "reason"],
      },
    },
  },
  required: ["competitors"],
} as const;

function getAccessTokenFromReq(req: Request, allowQueryToken = false): string | null {
  const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization.trim() : "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const bearerToken = authHeader.slice(7).trim();
    if (bearerToken) return bearerToken;
  }

  if (allowQueryToken) {
    const queryToken = typeof req.query.access_token === "string" ? req.query.access_token.trim() : "";
    if (queryToken) return queryToken;
  }

  return null;
}

/** Restituisce il nostro user id se il Bearer token è un Supabase access_token valido. */
async function getUserIdFromReq(req: Request, allowQueryToken = false): Promise<number | null> {
  const token = getAccessTokenFromReq(req, allowQueryToken);
  if (!token) return null;
  const user = await getOrCreateUserFromSupabaseToken(token);
  return user?.id ?? null;
}

// Fetch with retry
async function fetchWithRetry(url: string, opts: RequestInit, retries = 2): Promise<globalThis.Response> {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok || i === retries) return res;
    } catch (e) {
      if (i === retries) throw e;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("Fetch failed after retries");
}

async function readJsonResponse<T>(res: globalThis.Response, fallback: T, source: string): Promise<T> {
  const bodyText = await res.text();
  if (!bodyText.trim()) {
    console.warn(`${source}: empty response body`);
    return fallback;
  }

  try {
    return JSON.parse(bodyText) as T;
  } catch (error: any) {
    console.warn(`${source}: invalid JSON response`, {
      error: error?.message,
      preview: bodyText.slice(0, 200),
    });
    return fallback;
  }
}

function extractServiceErrorMessage(bodyText: string): string {
  if (!bodyText.trim()) return "Risposta vuota dal provider";
  try {
    const parsed = JSON.parse(bodyText);
    if (typeof parsed?.message === "string" && parsed.message.trim()) return parsed.message.trim();
    if (typeof parsed?.error === "string" && parsed.error.trim()) return parsed.error.trim();
  } catch {
    // Ignore JSON parsing and fall back to raw text.
  }
  return bodyText.trim().slice(0, 300);
}

function extractYear(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/\b(20\d{2}|19\d{2})\b/);
  return match?.[1] ?? null;
}

function getTargetBilancioYearsFromMap(bilanci: Record<string, any> | undefined): string[] {
  if (!bilanci || typeof bilanci !== "object") return [];
  const availableYears = Object.keys(bilanci)
    .map((year) => Number.parseInt(year, 10))
    .filter((year) => Number.isFinite(year))
    .sort((a, b) => b - a);

  if (availableYears.length === 0) return [];

  const availableSet = new Set(availableYears);
  const latestYear = availableYears[0];
  return [latestYear, latestYear - 2]
    .filter((year) => availableSet.has(year))
    .map(String);
}

function normalizeTargetYears(years: unknown, fallbackBilanci?: Record<string, any>): string[] {
  const fromInput = Array.isArray(years)
    ? years
        .map((year) => extractYear(year))
        .filter((year): year is string => Boolean(year))
    : [];

  const normalized = fromInput.length > 0 ? fromInput : getTargetBilancioYearsFromMap(fallbackBilanci);
  return Array.from(new Set(normalized)).sort((a, b) => b.localeCompare(a));
}

function getResponseDataPayload(data: any): any {
  return data?.data && typeof data.data === "object" ? data.data : data;
}

function normalizeActivityStatus(value: unknown): string {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  const map: Record<string, string> = {
    A: "ATTIVA",
    I: "INATTIVA",
    C: "CESSATA",
    S: "SOSPESA",
  };
  return map[code] || (typeof value === "string" && value.trim() ? value.trim().toUpperCase() : "");
}

function limitBilanciToLatestYears(bilanci: Record<string, any>, maxYears = 5): Record<string, any> {
  return Object.keys(bilanci)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, maxYears)
    .reduce((acc, year) => {
      acc[year] = bilanci[year];
      return acc;
    }, {} as Record<string, any>);
}

function isComparativeOtticoBilancioData(value: any): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.source === BILANCIO_OTTICO_XBRL_SOURCE &&
    value.periods &&
    typeof value.periods === "object",
  );
}

function getOtticoStructuredData(entry: any): any {
  if (isComparativeOtticoBilancioData(entry?.bilancioData)) {
    return entry.bilancioData;
  }
  if (isComparativeOtticoBilancioData(entry?.bilancioData?.structuredData)) {
    return entry.bilancioData.structuredData;
  }
  return null;
}

function getPurchasedBilanciBySource(
  data: { purchasedBilanci?: Record<string, any>; purchasedBilanciBySource?: Record<string, Record<string, any>> } | Record<string, any> | undefined,
  source: string,
): Record<string, any> {
  const fromSourceMap =
    data &&
    typeof data === "object" &&
    "purchasedBilanciBySource" in data &&
    data.purchasedBilanciBySource &&
    typeof data.purchasedBilanciBySource === "object"
      ? data.purchasedBilanciBySource[source]
      : undefined;

  if (fromSourceMap && typeof fromSourceMap === "object") {
    return fromSourceMap;
  }

  const purchasedBilanci =
    data &&
    typeof data === "object" &&
    "purchasedBilanci" in data &&
    data.purchasedBilanci &&
    typeof data.purchasedBilanci === "object"
      ? data.purchasedBilanci
      : data;

  return Object.entries<any>(purchasedBilanci || {}).reduce((acc, [year, entry]) => {
    if (entry?.bilancioData?.source === source) {
      acc[year] = entry;
    }
    return acc;
  }, {} as Record<string, any>);
}

function buildCoveredYears(latestYear: string): string[] {
  const parsed = Number.parseInt(latestYear, 10);
  if (!Number.isFinite(parsed)) return [];
  return [parsed - 3, parsed - 2, parsed - 1, parsed]
    .map(String)
    .sort((a, b) => a.localeCompare(b));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function calculateUnleveredFreeCashFlow(data: {
  ebitda?: unknown;
  taxes?: unknown;
  change_nwc?: unknown;
  capex?: unknown;
} | null | undefined): number | null {
  const ebitda = data?.ebitda;
  const taxes = data?.taxes;
  const changeNwc = data?.change_nwc;
  const capex = data?.capex;

  if (!isFiniteNumber(ebitda) || !isFiniteNumber(taxes) || !isFiniteNumber(changeNwc) || !isFiniteNumber(capex)) {
    return null;
  }

  return ebitda - taxes - changeNwc - capex;
}

function calculatePercentage(value: unknown, denominator: unknown): number | null {
  if (!isFiniteNumber(value) || !isFiniteNumber(denominator) || denominator === 0) return null;
  return Number(((value / denominator) * 100).toFixed(1));
}

function calculateRatio(value: unknown, denominator: unknown): number | null {
  if (!isFiniteNumber(value) || !isFiniteNumber(denominator) || denominator === 0) return null;
  return Number((value / denominator).toFixed(2));
}

function calculateDays(balance: unknown, flow: unknown): number | null {
  if (!isFiniteNumber(balance) || !isFiniteNumber(flow) || flow === 0) return null;
  return Number(((balance / flow) * 365).toFixed(0));
}

function enrichBilancioDerivedMetrics(row: Record<string, any>) {
  const totalFinancialDebt = isFiniteNumber(row.debito_finanziario_totale)
    ? row.debito_finanziario_totale
    : (isFiniteNumber(row.debito_finanziario_breve) || isFiniteNumber(row.debito_finanziario_lungo))
      ? (row.debito_finanziario_breve ?? 0) + (row.debito_finanziario_lungo ?? 0)
      : null;

  const nwc =
    (isFiniteNumber(row.crediti_commerciali) ? row.crediti_commerciali : null) != null ||
    (isFiniteNumber(row.rimanenze) ? row.rimanenze : null) != null ||
    (isFiniteNumber(row.debiti_commerciali) ? row.debiti_commerciali : null) != null
      ? (row.crediti_commerciali ?? 0) + (row.rimanenze ?? 0) - (row.debiti_commerciali ?? 0)
      : null;

  const netDebt =
    isFiniteNumber(totalFinancialDebt) || isFiniteNumber(row.cassa)
      ? (totalFinancialDebt ?? 0) - (row.cassa ?? 0)
      : null;

  return {
    ...row,
    debito_finanziario_totale: totalFinancialDebt,
    nwc,
    nwc_pct_revenue: calculatePercentage(nwc, row.fatturato),
    dso: calculateDays(row.crediti_commerciali, row.fatturato),
    dio: calculateDays(row.rimanenze, row.fatturato),
    dpo: calculateDays(row.debiti_commerciali, row.fatturato),
    net_debt: netDebt,
    net_debt_ebitda: calculateRatio(netDebt, row.ebitda),
    debt_equity: calculateRatio(totalFinancialDebt, row.patrimonio_netto),
    cash_conversion: calculatePercentage(row.unlevered_free_cash_flow, row.ebitda),
  };
}

function createMissingComparativeYear(year: string) {
  return enrichBilancioDerivedMetrics({
    data_chiusura_bilancio: null,
    fatturato: null,
    ebit: null,
    ammortamenti: null,
    ebitda: null,
    utile_netto: null,
    taxes: null,
    change_nwc: null,
    capex: null,
    unlevered_free_cash_flow: null,
    crediti_commerciali: null,
    rimanenze: null,
    debiti_commerciali: null,
    cassa: null,
    debito_finanziario_breve: null,
    debito_finanziario_lungo: null,
    debito_finanziario_totale: null,
    dso: null,
    dio: null,
    dpo: null,
    patrimonio_netto: null,
    capitale_sociale: null,
    costo_personale: null,
    totale_attivo: null,
    status: "missing" as const,
    sourcePurchaseYear: null,
    sourcePeriod: null,
    method: "Periodo non disponibile o campi XBRL incompleti nel bilancio ottico.",
  });
}

function buildBilanciFromComparativeXbrl(
  purchasedBilanci: Record<string, any> | undefined,
  coveredYears: string[],
): Record<string, any> {
  const output = coveredYears.reduce((acc, year) => {
    acc[year] = createMissingComparativeYear(year);
    return acc;
  }, {} as Record<string, any>);

  for (const entry of Object.values(purchasedBilanci || {})) {
    const bilancioData = getOtticoStructuredData(entry);
    if (!bilancioData) continue;

    for (const [year, period] of Object.entries<any>(bilancioData.periods || {})) {
      if (!(year in output) || !period || typeof period !== "object") continue;
    output[year] = {
      ...output[year],
      ...period,
      method:
          period.status === "ok"
            ? "EBITDA ricavato dai dati strutturati del bilancio ottico: EBIT + ammortamenti."
            : "Periodo non disponibile o campi strutturati incompleti nel bilancio ottico.",
    };
    output[year] = enrichBilancioDerivedMetrics(output[year]);
  }
  }

  return output;
}

function buildBilanciFromPdfExtraction(coveredYears: string[], extractedYears: any[]): Record<string, any> {
  const output = coveredYears.reduce((acc, year) => {
    acc[year] = createMissingComparativeYear(year);
    return acc;
  }, {} as Record<string, any>);

  for (const item of extractedYears || []) {
    const year = extractYear(item?.year);
    if (!year || !(year in output)) continue;
    const extractedTaxes = typeof item?.taxes === "number" ? item.taxes : null;
    const extractedChangeNwc = typeof item?.changeNwc === "number" ? item.changeNwc : null;
    const extractedCapex = typeof item?.capex === "number" ? item.capex : null;
    const extractedUfcf =
      typeof item?.unleveredFreeCashFlow === "number"
        ? item.unleveredFreeCashFlow
        : calculateUnleveredFreeCashFlow({
            ebitda: item?.ebitda,
            taxes: extractedTaxes,
            change_nwc: extractedChangeNwc,
            capex: extractedCapex,
          });

    output[year] = {
      ...output[year],
      data_chiusura_bilancio: typeof item?.data_chiusura_bilancio === "string" ? item.data_chiusura_bilancio : null,
      fatturato: typeof item?.revenue === "number" ? item.revenue : null,
      ebit: typeof item?.ebit === "number" ? item.ebit : null,
      ammortamenti: typeof item?.amortization === "number" ? item.amortization : null,
      ebitda: typeof item?.ebitda === "number" ? item.ebitda : null,
      utile_netto: typeof item?.netIncome === "number" ? item.netIncome : null,
      taxes: extractedTaxes,
      change_nwc: extractedChangeNwc,
      capex: extractedCapex,
      unlevered_free_cash_flow: extractedUfcf,
      crediti_commerciali: typeof item?.tradeReceivables === "number" ? item.tradeReceivables : null,
      rimanenze: typeof item?.inventory === "number" ? item.inventory : null,
      debiti_commerciali: typeof item?.tradePayables === "number" ? item.tradePayables : null,
      cassa: typeof item?.cash === "number" ? item.cash : null,
      debito_finanziario_breve: typeof item?.shortTermFinancialDebt === "number" ? item.shortTermFinancialDebt : null,
      debito_finanziario_lungo: typeof item?.longTermFinancialDebt === "number" ? item.longTermFinancialDebt : null,
      debito_finanziario_totale: typeof item?.totalFinancialDebt === "number" ? item.totalFinancialDebt : null,
      status:
        typeof item?.revenue === "number" && typeof item?.ebitda === "number"
          ? "ok"
          : "missing",
      sourcePurchaseYear: typeof item?.sourcePurchaseYear === "string" ? item.sourcePurchaseYear : null,
      sourcePeriod: item?.sourcePeriod === "current" || item?.sourcePeriod === "comparative" ? item.sourcePeriod : null,
      method: "Dati estratti dal PDF del bilancio ottico. EBITDA calcolato come EBIT + ammortamenti.",
    };
    output[year] = enrichBilancioDerivedMetrics(output[year]);
  }

  return output;
}

function shouldEnrichComparativeBilanciWithAi(
  bilanci: Record<string, any> | undefined,
  coveredYears: string[],
): boolean {
  return coveredYears.some((year) => {
    const row = bilanci?.[year];
    if (!row || typeof row !== "object") return true;

    return [
      row.fatturato,
      row.ebit,
      row.ammortamenti,
      row.ebitda,
      row.utile_netto,
      row.taxes,
        row.change_nwc,
        row.capex,
        row.unlevered_free_cash_flow,
        row.crediti_commerciali,
        row.rimanenze,
        row.debiti_commerciali,
        row.cassa,
        row.debito_finanziario_breve,
        row.debito_finanziario_lungo,
        row.debito_finanziario_totale,
    ].some((value) => !isFiniteNumber(value));
  });
}

function mergeComparativeBilanci(
  currentBilanci: Record<string, any> | undefined,
  extractedBilanci: Record<string, any> | undefined,
  coveredYears: string[],
): Record<string, any> {
  const numericFields = [
    "fatturato",
    "ebit",
    "ammortamenti",
    "ebitda",
    "utile_netto",
    "taxes",
    "change_nwc",
    "capex",
    "unlevered_free_cash_flow",
    "crediti_commerciali",
    "rimanenze",
    "debiti_commerciali",
    "cassa",
    "debito_finanziario_breve",
    "debito_finanziario_lungo",
    "debito_finanziario_totale",
    "dso",
    "dio",
    "dpo",
    "patrimonio_netto",
    "capitale_sociale",
    "costo_personale",
    "totale_attivo",
    "nwc",
    "nwc_pct_revenue",
    "net_debt",
    "net_debt_ebitda",
    "debt_equity",
    "cash_conversion",
  ] as const;

  return coveredYears.reduce((acc, year) => {
    const base = currentBilanci?.[year] && typeof currentBilanci[year] === "object"
      ? { ...currentBilanci[year] }
      : createMissingComparativeYear(year);
    const patch = extractedBilanci?.[year] && typeof extractedBilanci[year] === "object"
      ? extractedBilanci[year]
      : null;

    if (patch) {
      for (const field of numericFields) {
        if (!isFiniteNumber(base[field]) && isFiniteNumber(patch[field])) {
          base[field] = patch[field];
        }
      }

      if (!base.data_chiusura_bilancio && typeof patch.data_chiusura_bilancio === "string") {
        base.data_chiusura_bilancio = patch.data_chiusura_bilancio;
      }
      if (!base.sourcePurchaseYear && typeof patch.sourcePurchaseYear === "string") {
        base.sourcePurchaseYear = patch.sourcePurchaseYear;
      }
      if (!base.sourcePeriod && (patch.sourcePeriod === "current" || patch.sourcePeriod === "comparative")) {
        base.sourcePeriod = patch.sourcePeriod;
      }
      if (base.status !== "ok" && patch.status === "ok") {
        base.status = "ok";
      }
      if (typeof patch.method === "string" && patch.method.trim()) {
        const existingMethod = typeof base.method === "string" ? base.method.trim() : "";
        const methodSuffix = "Campi mancanti integrati da AI dal PDF del bilancio ottico.";
        base.method = existingMethod.includes(methodSuffix)
          ? existingMethod
          : [existingMethod, methodSuffix].filter(Boolean).join(" ");
      }
    }

    const computedUfcf = calculateUnleveredFreeCashFlow(base);
    base.unlevered_free_cash_flow = computedUfcf;
    acc[year] = enrichBilancioDerivedMetrics(base);
    return acc;
  }, {} as Record<string, any>);
}

async function extractComparativeBilanciFromOtticoPdfs(
  purchasedBilanci: Record<string, any> | undefined,
  purchaseYears: string[],
  coveredYears: string[],
): Promise<Record<string, any> | null> {
  const apiKey = getOpenaiApiKey();
  if (!apiKey) {
    throw new Error("Chiave OpenAI non configurata.");
  }

  const extractionPrompt = `Ricevi PDF ufficiali di bilanci ottici italiani.
Estrai SOLO dati leggibili o calcolabili direttamente dal documento, senza inventare nulla.
Per il PDF allegato:
- identifica l'anno corrente del deposito e l'anno comparativo precedente
- estrai ricavi delle vendite e delle prestazioni
- estrai EBIT / risultato operativo / differenza tra valore e costi della produzione
- estrai ammortamenti come somma di ammortamenti immobilizzazioni immateriali + materiali
- calcola EBITDA = EBIT + ammortamenti
- estrai netIncome come utile o perdita d'esercizio attribuibile al periodo
- estrai taxes come imposte sul reddito dell'esercizio, espresse come assorbimento di cassa positivo
- estrai changeNwc come variazione del capitale circolante netto operativo con segno cash flow: positivo se assorbe cassa, negativo se rilascia cassa
- estrai capex come investimenti / spese in conto capitale, espresso come assorbimento di cassa positivo
- estrai tradeReceivables come crediti commerciali / crediti verso clienti
- estrai inventory come rimanenze / magazzino
- estrai tradePayables come debiti commerciali / debiti verso fornitori
- estrai cash come disponibilita' liquide / cassa / depositi bancari e postali
- estrai shortTermFinancialDebt come debito finanziario entro 12 mesi
- estrai longTermFinancialDebt come debito finanziario oltre 12 mesi
- estrai totalFinancialDebt come totale debito finanziario; se non esplicito ma breve+lungo sono leggibili, puoi sommarli
- calcola unleveredFreeCashFlow = EBITDA - taxes - changeNwc - capex
Restituisci una riga per ogni anno realmente leggibile.
Se un valore non e' leggibile o derivabile con alta affidabilita', usa null.
Non stimare, non interpolare, non usare conoscenze esterne.`;
  const extractedYears: Array<Record<string, unknown>> = [];

  for (const purchaseYear of purchaseYears) {
    const yearEntry = purchasedBilanci?.[purchaseYear];
    const yearDocuments = Array.isArray(yearEntry?.documents) ? yearEntry.documents : [];
    const pdfDocuments = yearDocuments.filter((document: any) => isStoredPdfDocument(document) && document?.storageKey);
    if (pdfDocuments.length === 0) continue;

    const expectedComparativeYear = String(Number.parseInt(purchaseYear, 10) - 1);
    const yearInputContent: Array<Record<string, unknown>> = [
      {
        type: "input_text",
        text: `Bilancio ottico ufficiale allegato per l'esercizio ${purchaseYear}. Devi estrarre prioritariamente due periodi: ${purchaseYear} (current) e ${expectedComparativeYear} (comparative), se presenti nel PDF.`,
      },
    ];

    for (const document of pdfDocuments) {
      const fileBuffer = await readStoredBilancioDocument(document);
      const mimeType = typeof document?.mimeType === "string" && document.mimeType ? document.mimeType : "application/pdf";
      const filename = document.originalName || document.filename || `bilancio-ottico-${purchaseYear}.pdf`;
      yearInputContent.push({
        type: "input_file",
        filename,
        file_data: `data:${mimeType};base64,${fileBuffer.toString("base64")}`,
      });
    }

    const extracted = await createStructuredResponse<{ years: Array<Record<string, unknown>> }>({
      apiKey,
      model: getOpenaiChatModel(),
      instructions: extractionPrompt,
      input: [{
        role: "user",
        content: yearInputContent,
      }],
      schemaName: `bilancio_ottico_extraction_${purchaseYear}`,
      schema: BILANCIO_OTTICO_PDF_SCHEMA,
      maxOutputTokens: 3500,
      reasoningEffort: "medium",
    });

    const expectedYears = new Set([purchaseYear, expectedComparativeYear]);
    for (const item of extracted?.years || []) {
      const normalizedYear = extractYear(item?.year);
      if (!normalizedYear || !expectedYears.has(normalizedYear)) continue;
      extractedYears.push(item);
    }
  }

  return buildBilanciFromPdfExtraction(coveredYears, extractedYears);
}

function buildBilanciFromPurchasedXbrl(purchasedBilanci: Record<string, any> | undefined): Record<string, any> {
  return limitBilanciToLatestYears(
    Object.entries(purchasedBilanci || {}).reduce((acc, [year, entry]) => {
      const bilancioData = entry?.bilancioData;
      if (!bilancioData || typeof bilancioData !== "object") {
        return acc;
      }

      const revenue = findNumericValue([
        bilancioData?.fatturato,
        bilancioData?.ricavi_vendite,
        bilancioData?.ricavi,
        bilancioData?.turnover,
      ]);
      const ebitda = findNumericValue([bilancioData?.ebitda]);

      if (!revenue.found && !ebitda.found) {
        return acc;
      }

      acc[year] = {
        data_chiusura_bilancio:
          typeof bilancioData?.dt_chiusura_bil === "string"
            ? bilancioData.dt_chiusura_bil
            : typeof bilancioData?.data_chiusura === "string"
              ? bilancioData.data_chiusura
              : typeof bilancioData?.balanceSheetDate === "string"
                ? bilancioData.balanceSheetDate.slice(0, 10)
                : `${year}-12-31`,
        fatturato: revenue.found ? revenue.value : undefined,
        ebitda: ebitda.found ? ebitda.value : undefined,
        patrimonio_netto: findNumericValue([bilancioData?.patrimonio_netto]).value || undefined,
        capitale_sociale: findNumericValue([bilancioData?.capitale_sociale]).value || undefined,
        costo_personale: findNumericValue([bilancioData?.costo_del_personale, bilancioData?.costo_personale]).value || undefined,
        totale_attivo: findNumericValue([bilancioData?.totale_attivo]).value || undefined,
      };
      return acc;
    }, {} as Record<string, any>),
    5,
  );
}

function mergeCompanyBilanciMaps(
  bilanciFromDetails: Record<string, any> | undefined,
  bilanciFromFinancial: Record<string, any> | undefined,
): Record<string, any> {
  const years = new Set([
    ...Object.keys(bilanciFromDetails || {}),
    ...Object.keys(bilanciFromFinancial || {}),
  ]);

  return Array.from(years).reduce((acc, year) => {
    acc[year] = {
      ...(bilanciFromDetails?.[year] || {}),
      ...(bilanciFromFinancial?.[year] || {}),
    };
    return acc;
  }, {} as Record<string, any>);
}

function buildFallbackCompanyDescription(
  companyDetails: any,
  financialData: any,
): string {
  const bilanci = mergeCompanyBilanciMaps(companyDetails?.dettaglio?.bilanci, financialData?.bilanci);
  const years = Object.keys(bilanci).sort();
  const lastYear = [...years].reverse().find((year) => typeof bilanci?.[year]?.fatturato === "number") || years[years.length - 1];
  const lastRevenue = lastYear ? bilanci?.[lastYear]?.fatturato : null;
  const lastEbitda = lastYear ? bilanci?.[lastYear]?.ebitda : null;
  const margin =
    typeof lastRevenue === "number" &&
    lastRevenue > 0 &&
    typeof lastEbitda === "number"
      ? ((lastEbitda / lastRevenue) * 100).toFixed(1)
      : null;

  let description = companyDetails?.denominazione || "L'azienda";

  if (companyDetails?.forma_giuridica) {
    description += ` è una ${String(companyDetails.forma_giuridica).toLowerCase()}`;
  }
  if (companyDetails?.comune) {
    description += ` con sede a ${companyDetails.comune}`;
  }
  if (companyDetails?.provincia && companyDetails?.provincia !== companyDetails?.comune) {
    description += ` (${companyDetails.provincia})`;
  }
  description += ".";

  if (lastYear && typeof lastRevenue === "number") {
    description += ` Nell'ultimo esercizio disponibile (${lastYear}) ha registrato ricavi per ${Math.round(lastRevenue).toLocaleString("it-IT")} euro`;
    if (margin) {
      description += ` con EBITDA margin del ${margin}%`;
    }
    description += ".";
  }

  return description.trim();
}

async function createAnalysisHistoryEntry({
  userId,
  mode,
  companyName,
  companyId,
  taxCode,
  address,
  companyDetails,
  financialData,
  aiAnalysis,
  competitors,
}: {
  userId: number;
  mode: "business" | "competitor";
  companyName: string;
  companyId?: string | null;
  taxCode?: string | null;
  address?: string | null;
  companyDetails?: any;
  financialData?: any;
  aiAnalysis?: any;
  competitors?: any;
}) {
  try {
    await storage.createAnalysis({
      userId,
      mode,
      companyName,
      companyId: companyId ?? null,
      taxCode: taxCode ?? null,
      address: address ?? null,
      status: "complete",
      companyDetails: companyDetails ?? null,
      financialData: financialData ?? null,
      aiAnalysis: aiAnalysis ?? null,
      competitors: competitors ?? null,
      createdAt: new Date().toISOString(),
    });
  } catch (error: any) {
    console.warn("Could not persist analysis history:", error?.message || error);
  }
}

function buildWebsiteBackedCompanyDescription(
  companyDetails: any,
  financialData: any,
  websiteProfile: {
    homepageDescription: string | null;
    homepageSummary: string | null;
    productCandidates: Array<{ name: string }>;
  } | null,
  researchNotes: string[],
): string {
  const bilanci = mergeCompanyBilanciMaps(companyDetails?.dettaglio?.bilanci, financialData?.bilanci);
  const years = Object.keys(bilanci).sort();
  const latestYear = [...years].reverse().find((year) => typeof bilanci?.[year]?.fatturato === "number") || years[years.length - 1];
  const latestRevenue = latestYear ? bilanci?.[latestYear]?.fatturato : null;
  const latestEbitda = latestYear ? bilanci?.[latestYear]?.ebitda : null;
  const latestMargin =
    typeof latestRevenue === "number" &&
    latestRevenue > 0 &&
    typeof latestEbitda === "number"
      ? ((latestEbitda / latestRevenue) * 100).toFixed(1)
      : null;

  const baseIdentity = [
    companyDetails?.denominazione || "L'azienda",
    companyDetails?.forma_giuridica ? `e' una ${String(companyDetails.forma_giuridica).toLowerCase()}` : null,
    companyDetails?.comune ? `con sede a ${companyDetails.comune}` : null,
    companyDetails?.provincia && companyDetails?.provincia !== companyDetails?.comune ? `(${companyDetails.provincia})` : null,
  ].filter(Boolean).join(" ");

  const homepagePositioning =
    websiteProfile?.homepageSummary ||
    websiteProfile?.homepageDescription ||
    researchNotes[0] ||
    "";

  const productNames = (websiteProfile?.productCandidates || [])
    .map((item) => item.name)
    .filter((name) => typeof name === "string" && name.trim())
    .slice(0, 4);
  const productSentence = productNames.length > 0
    ? `L'offerta si articola attorno a ${productNames.join(", ")}.`
    : "";

  const revenueSentence =
    latestYear && typeof latestRevenue === "number"
      ? `Nell'ultimo esercizio disponibile (${latestYear}) ha registrato ricavi per ${Math.round(latestRevenue).toLocaleString("it-IT")} euro${latestMargin ? ` con EBITDA margin del ${latestMargin}%` : ""}.`
      : "";

  const noteSentence = researchNotes.length > 1 ? researchNotes.slice(1, 3).join(" ") : "";

  const paragraphOne = `${baseIdentity}. ${homepagePositioning}`.replace(/\s+/g, " ").trim();
  const paragraphTwo = [productSentence, noteSentence, revenueSentence]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return [paragraphOne, paragraphTwo].filter(Boolean).join("\n\n");
}

function buildCompanyDescriptionContext(companyDetails: any, financialData: any) {
  const bilanci = mergeCompanyBilanciMaps(companyDetails?.dettaglio?.bilanci, financialData?.bilanci);
  const years = Object.keys(bilanci)
    .filter((year) => Boolean(extractYear(year)))
    .sort((a, b) => a.localeCompare(b));

  const financialHistory = years.map((year) => {
    const yearData = bilanci?.[year] || {};
    const revenue = typeof yearData?.fatturato === "number" ? yearData.fatturato : null;
    const ebitda = typeof yearData?.ebitda === "number" ? yearData.ebitda : null;
    return {
      year,
      revenue,
      ebitda,
      ebitda_margin_pct:
        typeof revenue === "number" && revenue > 0 && typeof ebitda === "number"
          ? Number(((ebitda / revenue) * 100).toFixed(1))
          : null,
      employees: typeof yearData?.dipendenti === "number" ? yearData.dipendenti : null,
      total_assets: typeof yearData?.totale_attivo === "number" ? yearData.totale_attivo : null,
      net_worth: typeof yearData?.patrimonio_netto === "number" ? yearData.patrimonio_netto : null,
    };
  });

  return {
    company_name: companyDetails?.denominazione || null,
    legal_form: companyDetails?.forma_giuridica || null,
    headquarters: {
      address: companyDetails?.indirizzo || null,
      city: companyDetails?.comune || null,
      province: companyDetails?.provincia || null,
      zip_code: companyDetails?.cap || null,
    },
    activity_status: companyDetails?.stato_attivita || null,
    start_date: companyDetails?.data_inizio || null,
    registration_date: companyDetails?.data_iscrizione || null,
    ateco_code: companyDetails?.dettaglio?.codice_ateco || null,
    ateco_description: companyDetails?.dettaglio?.descrizione_ateco || null,
    shareholders: Array.isArray(companyDetails?.shareholders)
      ? companyDetails.shareholders.slice(0, 5).map((shareholder: any) => ({
          company_name: shareholder?.companyName || null,
          tax_code: shareholder?.taxCode || null,
          percent_share: typeof shareholder?.percentShare === "number" ? shareholder.percentShare : null,
        }))
      : [],
    financial_history: financialHistory,
    latest_year: financialHistory.length > 0 ? financialHistory[financialHistory.length - 1] : null,
  };
}

export async function generatePrivateEquityCompanyDescription(
  companyDetails: any,
  financialData: any,
): Promise<{
  description: string;
  sources: Array<{ title: string; url: string }>;
  keyProducts: Array<{ name: string; tagline: string | null; imageUrl: string | null; pageUrl: string | null }>;
  version: string;
}> {
  const fallback = buildFallbackCompanyDescription(companyDetails, financialData);
  const apiKey = getOpenaiApiKey();
  if (!apiKey) {
    return { description: fallback, sources: [], keyProducts: [], version: COMPANY_DESCRIPTION_WEB_VERSION };
  }

  try {
    const context = buildCompanyDescriptionContext(companyDetails, financialData);
    const searchHints = [
      companyDetails?.denominazione,
      companyDetails?.comune,
      companyDetails?.provincia,
      companyDetails?.partita_iva,
      companyDetails?.codice_fiscale,
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

    let dedupedNotes: string[] = [];
    let officialSiteUrl: string | null = null;

    try {
      const webResearch = await createStructuredResponse<{
        officialWebsiteUrl: string | null;
        researchNotes: string[];
      }>({
        apiKey,
        model: getOpenaiChatModel(),
        instructions: `Sei un research analyst per private equity.
Usa il web search per raccogliere note fattuali sulla societa'.
Output richiesto:
- "officialWebsiteUrl": URL del sito ufficiale della societa' se trovato con ragionevole confidenza, altrimenti null
- "researchNotes": massimo 8 note sintetiche, concrete e verificabili
Regole:
- copri: offerta prodotti/servizi, clienti/end market, modello di ricavo, presenza geografica o canale distributivo se trovati, segnali distintivi dal sito ufficiale
- usa priorita' alta per sito ufficiale, pagine prodotto/servizi, company profile istituzionali e fonti business affidabili
- niente marketing, niente aggettivi vuoti, niente storytelling
- evita formule meta come "dal sito", "in base all'ATECO", "sulla base delle fonti", "verosimilmente" o "presumibilmente"
- non scrivere la descrizione finale per la UI`,
        input: [{
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Societa' da cercare sul web: ${searchHints.join(" | ")}\n\nDati azienda interni:\n${JSON.stringify(context, null, 2)}`,
            },
          ],
        }],
        tools: [{
          type: "web_search",
          user_location: {
            type: "approximate",
            country: "IT",
            city: typeof companyDetails?.comune === "string" ? companyDetails.comune : undefined,
            region: typeof companyDetails?.provincia === "string" ? companyDetails.provincia : undefined,
          },
        }],
        toolChoice: "auto",
        schemaName: "company_web_research",
        schema: COMPANY_WEB_RESEARCH_SCHEMA,
        maxOutputTokens: 1200,
        reasoningEffort: "medium",
      });

      dedupedNotes = Array.isArray(webResearch?.researchNotes)
        ? webResearch.researchNotes
            .filter((note) => typeof note === "string" && note.trim())
            .map((note) => note.trim())
            .slice(0, 8)
        : [];

      officialSiteUrl =
        typeof webResearch?.officialWebsiteUrl === "string" && webResearch.officialWebsiteUrl.trim()
          ? webResearch.officialWebsiteUrl.trim()
          : null;
    } catch (error: any) {
      console.warn("Company web research fallback:", error?.message || error);
    }

    if (!officialSiteUrl) {
      officialSiteUrl = await inferOfficialWebsiteUrl(companyDetails?.denominazione || "");
    }

    if (!officialSiteUrl) {
      officialSiteUrl = pickOfficialWebsiteUrl([], companyDetails?.denominazione || "");
    }
    const websiteProfile = officialSiteUrl
      ? await buildOfficialWebsiteProfile(officialSiteUrl)
      : null;

    const mergedSources: Array<{ title: string; url: string }> = [];
    if (
      websiteProfile?.officialSiteUrl &&
      !mergedSources.some((source) => source.url === websiteProfile.officialSiteUrl)
    ) {
      mergedSources.unshift({
        title: websiteProfile.homepageTitle || websiteProfile.officialSiteUrl,
        url: websiteProfile.officialSiteUrl,
      });
    }
    for (const candidate of websiteProfile?.productCandidates || []) {
      if (
        typeof candidate?.pageUrl === "string" &&
        candidate.pageUrl.trim() &&
        !mergedSources.some((source) => source.url === candidate.pageUrl)
      ) {
        mergedSources.push({
          title: candidate.name,
          url: candidate.pageUrl,
        });
      }
    }

    if (dedupedNotes.length === 0 && websiteProfile) {
      if (websiteProfile.homepageDescription) {
        dedupedNotes.push(websiteProfile.homepageDescription);
      }
      if (websiteProfile.productCandidates.length > 0) {
        dedupedNotes.push(
          `Le principali famiglie prodotto visibili sul sito ufficiale includono ${websiteProfile.productCandidates
            .slice(0, 4)
            .map((item) => item.name)
            .join(", ")}.`,
        );
      }
    }

    try {
      const curated = await createStructuredResponse<{
        description: string;
        keyProducts: Array<{
          name: string;
          tagline: string | null;
          imageUrl: string | null;
          pageUrl: string | null;
        }>;
      }>({
        apiKey,
        model: getOpenaiChatModel(),
        instructions: `Sei un investment analyst private equity.
Scrivi il company profile finale per la UI usando solo i dati forniti.
Regole per "description":
- 2 paragrafi, tono sobrio e professionale
- spiega chiaramente cosa vende l'azienda, a chi, come monetizza e quali sono le leve operative
- evita marketing, claim non verificati, frasi vaghe o generiche
- non usare formule meta come "sulla base del sito", "in base al codice ATECO", "dalle fonti disponibili"
- non nominare il codice ATECO nella descrizione finale
- se un'informazione non e' abbastanza solida, omettila invece di riempire con caveat linguistici
- inserisci almeno un riferimento ai numeri piu' recenti e, se disponibile, al trend di ricavi o marginalita'
- non inventare marchi, business line, mercati o vantaggi competitivi

Regole per "keyProducts":
- massimo 4 item
- usa solo prodotti, famiglie prodotto o linee servizio presenti nella lista "officialProductCandidates"
- per "pageUrl" e "imageUrl" usa esattamente gli URL presenti nei candidati; non inventare, non modificare
- se un candidato non ha immagine, lascia "imageUrl" a null
- "tagline" deve essere una label corta, concreta, da 3 a 8 parole`,
        input: [{
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                companyContext: context,
                webResearchNotes: dedupedNotes,
                sources: mergedSources,
                officialWebsite: websiteProfile
                  ? {
                      url: websiteProfile.officialSiteUrl,
                      homepageTitle: websiteProfile.homepageTitle,
                      homepageDescription: websiteProfile.homepageDescription,
                      homepageSummary: websiteProfile.homepageSummary,
                    }
                  : null,
                officialProductCandidates: websiteProfile?.productCandidates || [],
              }, null, 2),
            },
          ],
        }],
        schemaName: "company_web_profile",
        schema: COMPANY_WEB_PROFILE_SCHEMA,
        maxOutputTokens: 1500,
        reasoningEffort: "medium",
      });

      const candidateByPageUrl = new Map(
        (websiteProfile?.productCandidates || [])
          .filter((item) => typeof item?.pageUrl === "string" && item.pageUrl.trim())
          .map((item) => [item.pageUrl as string, item]),
      );

      const candidateByName = new Map(
        (websiteProfile?.productCandidates || [])
          .filter((item) => typeof item?.name === "string" && item.name.trim())
          .map((item) => [normalizeCompanySearchText(item.name), item]),
      );

      const description = typeof curated?.description === "string" ? curated.description.trim() : "";
      const keyProducts = Array.isArray(curated?.keyProducts)
        ? curated.keyProducts
            .filter((item) => typeof item?.name === "string" && item.name.trim())
            .slice(0, 4)
            .map((item) => {
              const matchedByUrl = typeof item?.pageUrl === "string" && item.pageUrl.trim()
                ? candidateByPageUrl.get(item.pageUrl.trim())
                : null;
              const matchedByName = candidateByName.get(normalizeCompanySearchText(item.name));
              const matched = matchedByUrl || matchedByName || null;

              return {
                name: matched?.name || item.name.trim(),
                tagline: typeof item?.tagline === "string" && item.tagline.trim()
                  ? item.tagline.trim()
                  : matched?.tagline || null,
                imageUrl: matched?.imageUrl || null,
                pageUrl: matched?.pageUrl || (typeof item?.pageUrl === "string" && item.pageUrl.trim() ? item.pageUrl.trim() : null),
              };
            })
        : [];

      const fallbackKeyProducts = keyProducts.length > 0
        ? keyProducts
        : (websiteProfile?.productCandidates || []).slice(0, 4);

      return {
        description: description || fallback,
        sources: mergedSources.slice(0, 8),
        keyProducts: fallbackKeyProducts,
        version: COMPANY_DESCRIPTION_WEB_VERSION,
      };
    } catch (error: any) {
      console.warn("Company description structured-writer fallback:", error?.message || error);
      const fallbackKeyProducts = (websiteProfile?.productCandidates || []).slice(0, 4);
      const websiteBackedDescription = buildWebsiteBackedCompanyDescription(
        companyDetails,
        financialData,
        websiteProfile,
        dedupedNotes,
      );

      return {
        description: websiteBackedDescription || fallback,
        sources: mergedSources.slice(0, 8),
        keyProducts: fallbackKeyProducts,
        version: COMPANY_DESCRIPTION_WEB_VERSION,
      };
    }
  } catch (error: any) {
    console.warn("Company description AI error:", error?.message || error);
    return { description: fallback, sources: [], keyProducts: [], version: COMPANY_DESCRIPTION_WEB_VERSION };
  }
}

function hasUsableBilancioOtticoBusinessCache(cached: any): boolean {
  if (!cached || typeof cached !== "object") return false;
  if (cached?.financialData?.source !== BILANCIO_OTTICO_COMPARATIVE_SOURCE) return false;

  const bilanci = cached?.financialData?.bilanci;
  if (!bilanci || typeof bilanci !== "object") return false;

  const coveredYears = cached?.financialData?.coveredYears;
  if (!Array.isArray(coveredYears) || coveredYears.length === 0) return false;

  return coveredYears.every((year: unknown) => typeof year === "string" && year in bilanci);
}

async function findReusableBusinessSnapshot(companyId: string, taxCodes: string[]): Promise<any | null> {
  try {
    const analyses = await storage.listAnalyses();
    const normalizedTaxCodes = taxCodes.filter(Boolean);

    const match = [...analyses]
      .reverse()
      .find((analysis: any) => {
        if (analysis?.mode !== "business") return false;
        const matchesCompanyId =
          typeof analysis?.companyId === "string" &&
          analysis.companyId.trim() &&
          analysis.companyId === companyId;
        const matchesTaxCode =
          typeof analysis?.taxCode === "string" &&
          normalizedTaxCodes.includes(analysis.taxCode);
        if (!matchesCompanyId && !matchesTaxCode) return false;

        return hasUsableBilancioOtticoBusinessCache({
          companyDetails: analysis?.companyDetails,
          financialData: analysis?.financialData,
        });
      });

    if (!match) return null;

    return {
      companyDetails: match.companyDetails || {},
      financialData: match.financialData || {},
    };
  } catch (error: any) {
    console.warn("Could not load reusable business snapshot:", error?.message || error);
    return null;
  }
}

function selectDocuEngineTargetYears(
  preferredYears: string[],
  results: any[],
  maxYears = 2,
): string[] {
  const availableYears = Array.from(
    new Set(
      (Array.isArray(results) ? results : [])
        .map((result) => extractYear(result?.data?.balanceSheetDate) ?? extractYear(result?.data?.year))
        .filter((year): year is string => Boolean(year)),
    ),
  ).sort((a, b) => b.localeCompare(a));

  const selected: string[] = [];
  const pushYear = (year: string) => {
    if (!year || selected.includes(year)) return;
    if (!availableYears.includes(year)) return;
    selected.push(year);
  };

  for (const year of preferredYears) {
    pushYear(year);
    if (selected.length >= maxYears) {
      return selected;
    }
  }

  for (const year of availableYears) {
    pushYear(year);
    if (selected.length >= maxYears) {
      return selected;
    }
  }

  return selected;
}

async function createDocuEngineSearchRequest(
  taxCode: string,
  documentId: string = DOCUENGINE_DOCUMENT_IDS.BILANCIO_RICLASSIFICATO,
) {
  const searchRes = await fetch(`${getDocuEngineBase()}/requests`, {
    method: "POST",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      documentId,
      search: { field0: taxCode },
    }),
  });

  if (!searchRes.ok) {
    const errText = await searchRes.text();
    throw new Error(`DocuEngine search error ${searchRes.status}: ${errText.slice(0, 300)}`);
  }

  const rawData = await readJsonResponse<any>(searchRes, {}, `DocuEngine search ${taxCode}`);
  const payload = getResponseDataPayload(rawData);
  return {
    requestId: typeof payload?.id === "string" ? payload.id : "",
    state: payload?.state,
    results: Array.isArray(payload?.results) ? payload.results : [],
  };
}

async function waitForDocuEngineDone(requestId: string): Promise<any> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const statusRes = await fetch(`${getDocuEngineBase()}/requests/${requestId}`, {
      headers: getAuthHeaders(),
    });

    if (!statusRes.ok) {
      const errText = await statusRes.text();
      throw new Error(`DocuEngine status error ${statusRes.status}: ${errText.slice(0, 300)}`);
    }

    const statusData = await readJsonResponse<any>(statusRes, {}, `DocuEngine status ${requestId}`);
    const payload = getResponseDataPayload(statusData);
    const state = String(payload?.state || "").toUpperCase();

    if (state === "DONE" || state === "EVASO") {
      return payload;
    }

    if (state === "ERROR") {
      throw new Error(`DocuEngine request ${requestId} ended in ERROR`);
    }
  }
}

async function downloadAndStoreBilancioDocuments(companyId: string, year: string, documents: any[]) {
  const storedDocuments: any[] = [];
  let bilancioData: any = null;

  for (let index = 0; index < documents.length; index++) {
    const sourceDocument = documents[index];
    if (typeof sourceDocument?.downloadUrl !== "string" || !sourceDocument.downloadUrl) continue;

    const downloadedRes = await fetch(sourceDocument.downloadUrl);
    if (!downloadedRes.ok) {
      const errText = await downloadedRes.text();
      throw new Error(`Bilancio document download error ${downloadedRes.status}: ${errText.slice(0, 300)}`);
    }

    const mimeType = downloadedRes.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
    const buffer = Buffer.from(await downloadedRes.arrayBuffer());
    const storedDocument = await persistBilancioDocument(companyId, year, index, sourceDocument, buffer, mimeType);
    const enrichedDocument = { ...sourceDocument, ...storedDocument };
    storedDocuments.push(enrichedDocument);

    if (!bilancioData) {
      bilancioData = extractStructuredBilancioData(
        buffer,
        storedDocument.mimeType,
        storedDocument.originalName || storedDocument.filename,
        year,
      );
    }
  }

  return { storedDocuments, bilancioData };
}

function buildUserUploadedBilanciPackage(uploadedDocuments: UserUploadedBilancio[]): Record<string, any> {
  const sorted = [...uploadedDocuments].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  return sorted.reduce((acc, document) => {
    const year = extractYear(document.year) || document.year;
    if (!year) return acc;

    const current = acc[year] || {
      year,
      fetchedAt: document.createdAt,
      documents: [],
      bilancioData: {
        source: "user_upload",
        purchaseYear: year,
        documentType: "user-upload",
        structuredData: null,
        coveredYears: [],
        parsedFrom: null,
      },
    };

    current.documents.push({
      id: document.id,
      filename: document.originalName || document.storagePath.split("/").pop() || `bilancio-${year}`,
      originalName: document.originalName,
      mimeType: document.mimeType,
      storageKey: document.storagePath,
      storageBackend: document.storageBackend,
      bucket: document.bucket,
      source: "user_upload",
      privateDocumentId: document.id,
    });

    const extractedData = document.extractedData;
    const extractedStructuredData =
      extractedData && typeof extractedData === "object"
        ? extractedData
        : null;

    if (!current.bilancioData.structuredData && extractedStructuredData) {
      current.bilancioData = {
        source: "user_upload",
        purchaseYear: year,
        documentType: "user-upload",
        structuredData: extractedStructuredData,
        coveredYears: Array.isArray((extractedStructuredData as any)?.coveredYears)
          ? (extractedStructuredData as any).coveredYears
          : [],
        parsedFrom: typeof (extractedStructuredData as any)?.parsedFrom === "string"
          ? (extractedStructuredData as any).parsedFrom
          : document.originalName || null,
      };
    }

    acc[year] = current;
    return acc;
  }, {} as Record<string, any>);
}

async function readMultipartFormData(req: Request): Promise<FormData> {
  const webRequest = new Request("http://localhost/internal-upload", {
    method: req.method,
    headers: req.headers as any,
    body: req as any,
    duplex: "half" as any,
  } as any);
  return webRequest.formData();
}

function dedupeInsightSources(sources: Array<{ title?: string; url?: string }> | undefined) {
  const deduped = new Map<string, { title: string; url: string }>();
  for (const source of sources || []) {
    const url = typeof source?.url === "string" ? source.url.trim() : "";
    const title = typeof source?.title === "string" ? source.title.trim() : "";
    if (!url) continue;
    deduped.set(url, { title: title || url, url });
  }
  return Array.from(deduped.values());
}

function getLatestFinancialSnapshot(financialData: any) {
  const bilanci = financialData?.bilanci && typeof financialData.bilanci === "object" ? financialData.bilanci : {};
  const years = Object.keys(bilanci)
    .filter((year) => bilanci?.[year]?.status !== "missing")
    .sort((a, b) => b.localeCompare(a));
  const latestYear = years[0] || null;
  const latest = latestYear ? bilanci[latestYear] : null;

  return {
    latestYear,
    latest,
    years,
    metrics: {
      revenueGrowth: years.length >= 2
        ? calculatePercentage(
            (bilanci[years[0]]?.fatturato ?? 0) - (bilanci[years[1]]?.fatturato ?? 0),
            bilanci[years[1]]?.fatturato,
          )
        : null,
      ebitdaMargin: latest ? calculatePercentage(latest.ebitda, latest.fatturato) : null,
      netMargin: latest ? calculatePercentage(latest.utile_netto, latest.fatturato) : null,
      cashConversion: latest?.cash_conversion ?? null,
      nwcPctRevenue: latest?.nwc_pct_revenue ?? null,
      netDebtEbitda: latest?.net_debt_ebitda ?? null,
      debtEquity: latest?.debt_equity ?? null,
    },
  };
}

function buildFallbackInsights(financialData: any) {
  const snapshot = getLatestFinancialSnapshot(financialData);
  const latest = snapshot.latest;
  const latestYear = snapshot.latestYear || "ultimo anno disponibile";
  const bullets: string[] = [];
  const recommendations: Array<{
    theme: "margini_pricing" | "capitale_circolante" | "debito_struttura" | "allocazione_capitale" | "crescita_posizionamento";
    title: string;
    description: string;
    rationale: string;
    evidence: string;
    priority: "high" | "medium" | "low";
  }> = [];

  if (isFiniteNumber(latest?.nwc_pct_revenue)) {
    bullets.push(
      latest.nwc_pct_revenue > 20
        ? "Il capitale circolante assorbe una quota elevata dei ricavi e comprime la generazione di cassa."
        : "Il capitale circolante appare relativamente disciplinato rispetto ai ricavi.",
    );
  }
  if (isFiniteNumber(latest?.dso) || isFiniteNumber(latest?.dpo) || isFiniteNumber(latest?.dio)) {
    bullets.push(
      `La dinamica dei giorni di incasso, magazzino e pagamento richiede disciplina operativa per evitare ulteriore assorbimento di cassa.`,
    );
  }
  if (isFiniteNumber(latest?.net_debt_ebitda)) {
    bullets.push(
      latest.net_debt_ebitda > 3
        ? "La leva finanziaria e' tesa rispetto alla capacita' di generare EBITDA e riduce margine di manovra."
        : "La leva finanziaria appare gestibile rispetto all'EBITDA disponibile.",
    );
  }
  if (isFiniteNumber(snapshot.metrics.cashConversion)) {
    bullets.push(
      snapshot.metrics.cashConversion < 50
        ? "La conversione dell'EBITDA in cassa e' debole."
        : "La conversione dell'EBITDA in cassa e' soddisfacente.",
    );
  }

  if (isFiniteNumber(snapshot.metrics.ebitdaMargin) && snapshot.metrics.ebitdaMargin < 10) {
    recommendations.push({
      theme: "margini_pricing",
      title: "Recuperare disciplina sul margine lordo-operativo",
      description: "Rivedi pricing, mix prodotto e costi di struttura per rialzare il margine operativo prima di inseguire ulteriore crescita commerciale.",
      rationale: "Con un margine operativo compresso, ogni euro di ricavo aggiuntivo rischia di generare poco valore e poca capacita' di autofinanziamento.",
      evidence: `EBITDA margin ${latestYear}: ${isFiniteNumber(snapshot.metrics.ebitdaMargin) ? snapshot.metrics.ebitdaMargin.toFixed(1) : "N/D"}%.`,
      priority: "high",
    });
  }
  if (isFiniteNumber(latest?.nwc_pct_revenue) && latest.nwc_pct_revenue > 20) {
    recommendations.push({
      theme: "capitale_circolante",
      title: "Ridurre l'assorbimento di capitale circolante",
      description: "Imposta un piano operativo su incassi, scorte e termini fornitori con target puntuali di rilascio cassa nei prossimi 90-120 giorni.",
      rationale: "Il capitale circolante sta assorbendo troppa cassa rispetto ai ricavi e limita la flessibilita' finanziaria dell'azienda.",
      evidence: `Capitale circolante / ricavi ${latestYear}: ${isFiniteNumber(latest.nwc_pct_revenue) ? latest.nwc_pct_revenue.toFixed(1) : "N/D"}%.`,
      priority: "high",
    });
  }
  if (isFiniteNumber(latest?.net_debt_ebitda) && latest.net_debt_ebitda > 3) {
    recommendations.push({
      theme: "debito_struttura",
      title: "Rimettere sotto controllo la leva",
      description: "Rivedi profilo di rimborso, costo e struttura del debito prima di finanziare nuova crescita o nuovi investimenti.",
      rationale: "Con leva elevata, la capacita' di assorbire volatilita' operativa si restringe e aumenta la sensibilita' verso banche e covenant impliciti.",
      evidence: `Debito netto / EBITDA ${latestYear}: ${isFiniteNumber(latest.net_debt_ebitda) ? latest.net_debt_ebitda.toFixed(1) : "N/D"}x.`,
      priority: "medium",
    });
  }
  if (isFiniteNumber(snapshot.metrics.cashConversion) && snapshot.metrics.cashConversion < 60) {
    recommendations.push({
      theme: "allocazione_capitale",
      title: "Riallineare EBITDA e generazione di cassa",
      description: "Blocca capex non prioritario e imposta una soglia minima di ritorno di cassa per ogni iniziativa operativa o commerciale.",
      rationale: "Se l'EBITDA non si trasforma in cassa, l'azienda cresce sulla carta ma non aumenta il proprio margine di manovra reale.",
      evidence: `Cash conversion ${latestYear}: ${isFiniteNumber(snapshot.metrics.cashConversion) ? snapshot.metrics.cashConversion.toFixed(1) : "N/D"}%.`,
      priority: "high",
    });
  }
  if (isFiniteNumber(snapshot.metrics.revenueGrowth) || isFiniteNumber(snapshot.metrics.ebitdaMargin)) {
    recommendations.push({
      theme: "crescita_posizionamento",
      title: "Separare crescita da crescita redditizia",
      description: "Valuta linee prodotto, clienti e canali che assorbono capitale o comprimono il margine, e rialloca le risorse verso la parte del business che genera ritorni migliori.",
      rationale: "La crescita crea valore solo se conserva marginalita' e non peggiora il profilo di cassa o di rischio finanziario.",
      evidence: `Crescita ricavi ${latestYear}: ${isFiniteNumber(snapshot.metrics.revenueGrowth) ? snapshot.metrics.revenueGrowth.toFixed(1) : "N/D"}%; EBITDA margin ${latestYear}: ${isFiniteNumber(snapshot.metrics.ebitdaMargin) ? snapshot.metrics.ebitdaMargin.toFixed(1) : "N/D"}%.`,
      priority: "medium",
    });
  }
  if (recommendations.length === 0) {
    recommendations.push({
      theme: "margini_pricing",
      title: "Proteggere qualita' della crescita",
      description: "Proteggi margini e conversione in cassa prima di accelerare su nuova crescita, evitando espansione che consumi capitale invece di generarlo.",
      rationale: "Anche in assenza di segnali di stress evidenti, il valore si difende mantenendo allineati crescita, redditivita' e cassa.",
      evidence: `Cash conversion ${latestYear}: ${isFiniteNumber(snapshot.metrics.cashConversion) ? snapshot.metrics.cashConversion.toFixed(1) : "N/D"}%; EBITDA margin ${latestYear}: ${isFiniteNumber(snapshot.metrics.ebitdaMargin) ? snapshot.metrics.ebitdaMargin.toFixed(1) : "N/D"}%.`,
      priority: "medium",
    });
  }

  const requiredThemes: Array<"margini_pricing" | "capitale_circolante" | "debito_struttura" | "allocazione_capitale" | "crescita_posizionamento"> = [
    "margini_pricing",
    "capitale_circolante",
    "debito_struttura",
    "allocazione_capitale",
    "crescita_posizionamento",
  ];

  for (const theme of requiredThemes) {
    if (recommendations.some((item) => item.theme === theme)) continue;
    if (theme === "margini_pricing") {
      recommendations.push({
        theme,
        title: "Difendere prezzo e mix",
        description: "Rivedi i segmenti a bassa resa economica e proteggi il margine con una disciplina piu' selettiva su listini, sconti e mix clienti.",
        rationale: "Il pricing e il mix sono la leva piu' rapida per evitare che la crescita dei volumi eroda il ritorno operativo.",
        evidence: `EBITDA margin ${latestYear}: ${isFiniteNumber(snapshot.metrics.ebitdaMargin) ? snapshot.metrics.ebitdaMargin.toFixed(1) : "N/D"}%.`,
        priority: "medium",
      });
    }
    if (theme === "capitale_circolante") {
      recommendations.push({
        theme,
        title: "Mettere a target il rilascio di cassa operativo",
        description: "Traduci crediti, scorte e pagamenti in target settimanali e responsabilita' operative, invece di gestire il circolante solo a consuntivo.",
        rationale: "Il circolante non si corregge a fine anno: serve una disciplina commerciale e operativa continua.",
        evidence: `DSO ${latestYear}: ${isFiniteNumber(latest?.dso) ? latest.dso.toFixed(0) : "N/D"} gg; DIO ${latestYear}: ${isFiniteNumber(latest?.dio) ? latest.dio.toFixed(0) : "N/D"} gg; DPO ${latestYear}: ${isFiniteNumber(latest?.dpo) ? latest.dpo.toFixed(0) : "N/D"} gg.`,
        priority: "medium",
      });
    }
    if (theme === "debito_struttura") {
      recommendations.push({
        theme,
        title: "Preservare headroom finanziaria",
        description: "Mantieni margine di manovra su linee e covenant impliciti prima di assumere nuovo fabbisogno da crescita o investimenti.",
        rationale: "La resilienza finanziaria si costruisce prima dello stress, non dopo.",
        evidence: `Debito netto / EBITDA ${latestYear}: ${isFiniteNumber(latest?.net_debt_ebitda) ? latest.net_debt_ebitda.toFixed(1) : "N/D"}x; Debt / Equity ${latestYear}: ${isFiniteNumber(latest?.debt_equity) ? latest.debt_equity.toFixed(1) : "N/D"}x.`,
        priority: "medium",
      });
    }
    if (theme === "allocazione_capitale") {
      recommendations.push({
        theme,
        title: "Stringere le priorita' di investimento",
        description: "Rendi il capex piu' selettivo e subordinato a ritorni rapidi in cassa, soprattutto finche' il business non converte stabilmente EBITDA in UFCF.",
        rationale: "L'allocazione del capitale e' la leva che piu' rapidamente cambia la qualita' del rendimento per soci e finanziatori.",
        evidence: `UFCF ${latestYear}: ${isFiniteNumber(latest?.unlevered_free_cash_flow) ? (latest.unlevered_free_cash_flow / 1_000_000).toFixed(1) : "N/D"}m; Cash conversion ${latestYear}: ${isFiniteNumber(snapshot.metrics.cashConversion) ? snapshot.metrics.cashConversion.toFixed(1) : "N/D"}%.`,
        priority: "medium",
      });
    }
    if (theme === "crescita_posizionamento") {
      recommendations.push({
        theme,
        title: "Concentrare la crescita dove il ritorno e' difendibile",
        description: "Confronta i segmenti che crescono con quelli che mantengono margini e cassa, e sposta risorse verso le aree con economics piu' robusti.",
        rationale: "La qualita' del posizionamento si misura nella capacita' di crescere senza distruggere cassa o rendimento operativo.",
        evidence: `Ricavi ${latestYear}: ${isFiniteNumber(latest?.fatturato) ? (latest.fatturato / 1_000_000).toFixed(1) : "N/D"}m; EBITDA margin ${latestYear}: ${isFiniteNumber(snapshot.metrics.ebitdaMargin) ? snapshot.metrics.ebitdaMargin.toFixed(1) : "N/D"}%.`,
        priority: "low",
      });
    }
  }

  return {
    marketBenchmarks: {
      metrics: [] as any[],
      sources: [] as Array<{ title: string; url: string }>,
    },
    workingCapitalDebt: {
      summary: bullets[0] || "La lettura di capitale circolante e debito resta limitata ai dati effettivamente disponibili.",
      bullets: bullets.length > 0 ? bullets : ["Servono piu' dettagli di bilancio per una lettura completa di circolante e debito."],
    },
    recommendations: recommendations.slice(0, 5),
  };
}

function buildRecommendationContext(companyDetails: any, financialData: any, marketBenchmarks: any, description: string) {
  const snapshot = getLatestFinancialSnapshot(financialData);
  const bilanci = financialData?.bilanci && typeof financialData.bilanci === "object" ? financialData.bilanci : {};
  const latestYear = snapshot.latestYear;
  const previousYear = snapshot.years[1] || null;
  const latest = latestYear ? bilanci?.[latestYear] : null;
  const previous = previousYear ? bilanci?.[previousYear] : null;

  return {
    companyName: companyDetails?.denominazione || null,
    location: [companyDetails?.comune, companyDetails?.provincia].filter(Boolean).join(", ") || null,
    businessDescription: description || null,
    latestYear,
    previousYear,
    latestMetrics: latest
      ? {
          revenue: latest?.fatturato ?? null,
          ebitda: latest?.ebitda ?? null,
          ebitdaMargin: snapshot.metrics.ebitdaMargin,
          netIncome: latest?.utile_netto ?? null,
          netMargin: snapshot.metrics.netMargin,
          cashConversion: snapshot.metrics.cashConversion,
          nwc: latest?.nwc ?? null,
          nwcPctRevenue: latest?.nwc_pct_revenue ?? null,
          dso: latest?.dso ?? null,
          dio: latest?.dio ?? null,
          dpo: latest?.dpo ?? null,
          netDebt: latest?.net_debt ?? null,
          netDebtEbitda: latest?.net_debt_ebitda ?? null,
          debtEquity: latest?.debt_equity ?? null,
        }
      : null,
    deltaVsPreviousYear: previous && latest
      ? {
          revenueGrowthPct: calculatePercentage((latest?.fatturato ?? 0) - (previous?.fatturato ?? 0), previous?.fatturato),
          ebitdaMarginChangePts:
            isFiniteNumber(snapshot.metrics.ebitdaMargin) && isFiniteNumber(calculatePercentage(previous?.ebitda, previous?.fatturato))
              ? Number((snapshot.metrics.ebitdaMargin - calculatePercentage(previous?.ebitda, previous?.fatturato)!).toFixed(1))
              : null,
          cashConversionChangePts:
            isFiniteNumber(latest?.cash_conversion) && isFiniteNumber(previous?.cash_conversion)
              ? Number((latest.cash_conversion - previous.cash_conversion).toFixed(1))
              : null,
          nwcPctRevenueChangePts:
            isFiniteNumber(latest?.nwc_pct_revenue) && isFiniteNumber(previous?.nwc_pct_revenue)
              ? Number((latest.nwc_pct_revenue - previous.nwc_pct_revenue).toFixed(1))
              : null,
          netDebtEbitdaChange:
            isFiniteNumber(latest?.net_debt_ebitda) && isFiniteNumber(previous?.net_debt_ebitda)
              ? Number((latest.net_debt_ebitda - previous.net_debt_ebitda).toFixed(1))
              : null,
        }
      : null,
    history: snapshot.years.slice().reverse().map((year) => ({
      year,
      revenue: bilanci?.[year]?.fatturato ?? null,
      ebitda: bilanci?.[year]?.ebitda ?? null,
      ebitdaMargin: calculatePercentage(bilanci?.[year]?.ebitda, bilanci?.[year]?.fatturato),
      netIncome: bilanci?.[year]?.utile_netto ?? null,
      netMargin: calculatePercentage(bilanci?.[year]?.utile_netto, bilanci?.[year]?.fatturato),
      cashConversion: bilanci?.[year]?.cash_conversion ?? null,
      nwcPctRevenue: bilanci?.[year]?.nwc_pct_revenue ?? null,
      dso: bilanci?.[year]?.dso ?? null,
      dio: bilanci?.[year]?.dio ?? null,
      dpo: bilanci?.[year]?.dpo ?? null,
      netDebtEbitda: bilanci?.[year]?.net_debt_ebitda ?? null,
    })),
    marketBenchmarks: Array.isArray(marketBenchmarks?.metrics)
      ? marketBenchmarks.metrics.map((item: any) => ({
          metric: item?.metric ?? null,
          companyValue: item?.companyValue ?? null,
          marketRangeLow: item?.marketRangeLow ?? null,
          marketRangeHigh: item?.marketRangeHigh ?? null,
          status: item?.status ?? null,
          comment: item?.comment ?? null,
          confidence: item?.confidence ?? null,
        }))
      : [],
    recommendationTracks: [
      "margini_pricing",
      "capitale_circolante",
      "debito_struttura",
      "allocazione_capitale",
      "crescita_posizionamento",
    ],
  };
}

function mergeRecommendations(primary: any, fallback: any) {
  const merged: any[] = [];
  const seen = new Set<string>();

  for (const source of [Array.isArray(primary) ? primary : [], Array.isArray(fallback) ? fallback : []]) {
    for (const item of source) {
      if (!item || typeof item !== "object") continue;
      const title = typeof item.title === "string" ? item.title.trim() : "";
      const theme = typeof item.theme === "string" ? item.theme.trim() : "";
      const description = typeof item.description === "string" ? item.description.trim() : "";
      const rationale = typeof item.rationale === "string" ? item.rationale.trim() : "";
      const evidence = typeof item.evidence === "string" ? item.evidence.trim() : "";
      const priority =
        item.priority === "high" || item.priority === "medium" || item.priority === "low"
          ? item.priority
          : "medium";
      const key = `${theme}::${title}`.toLowerCase();
      if (!title || !description || seen.has(key)) continue;
      seen.add(key);
      merged.push({
        theme: theme || "crescita_posizionamento",
        title,
        description,
        rationale,
        evidence,
        priority,
      });
      if (merged.length >= 5) return merged;
    }
  }

  return merged;
}

async function generateRecommendationMemo(companyDetails: any, financialData: any, marketBenchmarks: any, description: string) {
  const apiKey = getOpenaiApiKey();
  if (!apiKey) return null;

  const context = buildRecommendationContext(companyDetails, financialData, marketBenchmarks, description);
  if (!context.latestYear) return null;

  try {
    const { text } = await createTextResponse({
      apiKey,
      model: getOpenaiChatModel(),
      instructions: `Sei un partner di strategic advisory e debt advisory mid-market.
Scrivi un memo interno, non marketing, come se stessi preparando il punto di vista finale per CEO, socio industriale o comitato crediti.
Obiettivo:
- isolare i 2-4 veri problemi economico-finanziari o punti di forza che contano
- spiegare perche' contano in termini di valore, bancabilita', cassa e opzioni strategiche
- trasformarli in azioni manageriali concrete
Regole:
- usa numeri e anni specifici quando disponibili
- non fare riassunti scolastici del bilancio
- non usare banalita' tipo "monitorare", "ottimizzare", "migliorare l'efficienza" senza dire come e perche'
- niente frasi meta sulle fonti
- se l'azienda e' forte, spiega come proteggere quel vantaggio
- tono secco, da advisor senior; niente marketing`,
      input: [{
        role: "user",
        content: [{
          type: "input_text",
          text: JSON.stringify(context, null, 2),
        }],
      }],
      maxOutputTokens: 2800,
      reasoningEffort: "high",
    });

    return text.trim() || null;
  } catch (error: any) {
    console.warn("Recommendation memo generation fallback:", error?.message || error);
    return null;
  }
}

async function generateMarketBenchmarks(companyDetails: any, financialData: any, description: string) {
  const apiKey = getOpenaiApiKey();
  const snapshot = getLatestFinancialSnapshot(financialData);
  const fallback = buildFallbackInsights(financialData).marketBenchmarks;

  if (!apiKey || !snapshot.latestYear) {
    return fallback;
  }

  try {
    const metrics = [
      { metric: "EBITDA margin", companyValue: snapshot.metrics.ebitdaMargin, unit: "percent" },
      { metric: "Net margin", companyValue: snapshot.metrics.netMargin, unit: "percent" },
      { metric: "Revenue growth", companyValue: snapshot.metrics.revenueGrowth, unit: "percent" },
      { metric: "Cash conversion", companyValue: snapshot.metrics.cashConversion, unit: "percent" },
    ];

    const result = await createStructuredResponse<{
      metrics: Array<{
        metric: string;
        companyValue: number | null;
        marketRangeLow: number | null;
        marketRangeHigh: number | null;
        status: "below" | "in_line" | "above" | "insufficient_data";
        comment: string;
        confidence: "high" | "medium" | "low";
        sources: Array<{ title: string; url: string }>;
      }>;
    }>({
      apiKey,
      model: getOpenaiChatModel(),
      instructions: `Sei un equity research analyst focalizzato sul mercato italiano.
Devi produrre benchmark di mercato come range di riferimento per un'azienda italiana.
Regole:
- usa il web search per trovare range tipici di mercato o operatori comparabili
- ragiona sul sotto-settore implicito dal business model, non nominare codici ATECO
- niente frasi meta come "in base al sito", "in base al codice ATECO", "presumibilmente" o "verosimilmente"
- se un range non e' abbastanza robusto, usa null e status "insufficient_data"
- mantieni commenti brevi, concreti e leggibili da imprenditore`,
      input: [{
        role: "user",
        content: [{
          type: "input_text",
          text: JSON.stringify({
            companyName: companyDetails?.denominazione || null,
            location: [companyDetails?.comune, companyDetails?.provincia].filter(Boolean).join(", ") || null,
            businessDescription: description || null,
            latestYear: snapshot.latestYear,
            latestMetrics: metrics,
            financialHistory: snapshot.years.map((year) => ({
              year,
              revenue: financialData?.bilanci?.[year]?.fatturato ?? null,
              ebitda: financialData?.bilanci?.[year]?.ebitda ?? null,
              ebitdaMargin: calculatePercentage(financialData?.bilanci?.[year]?.ebitda, financialData?.bilanci?.[year]?.fatturato),
            })),
          }, null, 2),
        }],
      }],
      tools: [{
        type: "web_search",
        user_location: {
          type: "approximate",
          country: "IT",
          city: typeof companyDetails?.comune === "string" ? companyDetails.comune : undefined,
          region: typeof companyDetails?.provincia === "string" ? companyDetails.provincia : undefined,
        },
      }],
      toolChoice: "auto",
      schemaName: "market_benchmarks",
      schema: MARKET_BENCHMARK_SCHEMA,
      maxOutputTokens: 3000,
      reasoningEffort: "medium",
    });

    const companyMetricMap = new Map(metrics.map((item) => [item.metric.toLowerCase(), item.companyValue]));
    return {
      metrics: Array.isArray(result?.metrics)
        ? result.metrics.slice(0, 4).map((item) => ({
            ...item,
            companyValue: companyMetricMap.get(String(item.metric || "").toLowerCase()) ?? item.companyValue ?? null,
          }))
        : [],
      sources: dedupeInsightSources((result?.metrics || []).flatMap((item) => item.sources || [])),
    };
  } catch (error: any) {
    console.warn("Market benchmark generation fallback:", error?.message || error);
    return fallback;
  }
}

async function generateWorkingCapitalDebtAndRecommendations(companyDetails: any, financialData: any, marketBenchmarks: any, description: string) {
  const apiKey = getOpenaiApiKey();
  const fallback = buildFallbackInsights(financialData);

  if (!apiKey) {
    return {
      workingCapitalDebt: fallback.workingCapitalDebt,
      recommendations: fallback.recommendations,
    };
  }

  try {
    const context = buildRecommendationContext(companyDetails, financialData, marketBenchmarks, description);
    const strategyMemo = await generateRecommendationMemo(companyDetails, financialData, marketBenchmarks, description);
    const result = await createStructuredResponse<{
      workingCapitalDebt: {
        summary: string;
        bullets: string[];
      };
      recommendations: Array<{
        title: string;
        description: string;
        rationale: string;
        evidence: string;
        priority: "high" | "medium" | "low";
      }>;
    }>({
      apiKey,
      model: getOpenaiChatModel(),
      instructions: `Sei un consulente strategico-finanziario senior che scrive l'ultima pagina di un investment memo / credit memo per una PMI italiana.
Hai gia' a disposizione un memo interno di lavoro e un set di numeri strutturati. Il tuo compito non e' commentare genericamente i dati, ma trasformarli in una diagnosi manageriale e in raccomandazioni vere.
Restituisci:
- una diagnosi sintetica di working capital e debito
- 4-5 raccomandazioni prioritarie
Regole:
- scrivi come un advisor serio, non come un assistente generalista
- ogni raccomandazione deve avere un focus diverso e non ripetere la stessa idea con parole diverse
- devi coprire il piu' possibile le cinque piste seguenti, se i dati lo consentono: margini/pricing, capitale circolante, debito/struttura finanziaria, allocazione del capitale, crescita/posizionamento
- non e' accettabile restituire una sola raccomandazione o raccomandazioni quasi duplicate
- parti dal problema economico-finanziario, spiega perche' conta e prescrivi un'azione concreta nei prossimi 90-180 giorni
- usa numeri e anni specifici come evidenza quando disponibili
- se i benchmark esistono, spiega esplicitamente dove l'azienda e' sopra o sotto il mercato
- privilegia pricing, mix, struttura costi, rilascio cassa, disciplina commerciale, scorte, struttura del debito, covenant capacity, priorita' di capex
- evita assolutamente formule vuote come "monitorare", "migliorare l'efficienza", "tenere sotto controllo" se non sono accompagnate da una leva precisa
- niente meta-commenti sulle fonti o sulla qualita' del modello
- niente informazioni non supportate dai dati
- se i dati sono incompleti, resta prudente ma produci comunque indicazioni utili e concrete
- nella descrizione:
  - description = cosa fare
  - rationale = perche' conta economicamente
  - evidence = numero/anno/gap che giustifica l'azione`,
      input: [{
        role: "user",
        content: [{
          type: "input_text",
          text: JSON.stringify({
            advisorMemo: strategyMemo,
            companyContext: context,
          }, null, 2),
        }],
      }],
      schemaName: "working_capital_recommendations",
      schema: WORKING_CAPITAL_RECOMMENDATIONS_SCHEMA,
      maxOutputTokens: 3600,
      reasoningEffort: "high",
    });

    const recommendations = mergeRecommendations(result?.recommendations, fallback.recommendations);

    return {
      workingCapitalDebt: {
        summary: typeof result?.workingCapitalDebt?.summary === "string"
          ? result.workingCapitalDebt.summary.trim()
          : fallback.workingCapitalDebt.summary,
        bullets: Array.isArray(result?.workingCapitalDebt?.bullets) && result.workingCapitalDebt.bullets.length > 0
          ? result.workingCapitalDebt.bullets.slice(0, 4)
          : fallback.workingCapitalDebt.bullets,
      },
      recommendations,
    };
  } catch (error: any) {
    console.warn("Recommendations generation fallback:", error?.message || error);
    return {
      workingCapitalDebt: fallback.workingCapitalDebt,
      recommendations: fallback.recommendations,
    };
  }
}

export function registerRoutes(server: Server, app: Express): void {

  // ==========================================
  // AUTH — Supabase Auth (email + Google)
  // ==========================================
  app.get("/api/auth/config", (_req: Request, res: Response) => {
    return res.json({
      useSupabaseAuth: isSupabaseAuthConfigured(),
      allowRegistration: true,
      hasGoogle: true,
    });
  });

  app.get("/api/auth/me", async (req: Request, res: Response) => {
    const token = getAccessTokenFromReq(req);
    if (!token) return res.status(401).json({ error: "Non autenticato" });
    const user = await getOrCreateUserFromSupabaseToken(token);
    if (!user) return res.status(401).json({ error: "Token non valido" });
    return res.json({ user });
  });

  app.get("/api/private-bilanci", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromReq(req);
      if (!userId) return res.status(401).json({ error: "Non autenticato" });

      const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : "";
      if (!companyId) {
        return res.status(400).json({ error: "companyId è richiesto" });
      }

      const documents = await storage.listUserUploadedBilanci(userId, companyId);
      return res.json({ data: documents });
    } catch (error: any) {
      console.error("Private bilanci list error:", error);
      return res.status(500).json({ error: "Errore nel recupero dei bilanci caricati" });
    }
  });

  app.post("/api/private-bilanci/upload", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromReq(req);
      if (!userId) return res.status(401).json({ error: "Non autenticato" });

      const formData = await readMultipartFormData(req);
      const companyId = typeof formData.get("companyId") === "string" ? String(formData.get("companyId")).trim() : "";
      const taxCode = typeof formData.get("taxCode") === "string" ? String(formData.get("taxCode")).trim() : null;
      const year = extractYear(typeof formData.get("year") === "string" ? String(formData.get("year")).trim() : "") || "";
      const file = formData.get("file");

      if (!companyId || !year) {
        return res.status(400).json({ error: "companyId e year sono richiesti" });
      }

      if (!file || typeof (file as any).arrayBuffer !== "function") {
        return res.status(400).json({ error: "File mancante" });
      }

      const originalName =
        typeof (file as any).name === "string" && (file as any).name.trim()
          ? (file as any).name.trim()
          : `bilancio-${year}`;
      const mimeType =
        typeof (file as any).type === "string" && (file as any).type.trim()
          ? (file as any).type.trim()
          : "application/octet-stream";

      const lowerName = originalName.toLowerCase();
      const isAllowedFile =
        mimeType.includes("pdf") ||
        mimeType.includes("json") ||
        mimeType.includes("xml") ||
        mimeType.includes("zip") ||
        lowerName.endsWith(".pdf") ||
        lowerName.endsWith(".json") ||
        lowerName.endsWith(".xml") ||
        lowerName.endsWith(".xbrl") ||
        lowerName.endsWith(".zip");

      if (!isAllowedFile) {
        return res.status(400).json({ error: "Formato file non supportato. Carica PDF, XBRL, XML, JSON o ZIP." });
      }

      const buffer = Buffer.from(await (file as any).arrayBuffer());
      const storedDocument = await persistPrivateBilancioDocument(
        userId,
        companyId,
        year,
        0,
        { name: originalName },
        buffer,
        mimeType,
      );
      const extractedData = extractStructuredBilancioData(
        buffer,
        storedDocument.mimeType,
        storedDocument.originalName || storedDocument.filename,
        year,
      );

      const document = await storage.createUserUploadedBilancio({
        userId,
        companyId,
        taxCode,
        year,
        mimeType: storedDocument.mimeType,
        storagePath: storedDocument.storageKey,
        bucket: storedDocument.bucket ?? null,
        storageBackend: storedDocument.storageBackend || "local",
        originalName: storedDocument.originalName || storedDocument.filename,
        sizeBytes: storedDocument.sizeBytes,
        extractedData: extractedData as Record<string, unknown> | null,
        source: "user_upload",
        createdAt: new Date().toISOString(),
      });

      return res.json({ data: document });
    } catch (error: any) {
      console.error("Private bilancio upload error:", error);
      return res.status(500).json({ error: "Errore nel caricamento del bilancio" });
    }
  });

  app.get("/api/private-bilanci/:id/file", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromReq(req, true);
      if (!userId) return res.status(401).json({ error: "Non autenticato" });

      const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const id = Number.parseInt(idParam || "", 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "ID documento non valido" });
      }

      const document = await storage.getUserUploadedBilancio(userId, id);
      if (!document) {
        return res.status(404).json({ error: "Documento non trovato" });
      }

      const buffer = await readStoredBilancioDocument({
        storageKey: document.storagePath,
        storageBackend: document.storageBackend,
        bucket: document.bucket,
      });

      const filename = document.originalName || `bilancio-${document.year}`;
      res.setHeader("Content-Type", document.mimeType || "application/octet-stream");
      res.setHeader("Content-Disposition", `${isStoredInlineBilancioDocument({ mimeType: document.mimeType, originalName: filename }) ? "inline" : "attachment"}; filename="${filename.replace(/"/g, "")}"`);
      return res.send(buffer);
    } catch (error: any) {
      console.error("Private bilancio file error:", error);
      return res.status(500).json({ error: "Errore nel recupero del documento" });
    }
  });

  app.delete("/api/private-bilanci/:id", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromReq(req);
      if (!userId) return res.status(401).json({ error: "Non autenticato" });

      const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const id = Number.parseInt(idParam || "", 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "ID documento non valido" });
      }

      const existing = await storage.getUserUploadedBilancio(userId, id);
      if (!existing) {
        return res.status(404).json({ error: "Documento non trovato" });
      }

      await deleteStoredBilancioDocument({
        storageKey: existing.storagePath,
        storageBackend: existing.storageBackend,
        bucket: existing.bucket,
      });
      await storage.deleteUserUploadedBilancio(userId, id);
      return res.json({ ok: true });
    } catch (error: any) {
      console.error("Private bilancio delete error:", error);
      return res.status(500).json({ error: "Errore nella cancellazione del documento" });
    }
  });

  app.get("/api/billing/me", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromReq(req);
      if (!userId) return res.status(401).json({ error: "Non autenticato" });

      const summary = await getWalletSummary(userId);
      const billingEnabled = isCreditBillingEnabled();
      const tier = await getUserTier(userId);
      const subscription = await getActiveSubscription(userId);
      return res.json({
        data: {
          ...summary,
          billingEnabled,
          businessAnalysisCents: billingEnabled ? getBusinessAnalysisPriceCents() : 0,
          subscriberExtraAnalysisCents: billingEnabled ? getSubscriberExtraAnalysisPriceCents() : 0,
          tier,
          subscription: subscription
            ? {
                tier: subscription.tier,
                status: subscription.status,
                analysesUsed: subscription.analysesUsed,
                analysesLimit: subscription.analysesLimit,
                currentPeriodEnd: subscription.currentPeriodEnd,
              }
            : null,
        },
      });
    } catch (error: any) {
      console.error("Billing me error:", error);
      return res.status(500).json({ error: "Errore nel recupero del credito" });
    }
  });

  app.post("/api/billing/checkout", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromReq(req);
      if (!userId) return res.status(401).json({ error: "Non autenticato" });
      if (!isCreditBillingEnabled()) return res.status(503).json({ error: "Billing credito non attivo" });

      const stripe = getStripeClient();
      const businessAnalysisCents = getBusinessAnalysisPriceCents();
      const requestedTopUpCents = Number.parseInt(String(req.body?.topUpCents ?? ""), 10);
      const topUpCents = Number.isFinite(requestedTopUpCents) && requestedTopUpCents > 0
        ? Math.max(requestedTopUpCents, businessAnalysisCents)
        : businessAnalysisCents;
      const origin = getFrontendOrigin(req);

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        success_url: `${origin}/#/analysis/business?billing=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/#/analysis/business?billing=cancelled`,
        metadata: {
          userId: String(userId),
          creditsCents: String(topUpCents),
        },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: BILLING_CURRENCY,
              unit_amount: topUpCents,
              product_data: {
                name: "Credito BilancioAI",
                description: "Ricarica wallet per analisi business con bilancio ottico",
              },
            },
          },
        ],
      });

      await createPendingCheckout({
        sessionId: session.id,
        userId,
        amountCents: topUpCents,
        checkoutUrl: session.url ?? null,
        metadata: {
          type: "wallet_top_up",
        },
      });

      return res.json({
        data: {
          sessionId: session.id,
          url: session.url,
          amountCents: topUpCents,
          currency: BILLING_CURRENCY,
        },
      });
    } catch (error: any) {
      console.error("Billing checkout error:", error);
      return res.status(500).json({ error: error?.message || "Errore nella creazione del checkout" });
    }
  });

  // ── Subscribe to a plan (Pro / Business) ──
  app.post("/api/billing/subscribe", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromReq(req);
      if (!userId) return res.status(401).json({ error: "Non autenticato" });
      if (!isCreditBillingEnabled()) return res.status(503).json({ error: "Billing non attivo" });

      const { plan } = req.body as { plan?: string };
      if (plan !== "pro" && plan !== "business") {
        return res.status(400).json({ error: "Piano non valido. Usa 'pro' o 'business'." });
      }

      const priceId = plan === "pro" ? getStripeProPriceId() : getStripeBusinessPriceId();
      if (!priceId) {
        return res.status(503).json({ error: `Stripe Price ID per piano '${plan}' non configurato.` });
      }

      const stripe = getStripeClient();
      const origin = getFrontendOrigin(req);

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        success_url: `${origin}/#/?subscription=success`,
        cancel_url: `${origin}/#/pricing?subscription=cancelled`,
        metadata: {
          userId: String(userId),
          plan,
        },
        line_items: [{ price: priceId, quantity: 1 }],
      });

      return res.json({ data: { url: session.url } });
    } catch (error: any) {
      console.error("Subscribe error:", error);
      return res.status(500).json({ error: error?.message || "Errore nella creazione dell'abbonamento" });
    }
  });

  // ── Stripe Webhook ──
  app.post("/api/billing/stripe/webhook", async (req: Request, res: Response) => {
    try {
      const webhookSecret = getStripeWebhookSecret();
      if (!webhookSecret) {
        return res.status(503).send("Webhook Stripe non configurato");
      }

      const signature = req.headers["stripe-signature"];
      if (typeof signature !== "string" || !signature.trim()) {
        return res.status(400).send("Stripe signature mancante");
      }

      const rawBody =
        req.rawBody instanceof Buffer
          ? req.rawBody
          : Buffer.from(
              typeof req.rawBody === "string"
                ? req.rawBody
                : JSON.stringify(req.rawBody ?? {}),
            );

      const stripe = getStripeClient();
      const event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);

      if (
        event.type === "checkout.session.completed" ||
        event.type === "checkout.session.async_payment_succeeded"
      ) {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = Number.parseInt(session.metadata?.userId || "", 10);

        if (session.mode === "subscription" && session.subscription && Number.isFinite(userId) && userId > 0) {
          // Subscription checkout completed
          const plan = session.metadata?.plan as "pro" | "business";
          if (plan === "pro" || plan === "business") {
            const stripeSubscription = await stripe.subscriptions.retrieve(session.subscription as string) as any;
            await createSubscription({
              userId,
              tier: plan,
              stripeSubscriptionId: stripeSubscription.id,
              stripeCustomerId: typeof session.customer === "string" ? session.customer : "",
              currentPeriodStart: new Date(stripeSubscription.current_period_start * 1000).toISOString(),
              currentPeriodEnd: new Date(stripeSubscription.current_period_end * 1000).toISOString(),
            });
          }
        } else {
          // One-time payment (wallet top-up)
          const amountCents = Number.parseInt(session.metadata?.creditsCents || "", 10) || session.amount_total || 0;
          if (Number.isFinite(userId) && userId > 0 && amountCents > 0) {
            await markCheckoutAsCompleted({
              sessionId: session.id,
              userId,
              amountCents,
              stripePaymentStatus: session.payment_status ?? null,
              metadata: {
                stripeCustomerId: session.customer ?? null,
                stripePaymentIntentId: session.payment_intent ?? null,
              },
            });
          }
        }
      }

      // Subscription renewed — reset monthly analysis counter
      if (event.type === "invoice.paid") {
        const invoice = event.data.object as any;
        if (invoice.subscription && invoice.billing_reason === "subscription_cycle") {
          const sub = await stripe.subscriptions.retrieve(invoice.subscription as string) as any;
          await resetSubscriptionAnalyses(
            sub.id,
            new Date(sub.current_period_start * 1000).toISOString(),
            new Date(sub.current_period_end * 1000).toISOString(),
          );
        }
      }

      // Subscription canceled
      if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object as Stripe.Subscription;
        await cancelSubscription(sub.id);
      }

      return res.json({ received: true });
    } catch (error: any) {
      console.error("Stripe webhook error:", error);
      return res.status(400).send(error?.message || "Webhook Stripe non valido");
    }
  });

  // ==========================================
  // COMPANY SEARCH — SSE streaming, improved
  // ==========================================
  app.get("/api/company/search", async (req: Request, res: Response) => {
    const userId = await getUserIdFromReq(req);
    if (!userId) {
      return res.status(401).json({ error: "Non autenticato" });
    }

    const query = (req.query.q as string || "").trim();
    const mode = req.query.mode as string;
    const normalizedQuery = normalizeCompanySearchText(query);

    if (!query || query.length < 2) {
      if (mode === "sse") {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.write(`data: ${JSON.stringify({ done: true, results: [] })}\n\n`);
        return res.end();
      }
      return res.json({ data: [] });
    }

    const queryCacheKey = `query:${normalizedQuery}`;
    const queryCached = searchCache.get(queryCacheKey);
    if (queryCached && Date.now() - queryCached.ts < CACHE_TTL) {
      if (mode === "sse") {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        for (const item of queryCached.data) {
          res.write(`data: ${JSON.stringify({ company: item })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        return res.end();
      }
      return res.json({ data: queryCached.data });
    }

    try {
      let localResults: Awaited<ReturnType<typeof searchLocalCompanyResults>> | null = null;
      const getLocalResults = async () => {
        if (!localResults) {
          localResults = await searchLocalCompanyResults(query);
        }
        return localResults;
      };

      const searchQueries = buildCompanySearchQueries(query);
      const mergedCandidates: Array<{ id: string; sourceRank: number }> = [];
      const seenIds = new Set<string>();

      for (const searchQuery of searchQueries) {
        const searchUrl = `${getCompanyBase()}/IT-search?companyName=${encodeURIComponent(searchQuery)}`;
        const searchRes = await fetchWithRetry(searchUrl, {
          headers: getAuthHeaders(),
        });

        if (!searchRes.ok) {
          console.error("IT-search error:", searchRes.status, searchQuery);
          const fallbackResults = await getLocalResults();
          if (fallbackResults.length > 0) {
            break;
          }
          if (mode === "sse") {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.write(`data: ${JSON.stringify({ done: true, error: "Errore nella ricerca" })}\n\n`);
            return res.end();
          }
          return res.json({ data: [], error: "Errore nella ricerca" });
        }

        const searchData = await readJsonResponse<{ data?: Array<{ id?: string }> }>(
          searchRes,
          { data: [] },
          `IT-search ${searchQuery}`,
        );
        const ids = (searchData.data || [])
          .map((item: any) => item?.id)
          .filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
          .slice(0, 12);

        for (const id of ids) {
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          mergedCandidates.push({ id, sourceRank: mergedCandidates.length });
          if (mergedCandidates.length >= 16) break;
        }

        if (mergedCandidates.length >= 8 || ids.length >= 8) {
          break;
        }
      }

      const ids = mergedCandidates.map((item) => item.id);

      if (ids.length === 0) {
        const fallbackResults = await getLocalResults();
        if (fallbackResults.length > 0) {
          if (mode === "sse") {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            for (const item of fallbackResults) {
              res.write(`data: ${JSON.stringify({ company: item })}\n\n`);
            }
            res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
            return res.end();
          }
          return res.json({ data: fallbackResults });
        }
        if (mode === "sse") {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.write(`data: ${JSON.stringify({ done: true, results: [] })}\n\n`);
          return res.end();
        }
        return res.json({ data: [] });
      }

      const enriched = await Promise.all(
        mergedCandidates.map(async ({ id, sourceRank }) => {
          try {
            const cachedCompany =
              searchCache.get(`company:${id}`)?.data ||
              await storage.getCachedCompanyDetails(id);
            const cachedResult = buildCompanySearchResultFromCachedDetails(query, sourceRank, cachedCompany);
            if (cachedResult) {
              return cachedResult;
            }

            const startRes = await fetchWithRetry(`${getCompanyBase()}/IT-start/${id}`, {
              headers: getAuthHeaders(),
            }, 1);
            if (!startRes.ok) {
              return null;
            }
            const startData = await readJsonResponse<{ data?: any[] }>(startRes, { data: [] }, `IT-start/${id}`);
            const company = startData.data?.[0];
            if (!company) return null;

            const addr = company.address?.registeredOffice;
            const result = {
              id: company.id,
              denominazione: company.companyName || "",
              indirizzo: addr?.streetName || "",
              comune: addr?.town || "",
              provincia: addr?.province || "",
              cap: addr?.zipCode || "",
              piva: company.vatCode || "",
              cf: company.taxCode || "",
              stato_attivita: company.activityStatus || "",
              _score: 0,
              _sourceRank: sourceRank,
            };
            result._score = scoreCompanySearchResult(query, result, sourceRank);
            return result;
          } catch (e: any) {
            if (e?.name !== "AbortError") {
              console.error(`IT-start failed for ${id}:`, e?.message);
            }
            return null;
          }
        })
      );

      const results = enriched
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .sort((a, b) => {
          if (b._score !== a._score) return b._score - a._score;
          if (a._sourceRank !== b._sourceRank) return a._sourceRank - b._sourceRank;
          return a.denominazione.localeCompare(b.denominazione);
        })
        .map(({ _score, _sourceRank, ...company }) => company);

      const finalResults = results.length > 0 ? results : await getLocalResults();

      if (finalResults.length > 0) {
        const now = Date.now();
        searchCache.set(queryCacheKey, { data: finalResults, ts: now });
        for (const r of finalResults) {
          searchCache.set(`company:${r.id}`, { data: r, ts: now });
        }
      }

      if (mode === "sse") {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");

        for (const item of finalResults) {
          if (res.writableEnded) break;
          res.write(`data: ${JSON.stringify({ company: item })}\n\n`);
        }

        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          res.end();
        }
      } else {
        return res.json({ data: finalResults });
      }
    } catch (error: any) {
      console.error("Search error:", error);
      if (mode === "sse" && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ done: true, error: "Errore" })}\n\n`);
        return res.end();
      }
      return res.status(500).json({ error: "Errore nel servizio di ricerca" });
    }
  });

  // ==========================================
  // COMPANY DETAILS — IT-advanced/{id} (con cache: stessa società = niente nuova chiamata OpenAPI)
  // ==========================================
  app.get("/api/company/:id/details", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromReq(req);
      if (!userId) return res.status(401).json({ error: "Non autenticato" });

      const id = Array.isArray(req.params.id) ? req.params.id[0] ?? "" : req.params.id ?? "";
      if (!id) return res.status(400).json({ error: "ID azienda richiesto" });

      const cached = await storage.getCachedCompanyDetails(id);
      if (cached) {
        return res.setHeader("X-BilancioAI-Cache", "company-details").json({ data: cached });
      }

      const advancedRes = await fetchWithRetry(`${getCompanyBase()}/IT-advanced/${id}`, {
        headers: getAuthHeaders(),
      });
      if (!advancedRes.ok) {
        const errText = await advancedRes.text();
        console.error("IT-advanced error:", advancedRes.status, errText);
        return res.status(advancedRes.status).json({ error: "Errore nel recupero dettagli" });
      }

      const advancedData = await advancedRes.json();
      const company = advancedData.data?.[0];
      if (!company) {
        return res.status(404).json({ error: "Azienda non trovata" });
      }

      const addr = company.address?.registeredOffice;
      const ateco = company.atecoClassification;
      const balanceSheets = company.balanceSheets;

      const bilanci: Record<string, any> = {};
      if (balanceSheets?.all && Array.isArray(balanceSheets.all)) {
        for (const bs of balanceSheets.all) {
          if (bs.year && bs.balanceSheetDate) {
            bilanci[String(bs.year)] = {
              data_chiusura_bilancio: bs.balanceSheetDate,
              fatturato: bs.turnover,
              patrimonio_netto: bs.netWorth,
              capitale_sociale: bs.shareCapital,
              costo_personale: bs.totalStaffCost,
              totale_attivo: bs.totalAssets,
              dipendenti: bs.employees,
              stipendio_medio_lordo: bs.avgGrossSalary,
            };
          }
        }
      }

      const taxCode = company.taxCode || "";
      if (Object.keys(bilanci).length > 0 && taxCode) {
        await storage.cacheBilancio(id, taxCode, bilanci);
      }

      const data = {
        id: company.id,
        denominazione: company.companyName,
        codice_fiscale: company.taxCode,
        partita_iva: company.vatCode,
        indirizzo: addr?.streetName || "",
        comune: addr?.town || "",
        provincia: addr?.province || "",
        cap: addr?.zipCode || "",
        stato_attivita: company.activityStatus,
        pec: company.pec || null,
        telefono: company.phoneNumber || company.phone || null,
        forma_giuridica: company.detailedLegalForm?.description || "",
        data_inizio: company.startDate || null,
        data_iscrizione: company.registrationDate || null,
        rea: company.reaCode || null,
        cciaa: company.cciaa || null,
        dettaglio: {
          descrizione_ateco: ateco?.ateco2022?.description || ateco?.ateco2007?.description || ateco?.ateco?.description || "",
          codice_ateco: ateco?.ateco2022?.code || ateco?.ateco2007?.code || ateco?.ateco?.code || "",
          bilanci,
          balanceSheets_raw: balanceSheets,
        },
        shareholders: company.shareHolders || null,
      };

      await storage.setCachedCompanyDetails(id, data);
      return res.json({ data });
    } catch (error: any) {
      console.error("Details error:", error);
      return res.status(500).json({ error: "Errore nel servizio dettagli" });
    }
  });

  app.post("/api/company/full-chart-data", async (req: Request, res: Response) => {
    let billedUserId: number | null = null;
    let billingReference = "";
    let businessAnalysisCents = getBusinessAnalysisPriceCents();
    let billedCompanyId = "";
    let billedTaxCode = "";
    let billingRefunded = false;
    let businessChargeApplied = false;

    try {
      const { companyId, vatCode, taxCode } = req.body;
      const normalizedCompanyId = typeof companyId === "string" ? companyId.trim() : "";
      const normalizedTaxCode = typeof taxCode === "string" ? taxCode.trim() : "";
      const normalizedVatCode = typeof vatCode === "string" ? vatCode.trim() : "";
      const documentPreference = req.body?.documentPreference === "upload" ? "upload" : "openapi";
      const resolvedTaxCodeForDocuEngine = normalizedTaxCode || normalizedVatCode;
      billedCompanyId = normalizedCompanyId;

      if (!normalizedCompanyId) {
        return res.status(400).json({ error: "companyId è richiesto" });
      }

      const userId = await getUserIdFromReq(req);
      if (!userId) {
        return res.status(401).json({ error: "Non autenticato" });
      }

      billedUserId = userId;
      billingReference =
        typeof req.body?.billingReference === "string" && req.body.billingReference.trim()
          ? req.body.billingReference.trim()
          : `business:${normalizedCompanyId}:${Date.now()}`;

      const failWithRefund = async (statusCode: number, errorMessage: string) => {
        if (billedUserId && businessChargeApplied && !billingRefunded) {
          await refundBusinessAnalysisCredits({
            userId: billedUserId,
            amountCents: businessAnalysisCents,
            reference: billingReference,
            reason: `Rimborso credito analisi business: ${errorMessage.slice(0, 120)}`,
            companyId: billedCompanyId || undefined,
            taxCode: billedTaxCode || resolvedTaxCodeForDocuEngine || undefined,
          });
          billingRefunded = true;
        }

        return res.status(statusCode).json({ error: errorMessage });
      };

      if (isCreditBillingEnabled()) {
        // Subscribers: consume from subscription first, then wallet for extras
        const tier = await getUserTier(userId);
        let subscriptionConsumed = false;
        if (tier === "pro" || tier === "business") {
          const subResult = await consumeSubscriptionAnalysis(userId);
          if (subResult.ok) {
            subscriptionConsumed = true;
            businessChargeApplied = true; // so refund logic works
          } else if (subResult.reason === "limit_reached") {
            // Over limit: charge at subscriber rate via wallet
            businessAnalysisCents = getSubscriberExtraAnalysisPriceCents();
          }
        }

        if (!subscriptionConsumed) {
          const billingResult = await consumeBusinessAnalysisCredits({
            userId,
            amountCents: businessAnalysisCents,
            reference: billingReference,
            companyId: normalizedCompanyId,
            taxCode: resolvedTaxCodeForDocuEngine || undefined,
          });
          if (!billingResult.ok) {
            return res.status(402).json({
              error: "Credito insufficiente per avviare l'analisi business.",
              code: "INSUFFICIENT_CREDIT",
              balanceCents: billingResult.balanceCents,
              requiredCents: businessAnalysisCents,
              missingCents: billingResult.missingCents,
            });
          }
          businessChargeApplied = true;
        }
      }

      const previousBusinessCache =
        (normalizedTaxCode ? await storage.getCachedCompanyFullDataByTaxCode(normalizedTaxCode) : undefined) ||
        (normalizedVatCode ? await storage.getCachedCompanyFullDataByTaxCode(normalizedVatCode) : undefined) ||
        (await storage.getCachedCompanyFullData(normalizedCompanyId)) ||
        (await findReusableBusinessSnapshot(
          normalizedCompanyId,
          [normalizedTaxCode, normalizedVatCode].filter((value): value is string => Boolean(value)),
        ));

      // --- 1. IT-advanced: dettagli azienda e anni disponibili ---
      let companyDetails: any =
        await storage.getCachedCompanyDetails(normalizedCompanyId) ||
        previousBusinessCache?.companyDetails ||
        null;

      if (!companyDetails) {
        const advancedRes = await fetchWithRetry(`${getCompanyBase()}/IT-advanced/${normalizedCompanyId}`, {
          headers: getAuthHeaders(),
        });
        if (!advancedRes.ok) {
          const errText = await advancedRes.text();
          console.error("IT-advanced error:", advancedRes.status, errText);
          return failWithRefund(advancedRes.status, "Errore nel recupero dettagli azienda (IT-advanced)");
        }

        const advancedData = await readJsonResponse<{ data?: any[] }>(advancedRes, { data: [] }, `IT-advanced/${normalizedCompanyId}`);
        const company = advancedData.data?.[0];
        if (!company) {
          return failWithRefund(404, "Azienda non trovata");
        }

        const addr = company.address?.registeredOffice;
        const ateco = company.atecoClassification;
        const balanceSheets = company.balanceSheets;

        // Bilanci sintetici da IT-advanced (ricavi storici)
        const bilanci: Record<string, any> = {};
        if (balanceSheets?.all && Array.isArray(balanceSheets.all)) {
          for (const bs of balanceSheets.all) {
            if (bs.year && bs.balanceSheetDate) {
              bilanci[String(bs.year)] = {
                data_chiusura_bilancio: bs.balanceSheetDate,
                fatturato: bs.turnover,
                patrimonio_netto: bs.netWorth,
                capitale_sociale: bs.shareCapital,
                costo_personale: bs.totalStaffCost,
                totale_attivo: bs.totalAssets,
                dipendenti: bs.employees,
                stipendio_medio_lordo: bs.avgGrossSalary,
              };
            }
          }
        }

        companyDetails = {
          id: company.id,
          denominazione: company.companyName,
          codice_fiscale: company.taxCode,
          partita_iva: company.vatCode,
          indirizzo: addr?.streetName || "",
          comune: addr?.town || "",
          provincia: addr?.province || "",
          cap: addr?.zipCode || "",
          stato_attivita: normalizeActivityStatus(company.activityStatus),
          pec: company.pec || null,
          telefono: company.phoneNumber || company.phone || null,
          forma_giuridica: company.detailedLegalForm?.description || "",
          data_inizio: company.startDate || null,
          data_iscrizione: company.registrationDate || null,
          rea: company.reaCode || null,
          cciaa: company.cciaa || null,
          dettaglio: {
            descrizione_ateco: ateco?.ateco2022?.description || ateco?.ateco2007?.description || ateco?.ateco?.description || "",
            codice_ateco: ateco?.ateco2022?.code || ateco?.ateco2007?.code || ateco?.ateco?.code || "",
            bilanci,
            balanceSheets_raw: balanceSheets,
          },
          shareholders: company.shareHolders || null,
        };

        await storage.setCachedCompanyDetails(normalizedCompanyId, companyDetails);
        const detailTaxCode = company.taxCode || company.vatCode || resolvedTaxCodeForDocuEngine;
        if (Object.keys(bilanci).length > 0 && detailTaxCode) {
          await storage.cacheBilancio(normalizedCompanyId, detailTaxCode, bilanci);
        }
      }

      // --- 2. Bilancio ottico via DocuEngine: il grafico prende KPI solo dai documenti ottici acquistati ---
      const finalTaxCode =
        companyDetails?.codice_fiscale ||
        companyDetails?.partita_iva ||
        resolvedTaxCodeForDocuEngine;
      billedTaxCode = finalTaxCode || resolvedTaxCodeForDocuEngine;
      const userUploadedDocuments =
        documentPreference === "upload"
          ? await storage.listUserUploadedBilanci(userId, normalizedCompanyId)
          : [];
      const userUploadedBilanci = buildUserUploadedBilanciPackage(userUploadedDocuments);

      if (documentPreference === "upload" && Object.keys(userUploadedBilanci).length === 0) {
        return failWithRefund(400, "Hai scelto di usare i tuoi bilanci, ma non hai ancora caricato nessun documento.");
      }

      if (!finalTaxCode) {
        return failWithRefund(400, "Codice fiscale o partita IVA non disponibili per il bilancio ottico");
      }

      const cachedPackage =
        (await storage.getCachedBilancioPackageByTaxCode(finalTaxCode)) ||
        (await storage.getCachedBilancioPackage(normalizedCompanyId));
      let purchasedBilanci = getPurchasedBilanciBySource(cachedPackage, BILANCIO_OTTICO_PDF_SOURCE);
      let resolvedBilanciEntries = {
        ...purchasedBilanci,
        ...userUploadedBilanci,
      };
      const cachedAvailableYears = Object.keys(purchasedBilanci || {}).sort((a, b) => b.localeCompare(a));
      const uploadedAvailableYears = Object.keys(userUploadedBilanci || {}).sort((a, b) => b.localeCompare(a));
      const summaryAvailableYears = Object.keys(companyDetails?.dettaglio?.bilanci || {})
        .filter((year) => Boolean(extractYear(year)))
        .sort((a, b) => b.localeCompare(a));
      const knownAvailableYears = Array.from(new Set([...cachedAvailableYears, ...uploadedAvailableYears, ...summaryAvailableYears]))
        .sort((a, b) => b.localeCompare(a));

      let latestYear = knownAvailableYears[0] || "";
      if (!latestYear) {
        return failWithRefund(502, "Nessun bilancio ottico disponibile per questa societa'.");
      }

      const buildPurchaseYears = (referenceYear: string, availableYears: string[]) => {
        const yearMinusTwo = String(Number.parseInt(referenceYear, 10) - 2);
        return [referenceYear, yearMinusTwo].filter((year: string, index: number, list: string[]) => {
          if (!availableYears.includes(year)) return false;
          return list.indexOf(year) === index;
        });
      };

      let availableYears = knownAvailableYears;
      let purchaseYears = buildPurchaseYears(latestYear, availableYears);
      let coveredYears = buildCoveredYears(latestYear);
      let probeSearchRequest:
        | { requestId: string; state: unknown; results: any[] }
        | null = null;
      let missingPurchaseYears = purchaseYears.filter((year) => !resolvedBilanciEntries[year]);
      const purchaseErrors: string[] = [];

      if (missingPurchaseYears.length > 0) {
        try {
          probeSearchRequest = await createDocuEngineSearchRequest(finalTaxCode, DOCUENGINE_DOCUMENT_IDS.BILANCIO_OTTICO);
          const docuEngineAvailableYears = Array.from(
            new Set<string>(
              probeSearchRequest.results
                .map((result: any) => extractYear(result?.data?.balanceSheetDate) ?? extractYear(result?.data?.year))
                .filter(Boolean) as string[],
            ),
          ).sort((a, b) => b.localeCompare(a));

          availableYears = Array.from(new Set([...cachedAvailableYears, ...uploadedAvailableYears, ...docuEngineAvailableYears]))
            .sort((a, b) => b.localeCompare(a));
          latestYear = availableYears[0] || latestYear;
          purchaseYears = buildPurchaseYears(latestYear, availableYears);
          coveredYears = buildCoveredYears(latestYear);
          missingPurchaseYears = purchaseYears.filter((year) => !resolvedBilanciEntries[year]);
        } catch (error: any) {
          purchaseErrors.push(error?.message || "Errore nella ricerca bilancio ottico");

          if (cachedAvailableYears.length === 0 && uploadedAvailableYears.length === 0) {
            throw error;
          }

          availableYears = Array.from(new Set([...cachedAvailableYears, ...uploadedAvailableYears])).sort((a, b) => b.localeCompare(a));
          latestYear = availableYears[0];
          purchaseYears = buildPurchaseYears(latestYear, availableYears);
          coveredYears = buildCoveredYears(latestYear);
          missingPurchaseYears = purchaseYears.filter((year) => !resolvedBilanciEntries[year]);
        }
      }

      for (let index = 0; index < missingPurchaseYears.length; index++) {
        const year = missingPurchaseYears[index];
        try {
          const searchRequest = index === 0 && probeSearchRequest
            ? probeSearchRequest
            : await createDocuEngineSearchRequest(finalTaxCode, DOCUENGINE_DOCUMENT_IDS.BILANCIO_OTTICO);
          const matchingResult = searchRequest.results.find((result: any) => {
            const bsYear = extractYear(result?.data?.balanceSheetDate) ?? extractYear(result?.data?.year);
            return bsYear === year;
          });
          if (!matchingResult?.id) continue;

          const patchRes = await fetch(`${getDocuEngineBase()}/requests/${searchRequest.requestId}`, {
            method: "PATCH",
            headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({ resultId: matchingResult.id }),
          });
          if (!patchRes.ok) {
            const errText = await patchRes.text();
            purchaseErrors.push(extractServiceErrorMessage(errText));
            continue;
          }

          await waitForDocuEngineDone(searchRequest.requestId);

          const docRes = await fetch(`${getDocuEngineBase()}/requests/${searchRequest.requestId}/documents`, {
            headers: getAuthHeaders(),
          });
          if (!docRes.ok) {
            const errText = await docRes.text();
            purchaseErrors.push(extractServiceErrorMessage(errText));
            continue;
          }

          const documentsResponse = await readJsonResponse<{ data?: any[] }>(docRes, { data: [] }, `DocuEngine docs ${searchRequest.requestId}`);
          const documents = Array.isArray(documentsResponse.data) ? documentsResponse.data : [];
          if (documents.length === 0) {
            purchaseErrors.push(`Nessun documento restituito per il bilancio ottico ${year}`);
            continue;
          }

          const { storedDocuments, bilancioData: structuredData } = await downloadAndStoreBilancioDocuments(normalizedCompanyId, year, documents);
          const bilancioData = {
            source: BILANCIO_OTTICO_PDF_SOURCE,
            purchaseYear: year,
            documentType: "bilancio-ottico",
            structuredData: structuredData?.source === BILANCIO_OTTICO_XBRL_SOURCE ? structuredData : null,
            coveredYears: Array.isArray(structuredData?.coveredYears) ? structuredData.coveredYears : [],
            parsedFrom: typeof structuredData?.parsedFrom === "string" ? structuredData.parsedFrom : null,
          };
          const pkg = await storage.cachePurchasedBilancio(normalizedCompanyId, finalTaxCode, year, storedDocuments, bilancioData);
          purchasedBilanci = getPurchasedBilanciBySource(pkg, BILANCIO_OTTICO_PDF_SOURCE);
          resolvedBilanciEntries = {
            ...purchasedBilanci,
            ...userUploadedBilanci,
          };
        } catch (e: any) {
          purchaseErrors.push(e?.message || `Errore nel download del bilancio ottico ${year}`);
          console.warn(`Bilancio ottico download failed for year ${year}:`, e?.message);
        }
      }

      resolvedBilanciEntries = {
        ...purchasedBilanci,
        ...userUploadedBilanci,
      };

      let comparativeBilanci = buildBilanciFromComparativeXbrl(resolvedBilanciEntries, coveredYears);
      if (hasUsableBilancioOtticoBusinessCache(previousBusinessCache)) {
        comparativeBilanci = mergeComparativeBilanci(
          comparativeBilanci,
          previousBusinessCache?.financialData?.bilanci,
          coveredYears,
        );
      }
      let hasAnyParsedPeriod = Object.values(comparativeBilanci).some((yearData: any) => yearData?.status === "ok");

      if (shouldEnrichComparativeBilanciWithAi(comparativeBilanci, coveredYears)) {
        try {
          const extractedBilanci = await extractComparativeBilanciFromOtticoPdfs(resolvedBilanciEntries, purchaseYears, coveredYears);
          if (extractedBilanci) {
            comparativeBilanci = mergeComparativeBilanci(comparativeBilanci, extractedBilanci, coveredYears);
            hasAnyParsedPeriod = Object.values(comparativeBilanci).some((yearData: any) => yearData?.status === "ok");
          } else if (!hasAnyParsedPeriod && hasUsableBilancioOtticoBusinessCache(previousBusinessCache)) {
            comparativeBilanci = mergeComparativeBilanci(
              comparativeBilanci,
              previousBusinessCache?.financialData?.bilanci,
              coveredYears,
            );
            hasAnyParsedPeriod = Object.values(comparativeBilanci).some((yearData: any) => yearData?.status === "ok");
          } else if (!hasAnyParsedPeriod) {
            const failureMessage = purchaseErrors[0] || "Nessun PDF disponibile nei bilanci ottici acquistati.";
            const statusCode = /insufficient credit|billing/i.test(failureMessage) ? 402 : 502;
            return failWithRefund(statusCode, failureMessage);
          }
        } catch (error: any) {
          if (hasUsableBilancioOtticoBusinessCache(previousBusinessCache)) {
            comparativeBilanci = mergeComparativeBilanci(
              comparativeBilanci,
              previousBusinessCache?.financialData?.bilanci,
              coveredYears,
            );
            hasAnyParsedPeriod = Object.values(comparativeBilanci).some((yearData: any) => yearData?.status === "ok");
          }
          if (!hasAnyParsedPeriod) {
            if (error?.message === "Chiave OpenAI non configurata.") {
              return failWithRefund(503, error.message);
            }
            throw error;
          }
          console.warn("Bilancio ottico AI enrichment error:", error?.message || error);
        }
      }

      if (!hasAnyParsedPeriod) {
        const failureMessage = purchaseErrors[0] || "Nessun periodo leggibile trovato nei bilanci ottici acquistati.";
        const statusCode = /insufficient credit|billing/i.test(failureMessage) ? 402 : 502;
        return failWithRefund(statusCode, failureMessage);
      }

      const documentSource =
        Object.keys(userUploadedBilanci).length > 0 && Object.keys(purchasedBilanci).length > 0
          ? "mixed"
          : Object.keys(userUploadedBilanci).length > 0
            ? "user_upload"
            : "openapi";

      const financialData = {
        source: BILANCIO_OTTICO_COMPARATIVE_SOURCE,
        purchaseYears,
        coveredYears,
        bilanci: comparativeBilanci,
        purchasedBilanci,
        userUploadedBilanci,
        documentSource,
        fetchedAt: new Date().toISOString(),
      };

      const descriptionPayload = await generatePrivateEquityCompanyDescription(companyDetails, financialData);
      const marketBenchmarks = await generateMarketBenchmarks(
        companyDetails,
        financialData,
        descriptionPayload.description,
      );
      const recommendationPayload = await generateWorkingCapitalDebtAndRecommendations(
        companyDetails,
        financialData,
        marketBenchmarks,
        descriptionPayload.description,
      );
      const insights = {
        version: BUSINESS_INSIGHTS_VERSION,
        marketBenchmarks,
        workingCapitalDebt: recommendationPayload.workingCapitalDebt,
        recommendations: recommendationPayload.recommendations,
      };
      const financialDataWithInsights = {
        ...financialData,
        insightsVersion: BUSINESS_INSIGHTS_VERSION,
        insights,
      };
      const result = {
        companyDetails: {
          ...companyDetails,
          aiDescription: descriptionPayload.description,
          aiDescriptionSources: descriptionPayload.sources,
          aiKeyProducts: descriptionPayload.keyProducts,
          aiDescriptionVersion: descriptionPayload.version,
        },
        financialData: financialDataWithInsights,
        insights,
        documentSource,
      };

      if (documentSource === "openapi") {
        await storage.setCachedCompanyFullData(normalizedCompanyId, finalTaxCode, result);
      }
      await createAnalysisHistoryEntry({
        userId,
        mode: "business",
        companyName: companyDetails?.denominazione || normalizedCompanyId,
        companyId: normalizedCompanyId,
        taxCode: finalTaxCode,
        address: companyDetails?.indirizzo || null,
        companyDetails: result.companyDetails,
        financialData: result.financialData,
      });

      return res.json({ data: result });
    } catch (error: any) {
      if (billedUserId && businessChargeApplied && !billingRefunded) {
        await refundBusinessAnalysisCredits({
          userId: billedUserId,
          amountCents: businessAnalysisCents,
          reference: billingReference || `business:${billedCompanyId}:${Date.now()}`,
          reason: "Rimborso credito analisi business per errore backend",
          companyId: billedCompanyId || undefined,
          taxCode: billedTaxCode || undefined,
        });
        billingRefunded = true;
      }
      if (error instanceof OpenAIResponsesError) {
        console.error("Full chart data OpenAI error:", error.status, error.body);
        return res.status(500).json({ error: `OpenAI: ${error.message}` });
      }
      console.error("Full chart data error:", error);
      return res.status(500).json({ error: "Errore nel recupero dati azienda" });
    }
  });

  // ==========================================
  // EBITDA from structured OpenAPI balance sheet data
  // ==========================================
  app.post("/api/company/estimate-ebitda", async (req: Request, res: Response) => {
    try {
      const { bilanci, purchasedBilanci } = req.body;
      const normalized = buildStructuredEbitdaResponse(
        bilanci && typeof bilanci === "object" ? bilanci : {},
        purchasedBilanci && typeof purchasedBilanci === "object" ? purchasedBilanci : {},
      );

      if (
        Object.keys(normalized.ebitda).length === 0 &&
        Object.keys(normalized.revenue).length === 0
      ) {
        return res.status(400).json({
          error: "Nessun bilancio riclassificato OpenAPI disponibile per estrarre fatturato ed EBITDA corretti.",
        });
      }

      return res.json({ data: normalized });
    } catch (error: any) {
      console.error("Structured EBITDA extraction error:", error);
      return res.status(500).json({ error: "Errore nel recupero di fatturato ed EBITDA" });
    }
  });

  // ==========================================
  // BILANCIO RICLASSIFICATO - Request via DocuEngine (cache centralizzata: prima si controlla bilanci_cache / getCachedBilancioByTaxCode)
  // ==========================================
  app.post("/api/bilancio/request", async (req: Request, res: Response) => {
    try {
      const { taxCode, year, targetYears } = req.body;
      if (!taxCode) {
        return res.status(400).json({ error: "Codice fiscale richiesto" });
      }

      // Check cache first
      const cachedPackage = await storage.getCachedBilancioPackageByTaxCode(taxCode);
      const normalizedTargetYears = normalizeTargetYears(targetYears, cachedPackage?.bilanci);
      const hasAllRequestedPdfs =
        normalizedTargetYears.length > 0 &&
        normalizedTargetYears.every((targetYear) => Boolean(cachedPackage?.purchasedBilanci?.[targetYear]));

      if (
        cachedPackage &&
        (
          hasAllRequestedPdfs ||
          (normalizedTargetYears.length === 0 &&
            (Object.keys(cachedPackage.bilanci).length > 0 || Object.keys(cachedPackage.purchasedBilanci).length > 0))
        )
      ) {
        const latestPurchased = getLatestPurchasedBilancio(cachedPackage.purchasedBilanci);
        return res.json({
          data: {
            cached: true,
            bilanci: cachedPackage.bilanci,
            purchasedBilanci: cachedPackage.purchasedBilanci,
            bilancioData: latestPurchased?.bilancioData ?? null,
            latestPurchasedYear: latestPurchased?.year ?? null,
            targetYears: normalizedTargetYears,
          },
        });
      }

      const searchPayload: any = {
        documentId: DOCUENGINE_DOCUMENT_IDS.BILANCIO_RICLASSIFICATO,
        search: { field0: taxCode },
      };
      if (year) {
        searchPayload.state = "NEW";
      }

      const searchRes = await fetch(`${getDocuEngineBase()}/requests`, {
        method: "POST",
        headers: {
          ...getAuthHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(searchPayload),
      });

      if (!searchRes.ok) {
        const errText = await searchRes.text();
        console.error("DocuEngine request error:", searchRes.status, errText);
        return res.status(searchRes.status).json({ error: "Errore nella richiesta bilancio" });
      }

      const searchData = await searchRes.json();
      return res.json(searchData);
    } catch (error: any) {
      console.error("Bilancio request error:", error);
      return res.status(500).json({ error: "Errore nel servizio bilancio" });
    }
  });

  app.post("/api/bilancio/ensure-years", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromReq(req);
      if (!userId) return res.status(401).json({ error: "Non autenticato" });

      const { companyId, taxCode, targetYears, bilanci } = req.body;
      if (!companyId || !taxCode) {
        return res.status(400).json({ error: "companyId e taxCode sono richiesti" });
      }

      const yearsToEnsure = normalizeTargetYears(targetYears, bilanci);
      if (yearsToEnsure.length === 0) {
        return res.status(400).json({ error: "Nessun anno target disponibile per il download PDF" });
      }

      let cachedPackage =
        (await storage.getCachedBilancioPackageByTaxCode(taxCode)) ||
        (await storage.getCachedBilancioPackage(companyId)) || {
          bilanci: bilanci || {},
          purchasedBilanci: {} as Record<string, any>,
        };

      if (Object.keys(cachedPackage.bilanci).length === 0 && bilanci && typeof bilanci === "object") {
        await storage.cacheBilancio(companyId, taxCode, bilanci);
        cachedPackage =
          (await storage.getCachedBilancioPackageByTaxCode(taxCode)) ||
          (await storage.getCachedBilancioPackage(companyId)) ||
          cachedPackage;
      }

      const downloadedYears: string[] = [];
      const purchasedBilanciMap = (cachedPackage.purchasedBilanci || {}) as Record<string, any>;
      const missingYears = yearsToEnsure.filter((year) => !purchasedBilanciMap[year]);

      for (const year of missingYears) {
        const searchRequest = await createDocuEngineSearchRequest(taxCode);
        const matchingResult = searchRequest.results.find((result: any) => {
          const balanceSheetYear = extractYear(result?.data?.balanceSheetDate) ?? extractYear(result?.data?.year);
          return balanceSheetYear === year;
        });

        if (!matchingResult?.id) {
          continue;
        }

        const patchRes = await fetch(`${getDocuEngineBase()}/requests/${searchRequest.requestId}`, {
          method: "PATCH",
          headers: {
            ...getAuthHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ resultId: matchingResult.id }),
        });

        if (!patchRes.ok) {
          const errText = await patchRes.text();
          throw new Error(`DocuEngine patch error ${patchRes.status}: ${errText.slice(0, 300)}`);
        }

        await waitForDocuEngineDone(searchRequest.requestId);

        const docRes = await fetch(`${getDocuEngineBase()}/requests/${searchRequest.requestId}/documents`, {
          headers: getAuthHeaders(),
        });
        if (!docRes.ok) {
          const errText = await docRes.text();
          throw new Error(`DocuEngine documents error ${docRes.status}: ${errText.slice(0, 300)}`);
        }

        const documentsResponse = await readJsonResponse<{ data?: any[] }>(
          docRes,
          { data: [] },
          `DocuEngine documents ${searchRequest.requestId}`,
        );
        const documents = Array.isArray(documentsResponse.data) ? documentsResponse.data : [];
        if (documents.length === 0) {
          continue;
        }

        const { storedDocuments, bilancioData } = await downloadAndStoreBilancioDocuments(companyId, year, documents);
        await storage.cachePurchasedBilancio(companyId, taxCode, year, storedDocuments, bilancioData);
        downloadedYears.push(year);

        cachedPackage =
          (await storage.getCachedBilancioPackageByTaxCode(taxCode)) ||
          (await storage.getCachedBilancioPackage(companyId)) ||
          cachedPackage;
      }

      const latestPurchased = getLatestPurchasedBilancio(cachedPackage.purchasedBilanci);
      return res.json({
        data: {
          cached: downloadedYears.length === 0,
          targetYears: yearsToEnsure,
          downloadedYears,
          bilanci: cachedPackage.bilanci,
          purchasedBilanci: cachedPackage.purchasedBilanci,
          bilancioData: latestPurchased?.bilancioData ?? null,
          latestPurchasedYear: latestPurchased?.year ?? null,
        },
      });
    } catch (error: any) {
      console.error("Ensure bilancio years error:", error);
      return res.status(500).json({ error: error?.message || "Errore nel download dei bilanci PDF" });
    }
  });

  // ==========================================
  // BILANCIO - Select year and process
  // ==========================================
  app.patch("/api/bilancio/:requestId", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromReq(req);
      if (!userId) return res.status(401).json({ error: "Non autenticato" });

      const { requestId } = req.params;
      const { resultId } = req.body;

      const patchRes = await fetch(`${getDocuEngineBase()}/requests/${requestId}`, {
        method: "PATCH",
        headers: {
          ...getAuthHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ resultId }),
      });

      if (!patchRes.ok) {
        return res.status(patchRes.status).json({ error: "Errore nella selezione anno bilancio" });
      }

      const data = await patchRes.json();
      return res.json(data);
    } catch (error: any) {
      return res.status(500).json({ error: "Errore nel servizio bilancio" });
    }
  });

  // ==========================================
  // BILANCIO - Check status
  // ==========================================
  app.get("/api/bilancio/:requestId/status", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromReq(req);
      if (!userId) return res.status(401).json({ error: "Non autenticato" });

      const { requestId } = req.params;

      const statusRes = await fetch(`${getDocuEngineBase()}/requests/${requestId}`, {
        headers: getAuthHeaders(),
      });

      if (!statusRes.ok) {
        return res.status(statusRes.status).json({ error: "Errore nel controllo stato" });
      }

      const data = await statusRes.json();
      return res.json(data);
    } catch (error: any) {
      return res.status(500).json({ error: "Errore nel controllo stato" });
    }
  });

  // ==========================================
  // BILANCIO - Download documents
  // Scarichiamo 1 solo bilancio riclassificato (anno più recente scelto dal client).
  // I dati sintetici multi-anno (fatturato, patrimonio_netto, ecc.) arrivano da IT-advanced, non da download.
  // ==========================================
  app.get("/api/bilancio/:requestId/documents", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromReq(req);
      if (!userId) return res.status(401).json({ error: "Non autenticato" });

      const { requestId } = req.params;

      const docRes = await fetch(`${getDocuEngineBase()}/requests/${requestId}/documents`, {
        headers: getAuthHeaders(),
      });

      if (!docRes.ok) {
        return res.status(docRes.status).json({ error: "Errore nel download documenti" });
      }

      const data = await docRes.json();
      return res.json(data);
    } catch (error: any) {
      return res.status(500).json({ error: "Errore nel download" });
    }
  });

  app.post("/api/bilancio/:requestId/finalize", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromReq(req);
      if (!userId) return res.status(401).json({ error: "Non autenticato" });

      const { requestId } = req.params;
      const { companyId, taxCode, year } = req.body;

      if (!companyId || !taxCode) {
        return res.status(400).json({ error: "companyId e taxCode sono richiesti" });
      }

      const docRes = await fetch(`${getDocuEngineBase()}/requests/${requestId}/documents`, {
        headers: getAuthHeaders(),
      });

      if (!docRes.ok) {
        const errText = await docRes.text();
        console.error("DocuEngine documents error:", docRes.status, errText);
        return res.status(docRes.status).json({ error: "Errore nel download documenti" });
      }

      const documentsResponse = await readJsonResponse<{ data?: any[] }>(docRes, { data: [] }, `DocuEngine documents ${requestId}`);
      const documents = Array.isArray(documentsResponse.data) ? documentsResponse.data : [];
      if (documents.length === 0) {
        return res.status(404).json({ error: "Nessun documento disponibile" });
      }

      const firstDocument = documents.find((doc) => typeof doc?.downloadUrl === "string" && doc.downloadUrl) ?? documents[0];
      if (!firstDocument?.downloadUrl) {
        return res.status(500).json({ error: "Documento senza downloadUrl" });
      }

      const downloadedRes = await fetch(firstDocument.downloadUrl);
      if (!downloadedRes.ok) {
        const errText = await downloadedRes.text();
        console.error("Bilancio JSON download error:", downloadedRes.status, errText.slice(0, 300));
        return res.status(downloadedRes.status).json({ error: "Errore nel download del bilancio riclassificato" });
      }

      const bilancioData = await readJsonResponse<any>(
        downloadedRes,
        null,
        `Bilancio downloaded JSON ${requestId}`,
      );
      if (!bilancioData) {
        return res.status(500).json({ error: "Il bilancio scaricato non contiene JSON valido" });
      }

      const inferredYear =
        year ||
        bilancioData?.esercizio ||
        bilancioData?.anno ||
        bilancioData?.year ||
        (typeof bilancioData?.data_chiusura === "string" ? bilancioData.data_chiusura.slice(0, 4) : null) ||
        (typeof bilancioData?.balanceSheetDate === "string" ? bilancioData.balanceSheetDate.slice(0, 4) : null) ||
        new Date().getFullYear().toString();

      const cachedPackage = await storage.cachePurchasedBilancio(
        companyId,
        taxCode,
        String(inferredYear),
        documents,
        bilancioData,
      );

      return res.json({
        data: {
          cached: false,
          bilanci: cachedPackage.bilanci,
          purchasedBilanci: cachedPackage.purchasedBilanci,
          bilancioData,
          latestPurchasedYear: String(inferredYear),
        },
      });
    } catch (error: any) {
      console.error("Bilancio finalize error:", error);
      return res.status(500).json({ error: "Errore nel salvataggio del bilancio" });
    }
  });

  app.get("/api/bilancio/cached/:companyId/:year/:index", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromReq(req, true);
      if (!userId) return res.status(401).json({ error: "Non autenticato" });

      const companyId = Array.isArray(req.params.companyId) ? req.params.companyId[0] ?? "" : req.params.companyId ?? "";
      const year = Array.isArray(req.params.year) ? req.params.year[0] ?? "" : req.params.year ?? "";
      const index = Array.isArray(req.params.index) ? req.params.index[0] ?? "" : req.params.index ?? "";
      const source = typeof req.query.source === "string" ? req.query.source.trim() : "";
      const packageData = await storage.getCachedBilancioPackage(companyId);
      const sourcePurchasedBilanci = source ? getPurchasedBilanciBySource(packageData, source) : {};
      const yearEntry =
        sourcePurchasedBilanci?.[year] ||
        packageData?.purchasedBilanci?.[year] ||
        Object.values(packageData?.purchasedBilanciBySource || {}).find((entries: any) => entries?.[year])?.[year];
      const documentIndex = Number.parseInt(index, 10);

      if (!yearEntry || !Array.isArray(yearEntry.documents) || !Number.isInteger(documentIndex)) {
        return res.status(404).json({ error: "Documento di bilancio non trovato" });
      }

      const document = yearEntry.documents[documentIndex];
      if (!document?.storageKey) {
        return res.status(404).json({ error: "Documento di bilancio non disponibile" });
      }

      const fileBuffer = await readStoredBilancioDocument(document);
      if (document.mimeType) {
        res.type(String(document.mimeType));
      }
      res.setHeader(
        "Content-Disposition",
        `${isStoredInlineBilancioDocument(document) ? "inline" : "attachment"}; filename="${document.originalName || document.filename || "bilancio"}"`,
      );
      return res.send(fileBuffer);
    } catch (error: any) {
      console.error("Cached bilancio file error:", error);
      return res.status(500).json({ error: "Errore nel recupero del file bilancio" });
    }
  });

  // ==========================================
  // AI ANALYSIS — Dati scaricati da OpenAPI, analizzati da ChatGPT
  // ==========================================
  app.post("/api/analyze", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromReq(req);
      if (!userId) return res.status(401).json({ error: "Non autenticato" });

      const { companyName, companyDetails, financialData, mode, competitors } = req.body;

      const hasDetails = companyDetails && typeof companyDetails === "object" && Object.keys(companyDetails).length > 0;
      const hasFinancial =
        financialData &&
        typeof financialData === "object" &&
        (Object.keys(financialData.bilanci || {}).length > 0 ||
          Object.keys(financialData.purchasedBilanci || {}).length > 0 ||
          financialData.bilancioData ||
          financialData.requestId ||
          financialData.availableYears);
      if (!hasDetails && !hasFinancial) {
        return res.status(400).json({
          error: "Nessun dato da analizzare. Scarica prima i dettagli azienda (OpenAPI) o richiedi il bilancio.",
        });
      }

      const apiKey = getOpenaiApiKey();
      if (!apiKey) {
        console.error("Analyze: OPENAI_API_KEY mancante");
        return res.status(503).json({ error: "Chiave OpenAI non configurata. Imposta OPENAI_API_KEY in .env o in Supabase app_config." });
      }

      const cacheCompanyId = companyDetails?.id ?? null;
      const cacheTaxCode = companyDetails?.codice_fiscale ?? companyDetails?.taxCode ?? null;
      const cachedPackage =
        (cacheTaxCode ? await storage.getCachedBilancioPackageByTaxCode(cacheTaxCode) : undefined) ||
        (cacheCompanyId ? await storage.getCachedBilancioPackage(cacheCompanyId) : undefined);
      const purchasedBilanci =
        (cachedPackage?.purchasedBilanci && Object.keys(cachedPackage.purchasedBilanci).length > 0
          ? cachedPackage.purchasedBilanci
          : financialData?.purchasedBilanci) || {};
      const summaryBilanci = financialData?.bilanci || companyDetails?.dettaglio?.bilanci || {};
      const targetPdfYears = normalizeTargetYears(financialData?.targetYears, summaryBilanci);
      const selectedPdfYears = (
        targetPdfYears.length > 0
          ? targetPdfYears
          : Object.keys(purchasedBilanci).sort((a, b) => b.localeCompare(a))
      )
        .filter((year) => Boolean(purchasedBilanci?.[year]))
        .slice(0, 3);

      const pdfInputContent: Array<Record<string, unknown>> = [];
      for (const year of selectedPdfYears) {
        const yearEntry = purchasedBilanci?.[year];
        const yearDocuments = Array.isArray(yearEntry?.documents) ? yearEntry.documents : [];
        const pdfDocuments = yearDocuments.filter((document: any) => isStoredPdfDocument(document) && document?.storageKey);
        if (pdfDocuments.length === 0) continue;

        pdfInputContent.push({
          type: "input_text",
          text: `Bilanci ufficiali PDF allegati per l'esercizio ${year}.`,
        });

        for (const document of pdfDocuments) {
          try {
            const fileBuffer = await readStoredBilancioDocument(document);
            const mimeType = typeof document?.mimeType === "string" && document.mimeType ? document.mimeType : "application/pdf";
            const filename = document.originalName || document.filename || `bilancio-${year}.pdf`;
            pdfInputContent.push({
              type: "input_file",
              filename,
              file_data: `data:${mimeType};base64,${fileBuffer.toString("base64")}`,
            });
          } catch (error: any) {
            console.warn(`Could not load cached PDF for ${year}:`, error?.message);
          }
        }
      }
      const usingPdfAnalysis = pdfInputContent.length > 0;

      const systemPrompt = `Sei un analista finanziario senior esperto in bilanci italiani e analisi bancaria.
IMPORTANTE: I dati che riceverai sono stati scaricati da OpenAPI (Camera di Commercio / DocuEngine). Devi analizzare ESCLUSIVAMENTE quei dati: basati su cifre e numeri forniti, non inventare valori. Se un dato manca, dicalo.
Se sono presenti PDF ufficiali dei bilanci, dai priorita' assoluta ai PDF rispetto ai riepiloghi JSON.

Analizza i dati finanziari forniti e produci un'analisi dettagliata in italiano.
Rispondi ESCLUSIVAMENTE in formato JSON valido, senza testo aggiuntivo.

Il tuo output deve seguire esattamente questa struttura JSON:
{
  "summary": "Riepilogo esecutivo dell'azienda in 3-4 frasi",
  "keyMetrics": [
    {"label": "Nome KPI", "value": "Valore", "trend": "up|down|stable", "description": "Breve spiegazione"}
  ],
  "incomeStatementAnalysis": "Analisi dettagliata del conto economico con focus su ricavi, margini, EBITDA, utile netto. Minimo 4-5 paragrafi.",
  "balanceSheetAnalysis": "Analisi dello stato patrimoniale: solidità, liquidità, indebitamento. Minimo 4-5 paragrafi.",
  "cashFlowAnalysis": "Analisi dei flussi di cassa operativi, investimento, finanziamento. Minimo 4-5 paragrafi.",
  "marketComparison": "Confronto con benchmark di settore e mercato italiano. Minimo 3-4 paragrafi.",
  "strengths": ["Punto di forza 1", "Punto di forza 2", "Punto di forza 3"],
  "weaknesses": ["Debolezza 1", "Debolezza 2", "Debolezza 3"],
  "opportunities": ["Opportunità 1", "Opportunità 2", "Opportunità 3"],
  "threats": ["Minaccia 1", "Minaccia 2", "Minaccia 3"],
  "recommendations": ["Raccomandazione strategica 1", "Raccomandazione 2", "Raccomandazione 3", "Raccomandazione 4", "Raccomandazione 5"]
}`;

      const selectedSummaryBilanci = selectedPdfYears.reduce((acc, year) => {
        if (summaryBilanci?.[year]) acc[year] = summaryBilanci[year];
        return acc;
      }, {} as Record<string, any>);

      let userPrompt = usingPdfAnalysis
        ? `Analizza i PDF ufficiali dei bilanci allegati per l'azienda "${companyName}". Gli esercizi target sono: ${selectedPdfYears.join(", ")}.\n`
        : `I dati sotto sono stati scaricati da OpenAPI (dettagli azienda e/o bilancio). Analizzali e produci l'analisi richiesta.\n\nAzienda: ${companyName}\n`;

      if (companyDetails) {
        userPrompt += `\n--- Dettagli azienda (OpenAPI) ---\n${JSON.stringify(companyDetails, null, 2)}\n`;
      }

      if (financialData) {
        userPrompt += usingPdfAnalysis
          ? `\n--- Metadati di supporto sui bilanci target ---\n${JSON.stringify({
              targetYears: selectedPdfYears,
              bilanci: Object.keys(selectedSummaryBilanci).length > 0 ? selectedSummaryBilanci : summaryBilanci,
            }, null, 2)}\n`
          : `\n--- Dati finanziari / bilancio (OpenAPI / DocuEngine) ---\n${JSON.stringify(financialData, null, 2)}\n`;
      }

      if (mode === "competitor" && competitors) {
        userPrompt += `\nModalità: Analisi competitiva\nConcorrenti: ${JSON.stringify(competitors)}\n`;
        userPrompt += `\nConfronta l'azienda con i suoi competitor nel contesto del mercato italiano.\n`;
      }

      userPrompt += `\nFornisci un'analisi completa basata SOLO sui dati sopra, come farebbe un analista bancario:
1. Riclassificazione bancaria del bilancio (usando i dati forniti)
2. Almeno 6-8 KPI finanziari calcolati dai dati (ROE, ROI, ROS, Current Ratio, Debt/Equity, EBITDA margin, ecc.)
3. Confronto con medie di settore
4. Analisi SWOT basata sui numeri
5. Raccomandazioni strategiche operative concrete

Rispondi SOLO con il JSON, senza markdown o testo aggiuntivo.`;

      const analysisInput = usingPdfAnalysis
        ? [{
            role: "user",
            content: [
              { type: "input_text", text: userPrompt },
              ...pdfInputContent,
            ],
          }]
        : userPrompt;

      const analysis = await createStructuredResponse<Record<string, unknown>>({
        apiKey,
        model: getOpenaiChatModel(),
        instructions: systemPrompt,
        input: analysisInput,
        schemaName: "company_financial_analysis",
        schema: ANALYSIS_SCHEMA,
        maxOutputTokens: 12000,
        reasoningEffort: "low",
      });

      if (userId) {
        await storage.createAnalysis({
          userId,
          mode: mode || "business",
          companyName,
          companyId: companyDetails?.id || null,
          taxCode: companyDetails?.codice_fiscale || null,
          address: companyDetails?.indirizzo || null,
          status: "complete",
          companyDetails,
          financialData,
          aiAnalysis: analysis as Record<string, unknown>,
          competitors: competitors || null,
          createdAt: new Date().toISOString(),
        });
      }

      return res.json({ analysis });
    } catch (error: any) {
      if (error instanceof OpenAIResponsesError) {
        console.error("OpenAI analysis error:", error.status, error.body);
        return res.status(500).json({ error: `OpenAI: ${error.message}` });
      }
      console.error("AI analysis error:", error);
      return res.status(500).json({ error: "Errore nell'analisi AI" });
    }
  });

  // ==========================================
  // AI - Find competitors
  // ==========================================
  app.post("/api/find-competitors", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromReq(req);
      if (!userId) return res.status(401).json({ error: "Non autenticato" });

      const tier = await getUserTier(userId);
      if (!canAccessFeature(tier, "competitors")) {
        return res.status(403).json({
          error: "Funzionalità disponibile con abbonamento Pro o Business.",
          code: "PREMIUM_REQUIRED",
          requiredTier: "pro",
        });
      }

      const { companyName, companyDetails } = req.body;
      const apiKey = getOpenaiApiKey();
      if (!apiKey) {
        console.error("Find competitors: OPENAI_API_KEY mancante");
        return res.status(503).json({ error: "Chiave OpenAI non configurata." });
      }

      const prompt = `Data l'azienda italiana "${companyName}"${companyDetails?.dettaglio?.descrizione_ateco ? ` (settore: ${companyDetails.dettaglio.descrizione_ateco})` : ''}, 
identifica i 3-5 principali concorrenti italiani.

Rispondi SOLO in JSON con questa struttura:
{
  "competitors": [
    {"name": "Nome Azienda Concorrente", "reason": "Motivo per cui è un concorrente"}
  ]
}`;

      const result = await createStructuredResponse({
        apiKey,
        model: getOpenaiChatModel(),
        instructions: "Sei un esperto di mercato italiano. Rispondi solo con JSON valido.",
        input: prompt,
        schemaName: "competitor_search",
        schema: COMPETITORS_SCHEMA,
        maxOutputTokens: 1000,
        reasoningEffort: "low",
      });

      return res.json(result);
    } catch (error: any) {
      if (error instanceof OpenAIResponsesError) {
        console.error("OpenAI competitors error:", error.status, error.body);
        return res.status(500).json({ error: `OpenAI: ${error.message}` });
      }
      console.error("Find competitors error:", error);
      return res.status(500).json({ error: "Errore nella ricerca competitor" });
    }
  });

  // ==========================================
  // USER ANALYSES - history
  // ==========================================
  app.get("/api/analyses", async (req: Request, res: Response) => {
    const userId = await getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: "Non autenticato" });
    const analyses = await storage.listAnalysesByUser(userId);
    return res.json({ data: analyses.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")) });
  });

  app.get("/api/analyses/:id", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromReq(req);
      if (!userId) return res.status(401).json({ error: "Non autenticato" });

      const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const id = parseInt(idParam ?? "", 10);
      const analysis = await storage.getAnalysis(id);
      if (!analysis) return res.status(404).json({ error: "Analisi non trovata" });
      if (analysis.userId !== userId) return res.status(403).json({ error: "Accesso negato" });
      return res.json(analysis);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/analyses", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromReq(req);
      if (!userId) return res.status(401).json({ error: "Non autenticato" });

      const analysis = await storage.createAnalysis({
        ...req.body,
        userId,
      });
      return res.status(201).json(analysis);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/analyses/:id", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromReq(req);
      if (!userId) return res.status(401).json({ error: "Non autenticato" });

      const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const id = parseInt(idParam ?? "", 10);
      const existing = await storage.getAnalysis(id);
      if (!existing) return res.status(404).json({ error: "Analisi non trovata" });
      if (existing.userId !== userId) return res.status(403).json({ error: "Accesso negato" });

      const updated = await storage.updateAnalysis(id, {
        ...req.body,
        userId,
      });
      if (!updated) return res.status(404).json({ error: "Analisi non trovata" });
      return res.json(updated);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/analyses/:id", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromReq(req);
      if (!userId) return res.status(401).json({ error: "Non autenticato" });

      const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const id = parseInt(idParam ?? "", 10);
      const existing = await storage.getAnalysis(id);
      if (!existing) return res.status(404).json({ error: "Analisi non trovata" });
      if (existing.userId !== userId) return res.status(403).json({ error: "Accesso negato" });

      const deleted = await storage.deleteAnalysis(id);
      if (!deleted) return res.status(404).json({ error: "Analisi non trovata" });
      return res.status(204).send();
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });
}
