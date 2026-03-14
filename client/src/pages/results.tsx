import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import {
  ArrowLeft, Building2, MapPin, Mail, Phone, Globe, Loader2, FileText,
  CalendarDays,
  TrendingUp, TrendingDown, Minus, Target, Users, ShieldCheck, AlertTriangle, Lightbulb,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/App";
import { PoweredByAttribution } from "@/components/PoweredByAttribution";
import { PremiumGate } from "@/components/PremiumGate";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

interface ResultData {
  company: any;
  companyDetails: any;
  financialData: any;
  insights?: any;
  documentSource?: string | null;
  analysis: any;
  competitors: any;
  mode: string;
}

interface EbitdaYear {
  value: number;
  margin_pct: number;
  confidence: string;
  method: string;
}

interface EbitdaResponse {
  ebitda: Record<string, EbitdaYear>;
  revenue: Record<string, number>;
}

interface PurchasedBilancio {
  year: string;
  fetchedAt: string;
  documents: Array<{
    filename?: string;
    originalName?: string;
    mimeType?: string;
    storageKey?: string;
  }>;
  bilancioData: any;
}

interface UploadedBilancioDocument {
  id: number;
  year: string;
  fetchedAt?: string;
  documents: Array<{
    id?: number;
    filename?: string;
    originalName?: string;
    mimeType?: string;
    storageKey?: string;
    privateDocumentId?: number;
  }>;
  bilancioData: any;
}

function isBilancioOtticoBusinessSource(mode: string, source: unknown): boolean {
  return mode === "business" && typeof source === "string" && source.startsWith("bilancio-ottico-comparative-4y-v");
}

// Format large numbers
function formatCurrency(val: number): string {
  const abs = Math.abs(val);
  const sign = val < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}€${(abs / 1_000_000_000).toFixed(2)} Mld`;
  if (abs >= 1_000_000) return `${sign}€${(abs / 1_000_000).toFixed(2)} Mln`;
  if (abs >= 1_000) return `${sign}€${(abs / 1_000).toFixed(0)} K`;
  return `${sign}€${abs.toLocaleString("it-IT")}`;
}

function formatAxisValue(val: number): string {
  if (val >= 1_000_000_000) return `€${(val / 1_000_000_000).toFixed(1)}B`;
  if (val >= 1_000_000) return `€${(val / 1_000_000).toFixed(0)}M`;
  if (val >= 1_000) return `€${(val / 1_000).toFixed(0)}K`;
  return `€${val}`;
}

function formatBarValue(val: number): string {
  const abs = Math.abs(val);
  if (abs >= 1_000_000_000) return `€${(val / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `€${(val / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `€${(val / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}K`;
  return `€${val.toFixed(0)}`;
}

function formatDateTime(value?: string): string {
  if (!value) return "N/D";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("it-IT");
}

function extractYear(value?: string | null): string | null {
  if (!value) return null;

  const yearMatch = value.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) return yearMatch[0];

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return String(parsed.getFullYear());
}

function isPdfDocument(document: PurchasedBilancio["documents"][number]): boolean {
  const mimeType = (document?.mimeType || "").toLowerCase();
  const filename = (document?.filename || document?.originalName || "").toLowerCase();
  return mimeType.includes("pdf") || filename.endsWith(".pdf");
}

function isStructuredBilancioDocument(document: PurchasedBilancio["documents"][number]): boolean {
  const mimeType = (document?.mimeType || "").toLowerCase();
  const filename = (document?.filename || document?.originalName || "").toLowerCase();
  return (
    mimeType.includes("json") ||
    mimeType.includes("xml") ||
    filename.endsWith(".json") ||
    filename.endsWith(".xml") ||
    filename.endsWith(".xbrl")
  );
}

function getBilancioDocumentBadge(document: PurchasedBilancio["documents"][number]): string {
  const mimeType = (document?.mimeType || "").toLowerCase();
  const filename = (document?.filename || document?.originalName || "").toLowerCase();
  if (isPdfDocument(document)) return "PDF";
  if (isStructuredBilancioDocument(document)) return "XBRL";
  if (mimeType.includes("zip") || filename.endsWith(".zip")) return "ZIP";
  return "FILE";
}

interface ChartData {
  years: string[];
  revenues: number[];
  ebitdas: number[];
  ebitdaDetails: Record<string, EbitdaYear>;
  bilanci: Record<string, any>;
}

interface CashFlowTableRow {
  key: string;
  label: string;
  type: "currency" | "percent" | "days" | "multiple";
  values: Array<number | null>;
  emphasize?: boolean;
  secondary?: boolean;
}

interface SummaryStatItem {
  label: string;
  value: string;
  hint?: string;
}

interface CeoPriorityItem {
  title: string;
  action: string;
  whyItMatters: string;
  evidence: string;
  impactArea: "cash" | "margin" | "risk" | "growth";
  urgency: "30d" | "90d" | "180d";
}

interface CeoBriefData {
  status: "strong" | "watch" | "critical";
  headline: string;
  verdict: string;
  watchouts: string[];
  topPriorities: CeoPriorityItem[];
}

interface KeyProductItem {
  name: string;
  tagline: string | null;
  imageUrl: string | null;
  pageUrl: string | null;
}

function formatMarginLabel(marginPct?: number | null): string {
  if (typeof marginPct !== "number" || !Number.isFinite(marginPct)) return "N/D";
  return `${marginPct.toFixed(1)}%`;
}

function isFiniteNumeric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function calculateMarginPercent(value: unknown, revenue: unknown): number | null {
  if (!isFiniteNumeric(value) || !isFiniteNumeric(revenue) || revenue === 0) return null;
  return (value / revenue) * 100;
}

function formatFinancialTableMillions(value: unknown): string {
  if (!isFiniteNumeric(value)) return "NA";
  const normalized = value / 1_000_000;
  const formatted = Math.abs(normalized).toFixed(1);
  return normalized < 0 ? `(${formatted})` : formatted;
}

function formatFinancialTablePercent(value: unknown): string {
  if (!isFiniteNumeric(value)) return "NA";
  const formatted = `${Math.abs(value).toFixed(1)}%`;
  return value < 0 ? `(${formatted})` : formatted;
}

function formatFinancialTableDays(value: unknown): string {
  if (!isFiniteNumeric(value)) return "NA";
  const formatted = `${Math.round(Math.abs(value))}`;
  return value < 0 ? `(${formatted})` : formatted;
}

function formatFinancialTableMultiple(value: unknown): string {
  if (!isFiniteNumeric(value)) return "NA";
  const formatted = `${Math.abs(value).toFixed(1)}x`;
  return value < 0 ? `(${formatted})` : formatted;
}

function formatMetricValue(value: unknown, kind: "currency" | "percent" | "multiple" | "days"): string {
  if (!isFiniteNumeric(value)) return "N/D";
  if (kind === "currency") return formatCurrency(value);
  if (kind === "multiple") return `${value.toFixed(2)}x`;
  if (kind === "days") return `${Math.round(value)} gg`;
  return `${value.toFixed(1)}%`;
}

function averageNumeric(values: Array<number | null | undefined>): number | null {
  const valid = values.filter((value): value is number => isFiniteNumeric(value));
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function formatSummaryStatValue(value: number | null, kind: "percent" | "days" | "multiple"): string {
  if (!isFiniteNumeric(value)) return "N/D";
  if (kind === "days") return `${Math.round(value)} gg`;
  if (kind === "multiple") return `${value.toFixed(1)}x`;
  return `${value.toFixed(1)}%`;
}

function calculateSafePercentage(value: unknown, base: unknown): number | null {
  if (!isFiniteNumeric(value) || !isFiniteNumeric(base) || base === 0) return null;
  return (value / base) * 100;
}

function calculatePerEmployeeValue(value: unknown, employees: unknown): number | null {
  if (!isFiniteNumeric(value) || !isFiniteNumeric(employees) || employees <= 0) return null;
  return value / employees;
}

function buildLocalBusinessCeoBriefFromBilanci(bilanci: Record<string, any>): CeoBriefData | null {
  const years = Object.keys(bilanci || {})
    .filter((year) => {
      const row = bilanci?.[year];
      return row && typeof row === "object" && row.status !== "missing";
    })
    .sort((a, b) => b.localeCompare(a));

  if (years.length === 0) return null;

  const latestYear = years[0];
  const previousYear = years[1] || null;
  const latest = bilanci[latestYear] || {};
  const previous = previousYear ? bilanci[previousYear] || {} : null;

  const revenueGrowth = previous
    ? calculateSafePercentage((latest?.fatturato ?? 0) - (previous?.fatturato ?? 0), previous?.fatturato)
    : null;
  const ebitdaMargin = calculateSafePercentage(latest?.ebitda, latest?.fatturato);
  const cashConversion = latest?.cash_conversion ?? calculateSafePercentage(latest?.unlevered_free_cash_flow, latest?.ebitda);
  const personnelCostPctRevenue = calculateSafePercentage(latest?.costo_personale, latest?.fatturato);
  const revenuePerEmployee = calculatePerEmployeeValue(latest?.fatturato, latest?.dipendenti);
  const taxesPctEbitda = calculateSafePercentage(latest?.taxes, latest?.ebitda);
  const capexPctRevenue = calculateSafePercentage(latest?.capex, latest?.fatturato);
  const changeNwcPctRevenue = calculateSafePercentage(latest?.change_nwc, latest?.fatturato);

  let pressureScore = 0;
  if (isFiniteNumeric(revenueGrowth) && revenueGrowth < 0) pressureScore += 2;
  else if (isFiniteNumeric(revenueGrowth) && revenueGrowth < 5) pressureScore += 1;
  if (isFiniteNumeric(ebitdaMargin) && ebitdaMargin < 8) pressureScore += 2;
  else if (isFiniteNumeric(ebitdaMargin) && ebitdaMargin < 12) pressureScore += 1;
  if (isFiniteNumeric(cashConversion) && cashConversion < 40) pressureScore += 2;
  else if (isFiniteNumeric(cashConversion) && cashConversion < 60) pressureScore += 1;

  const status: CeoBriefData["status"] = pressureScore >= 4 ? "critical" : pressureScore >= 2 ? "watch" : "strong";
  const headline =
    status === "critical"
      ? "La cassa non e' abbastanza protetta: crescita, margine e conversione vanno riallineati."
      : status === "watch"
        ? "Il business va guidato piu' duramente su crescita, EBITDA margin e cash conversion."
        : "Il business tiene, ma la cassa si difende solo con disciplina sulle tre leve chiave.";
  const verdict = `Nel ${latestYear} la lettura corretta e': crescita ${isFiniteNumeric(revenueGrowth) ? `${revenueGrowth.toFixed(1)}%` : "N/D"}, EBITDA margin ${isFiniteNumeric(ebitdaMargin) ? `${ebitdaMargin.toFixed(1)}%` : "N/D"}, cash conversion ${isFiniteNumeric(cashConversion) ? `${cashConversion.toFixed(1)}%` : "N/D"}.`;

  const cashLeakLabel =
    isFiniteNumeric(changeNwcPctRevenue) && changeNwcPctRevenue > Math.max(capexPctRevenue ?? 0, taxesPctEbitda ?? 0)
      ? "circolante"
      : isFiniteNumeric(capexPctRevenue) && capexPctRevenue > Math.max(changeNwcPctRevenue ?? 0, taxesPctEbitda ?? 0)
        ? "capex"
        : isFiniteNumeric(taxesPctEbitda) && taxesPctEbitda > 0
          ? "imposte"
          : "conversione operativa";

  const growthPriority: CeoPriorityItem = {
    title:
      isFiniteNumeric(revenueGrowth) && revenueGrowth < 0
        ? "Rimettere in moto una crescita che non distrugga cassa"
        : "Accelerare la crescita dove prezzo e cassa reggono",
    action: "Concentra lo sforzo commerciale su linee, clienti e canali che mantengono pricing, margine e assorbimento di circolante sotto controllo; evita volume che allarga solo il fabbisogno.",
    whyItMatters: "La crescita conta solo se aumenta l'EBITDA e non consuma piu' cassa di quella che crea.",
    evidence: `Ricavi ${latestYear}: ${isFiniteNumeric(latest?.fatturato) ? formatCurrency(latest.fatturato) : "N/D"}; crescita ricavi ${latestYear}: ${isFiniteNumeric(revenueGrowth) ? `${revenueGrowth.toFixed(1)}%` : "N/D"}.`,
    impactArea: "growth",
    urgency: isFiniteNumeric(revenueGrowth) && revenueGrowth < 0 ? "30d" : "90d",
  };

  const marginPriority: CeoPriorityItem = {
    title: "Alzare l'EBITDA margin con pricing, produttivita' e cost base",
    action: "Verifica se il margine va recuperato da repricing, mix migliore, taglio costi, redesign dell'organizzazione, AI, outsourcing o riduzione selettiva dell'organico dove la produttivita' e' debole.",
    whyItMatters: "Se il margine resta troppo basso, ogni euro di ricavo aggiuntivo genera poco valore e poca autofinanziabilita'.",
    evidence: `EBITDA margin ${latestYear}: ${isFiniteNumeric(ebitdaMargin) ? `${ebitdaMargin.toFixed(1)}%` : "N/D"}; costo personale / ricavi ${latestYear}: ${isFiniteNumeric(personnelCostPctRevenue) ? `${personnelCostPctRevenue.toFixed(1)}%` : "N/D"}; ricavi per dipendente ${latestYear}: ${isFiniteNumeric(revenuePerEmployee) ? formatCurrency(revenuePerEmployee) : "N/D"}.`,
    impactArea: "margin",
    urgency:
      (isFiniteNumeric(ebitdaMargin) && ebitdaMargin < 10) ||
      (isFiniteNumeric(personnelCostPctRevenue) && personnelCostPctRevenue > 20)
        ? "30d"
        : "90d",
  };

  const cashPriority: CeoPriorityItem = {
    title: "Chiudere la perdita di cassa nella cash conversion",
    action:
      cashLeakLabel === "circolante"
        ? "Attacca subito crediti, scorte e termini fornitori con target di rilascio cassa e ownership operativa chiara."
        : cashLeakLabel === "capex"
          ? "Taglia o rinvia capex non essenziali e valuta modelli piu' asset-light o outsourcing dove il capitale investito rende poco."
          : cashLeakLabel === "imposte"
            ? "Apri una revisione fiscale con specialisti per capire se il tax cash-out e' ottimizzabile con incentivi, crediti o una struttura piu' efficiente."
            : "Scomponi la cash conversion tra circolante, capex e imposte e assegna una leva concreta a ciascuna perdita di cassa.",
    whyItMatters: "La cassa non si misura con l'EBITDA ma con quanto EBITDA riesci davvero a trasformare in UFCF.",
    evidence: `Cash conversion ${latestYear}: ${isFiniteNumeric(cashConversion) ? `${cashConversion.toFixed(1)}%` : "N/D"}; NWC / ricavi ${latestYear}: ${isFiniteNumeric(latest?.nwc_pct_revenue) ? `${latest.nwc_pct_revenue.toFixed(1)}%` : "N/D"}; capex / ricavi ${latestYear}: ${isFiniteNumeric(capexPctRevenue) ? `${capexPctRevenue.toFixed(1)}%` : "N/D"}; taxes / EBITDA ${latestYear}: ${isFiniteNumeric(taxesPctEbitda) ? `${taxesPctEbitda.toFixed(1)}%` : "N/D"}.`,
    impactArea: "cash",
    urgency: isFiniteNumeric(cashConversion) && cashConversion < 60 ? "30d" : "90d",
  };

  const watchouts = [
    `Growth ${latestYear}: ${isFiniteNumeric(revenueGrowth) ? `${revenueGrowth.toFixed(1)}%` : "N/D"}.`,
    `EBITDA margin ${latestYear}: ${isFiniteNumeric(ebitdaMargin) ? `${ebitdaMargin.toFixed(1)}%` : "N/D"} con ricavi per dipendente ${isFiniteNumeric(revenuePerEmployee) ? formatCurrency(revenuePerEmployee) : "N/D"}.`,
    `Cash conversion ${latestYear}: ${isFiniteNumeric(cashConversion) ? `${cashConversion.toFixed(1)}%` : "N/D"}; perdita principale su ${cashLeakLabel}.`,
  ];

  return {
    status,
    headline,
    verdict,
    watchouts,
    topPriorities: [growthPriority, marginPriority, cashPriority],
  };
}

function getBenchmarkStatusTone(status: string | undefined) {
  if (status === "above") {
    return {
      badge: "Sopra",
      className: "border-emerald-200 bg-emerald-50 text-emerald-700",
    };
  }
  if (status === "below") {
    return {
      badge: "Sotto",
      className: "border-rose-200 bg-rose-50 text-rose-700",
    };
  }
  if (status === "in_line") {
    return {
      badge: "In linea",
      className: "border-sky-200 bg-sky-50 text-sky-700",
    };
  }
  return {
    badge: "Parziale",
    className: "border-slate-200 bg-slate-50 text-slate-600",
  };
}

function getCeoBriefTone(status: string | undefined) {
  if (status === "strong") {
    return {
      badge: "Solida",
      className: "border-emerald-200 bg-emerald-50 text-emerald-700",
      accentClassName: "from-emerald-500/10 via-emerald-500/5 to-transparent",
    };
  }
  if (status === "critical") {
    return {
      badge: "Critica",
      className: "border-rose-200 bg-rose-50 text-rose-700",
      accentClassName: "from-rose-500/10 via-rose-500/5 to-transparent",
    };
  }
  return {
    badge: "Da presidiare",
    className: "border-amber-200 bg-amber-50 text-amber-700",
    accentClassName: "from-amber-500/10 via-amber-500/5 to-transparent",
  };
}

function getImpactAreaTone(impactArea: string | undefined) {
  if (impactArea === "cash") {
    return {
      label: "Cassa",
      className: "border-sky-200 bg-sky-50 text-sky-700",
    };
  }
  if (impactArea === "margin") {
    return {
      label: "Margine",
      className: "border-emerald-200 bg-emerald-50 text-emerald-700",
    };
  }
  if (impactArea === "risk") {
    return {
      label: "Rischio",
      className: "border-rose-200 bg-rose-50 text-rose-700",
    };
  }
  return {
    label: "Crescita",
    className: "border-violet-200 bg-violet-50 text-violet-700",
  };
}

function getUrgencyTone(urgency: string | undefined) {
  if (urgency === "30d") {
    return {
      label: "30 giorni",
      className: "border-rose-200 bg-rose-50 text-rose-700",
    };
  }
  if (urgency === "180d") {
    return {
      label: "180 giorni",
      className: "border-slate-200 bg-slate-50 text-slate-600",
    };
  }
  return {
    label: "90 giorni",
    className: "border-amber-200 bg-amber-50 text-amber-700",
  };
}

function mapRecommendationThemeToImpactArea(theme: unknown): CeoPriorityItem["impactArea"] {
  if (theme === "margini_pricing") return "margin";
  if (theme === "capitale_circolante" || theme === "allocazione_capitale") return "cash";
  if (theme === "debito_struttura") return "risk";
  return "growth";
}

function mapRecommendationPriorityToUrgency(priority: unknown): CeoPriorityItem["urgency"] {
  if (priority === "high") return "30d";
  if (priority === "medium") return "90d";
  return "180d";
}

function buildFallbackBusinessCeoBrief(recommendations: any[], workingCapitalDebt: any): CeoBriefData | null {
  const normalizedRecommendations = Array.isArray(recommendations)
    ? recommendations
        .filter((item) => item && typeof item === "object")
        .slice(0, 3)
        .map((item, index) => ({
          title: typeof item?.title === "string" && item.title.trim() ? item.title.trim() : `Priorita' ${index + 1}`,
          action: typeof item?.description === "string" ? item.description.trim() : "",
          whyItMatters: typeof item?.rationale === "string" ? item.rationale.trim() : "",
          evidence: typeof item?.evidence === "string" ? item.evidence.trim() : "",
          impactArea: mapRecommendationThemeToImpactArea(item?.theme),
          urgency: mapRecommendationPriorityToUrgency(item?.priority),
        }))
    : [];

  if (normalizedRecommendations.length === 0) return null;

  const highPriorityCount = normalizedRecommendations.filter((item) => item.urgency === "30d").length;
  const status: CeoBriefData["status"] = highPriorityCount >= 2 ? "critical" : highPriorityCount === 1 ? "watch" : "strong";
  const headline =
    status === "critical"
      ? "Serve una correzione rapida: la priorita' e' recuperare controllo su cassa e execution."
      : status === "watch"
        ? "Il business regge, ma richiede priorita' nette su margine, cassa o rischio."
        : "Il business appare ordinato, con alcune leve chiare per difendere il vantaggio.";
  const verdictSource =
    typeof workingCapitalDebt?.summary === "string" && workingCapitalDebt.summary.trim()
      ? workingCapitalDebt.summary.trim()
      : normalizedRecommendations[0]?.whyItMatters || "";
  const watchouts = Array.isArray(workingCapitalDebt?.bullets) && workingCapitalDebt.bullets.length > 0
    ? workingCapitalDebt.bullets.filter((item: unknown) => typeof item === "string" && item.trim()).slice(0, 3)
    : normalizedRecommendations.map((item) => item.title).slice(0, 3);

  return {
    status,
    headline,
    verdict: verdictSource || "Le priorita' manageriali sono guidate dai numeri oggi disponibili.",
    watchouts,
    topPriorities: normalizedRecommendations,
  };
}

function normalizeBusinessCeoBrief(raw: any, fallback: CeoBriefData | null): CeoBriefData | null {
  if ((!raw || typeof raw !== "object") && !fallback) return null;

  const source = raw && typeof raw === "object" ? raw : {};
  const fallbackPriorities = fallback?.topPriorities || [];
  const rawPriorities = Array.isArray(source.topPriorities) && source.topPriorities.length === 3
    ? source.topPriorities
    : fallbackPriorities;
  const topPriorities = rawPriorities
    .map((item: any, index: number) => ({
      title: typeof item?.title === "string" && item.title.trim() ? item.title.trim() : fallbackPriorities[index]?.title || `Priorita' ${index + 1}`,
      action: typeof item?.action === "string" && item.action.trim() ? item.action.trim() : fallbackPriorities[index]?.action || "",
      whyItMatters:
        typeof item?.whyItMatters === "string" && item.whyItMatters.trim()
          ? item.whyItMatters.trim()
          : fallbackPriorities[index]?.whyItMatters || "",
      evidence: typeof item?.evidence === "string" && item.evidence.trim() ? item.evidence.trim() : fallbackPriorities[index]?.evidence || "",
      impactArea:
        item?.impactArea === "cash" || item?.impactArea === "margin" || item?.impactArea === "risk" || item?.impactArea === "growth"
          ? item.impactArea
          : fallbackPriorities[index]?.impactArea || "growth",
      urgency:
        item?.urgency === "30d" || item?.urgency === "90d" || item?.urgency === "180d"
          ? item.urgency
          : fallbackPriorities[index]?.urgency || "90d",
    }))
    .slice(0, 3);

  if (topPriorities.length === 0) return fallback;

  const fallbackStatus = fallback?.status || "watch";
  return {
    status:
      source?.status === "strong" || source?.status === "watch" || source?.status === "critical"
        ? source.status
        : fallbackStatus,
    headline:
      typeof source?.headline === "string" && source.headline.trim()
        ? source.headline.trim()
        : fallback?.headline || topPriorities[0]?.title || "CEO Brief",
    verdict:
      typeof source?.verdict === "string" && source.verdict.trim()
        ? source.verdict.trim()
        : fallback?.verdict || "",
    watchouts: Array.isArray(source?.watchouts) && source.watchouts.length > 0
      ? source.watchouts.filter((item: unknown) => typeof item === "string" && item.trim()).slice(0, 3)
      : fallback?.watchouts || [],
    topPriorities,
  };
}

function normalizeKeyProducts(products: unknown): KeyProductItem[] {
  if (!Array.isArray(products)) return [];
  return products
    .filter((item) => item && typeof item === "object" && typeof (item as any).name === "string" && (item as any).name.trim())
    .slice(0, 4)
    .map((item: any) => ({
      name: item.name.trim(),
      tagline: typeof item?.tagline === "string" && item.tagline.trim() ? item.tagline.trim() : null,
      imageUrl: typeof item?.imageUrl === "string" && item.imageUrl.trim() ? item.imageUrl.trim() : null,
      pageUrl: typeof item?.pageUrl === "string" && item.pageUrl.trim() ? item.pageUrl.trim() : null,
    }));
}

function mergeBilanciMaps(
  bilanciFromDetails: Record<string, any>,
  bilanciFromFinancial: Record<string, any>,
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

function FinancialTableCard({
  title,
  note,
  years,
  rows,
  testId,
  summaryItems,
  showTable = true,
}: {
  title: string;
  note: string;
  years: string[];
  rows: CashFlowTableRow[];
  testId: string;
  summaryItems?: SummaryStatItem[];
  showTable?: boolean;
}) {
  const hasSummary = Array.isArray(summaryItems) && summaryItems.length > 0;
  const hasTable = showTable && years.length > 0 && rows.length > 0;
  if (!hasSummary && !hasTable) return null;

  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {Array.isArray(summaryItems) && summaryItems.length > 0 && (
          <div className="mb-6 grid gap-3 md:grid-cols-4">
            {summaryItems.map((item) => (
              <div
                key={`${testId}-${item.label}`}
                className="rounded-2xl border border-border/60 bg-slate-50/70 px-4 py-4"
              >
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  {item.label}
                </div>
                <div className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
                  {item.value}
                </div>
                {item.hint && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {item.hint}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {hasTable && (
          <div className="overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-y-1 text-sm">
              <thead>
                <tr>
                  <th className="px-4 pb-4 text-left align-bottom">
                    <div className="text-sm font-semibold text-foreground">FYE (31-Dec)</div>
                    <div className="pt-0.5 text-xs italic text-muted-foreground">{note}</div>
                  </th>
                  {years.map((year) => (
                    <th
                      key={`${testId}-head-${year}`}
                      className="px-4 pb-4 text-right align-bottom text-sm font-semibold text-foreground"
                    >
                      {year}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <th
                      className={`px-4 py-0.5 text-left ${
                        row.secondary
                          ? "pl-8 font-normal italic text-muted-foreground"
                          : row.emphasize
                            ? "font-semibold text-foreground"
                            : "font-medium text-foreground"
                      }`}
                    >
                      {row.label}
                    </th>
                    {row.values.map((value, index) => (
                      <td
                        key={`${row.key}-${years[index]}`}
                        className={`px-4 py-0.5 text-right tabular-nums ${
                          row.secondary
                            ? "italic text-muted-foreground"
                            : row.emphasize
                              ? "font-semibold text-foreground"
                              : "text-foreground/90"
                        }`}
                      >
                        {row.type === "percent"
                          ? formatFinancialTablePercent(value)
                          : row.type === "days"
                            ? formatFinancialTableDays(value)
                            : row.type === "multiple"
                              ? formatFinancialTableMultiple(value)
                              : formatFinancialTableMillions(value)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BusinessCeoBriefCard({ ceoBrief }: { ceoBrief: CeoBriefData }) {
  const tone = getCeoBriefTone(ceoBrief.status);

  return (
    <Card data-testid="section-ceo-brief" className="overflow-hidden border-border/70">
      <CardHeader className={`relative gap-4 bg-gradient-to-br ${tone.accentClassName}`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${tone.className}`}>
                {tone.badge}
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                <Lightbulb className="h-3.5 w-3.5" />
                CEO Brief
              </span>
            </div>
            <div>
              <CardTitle className="text-2xl leading-tight text-foreground sm:text-3xl">
                {ceoBrief.headline}
              </CardTitle>
              {ceoBrief.verdict && (
                <p className="mt-3 max-w-2xl text-sm leading-6 text-foreground/80">
                  {ceoBrief.verdict}
                </p>
              )}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6 pt-6">
        {ceoBrief.watchouts.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-3">
            {ceoBrief.watchouts.map((item, index) => (
              <div
                key={`${item}-${index}`}
                className="rounded-2xl border border-border/60 bg-slate-50/70 px-4 py-4"
              >
                <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Watchout {index + 1}
                </div>
                <p className="mt-2 text-sm leading-6 text-foreground/85">{item}</p>
              </div>
            ))}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          {ceoBrief.topPriorities.map((priority, index) => {
            const impactTone = getImpactAreaTone(priority.impactArea);
            const urgencyTone = getUrgencyTone(priority.urgency);

            return (
              <div
                key={`${priority.title}-${index}`}
                className="rounded-3xl border border-border/70 bg-card p-5 shadow-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {index + 1}
                  </span>
                  <span className={`rounded-full border px-3 py-1 text-[11px] font-medium ${impactTone.className}`}>
                    {impactTone.label}
                  </span>
                  <span className={`rounded-full border px-3 py-1 text-[11px] font-medium ${urgencyTone.className}`}>
                    {urgencyTone.label}
                  </span>
                </div>
                <div className="mt-4 text-lg font-semibold leading-snug text-foreground">
                  {priority.title}
                </div>
                <div className="mt-4 space-y-4">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      Cosa fare
                    </div>
                    <p className="mt-1 text-sm leading-6 text-foreground/85">{priority.action}</p>
                  </div>
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      Perche' conta
                    </div>
                    <p className="mt-1 text-sm leading-6 text-foreground/80">{priority.whyItMatters}</p>
                  </div>
                  <div className="rounded-2xl border border-border/60 bg-slate-50/70 px-4 py-3">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      Evidenza
                    </div>
                    <p className="mt-1 text-xs leading-5 text-foreground/80">{priority.evidence}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function BusinessSnapshotCard({
  descriptionText,
  aiDescriptionSources,
  keyProducts,
}: {
  descriptionText: string;
  aiDescriptionSources: Array<{ title?: string; url: string }>;
  keyProducts: KeyProductItem[];
}) {
  if (!descriptionText && keyProducts.length === 0) return null;

  return (
    <Card data-testid="section-business-snapshot">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Business Snapshot
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {descriptionText && (
          <p className="whitespace-pre-line text-sm leading-7 text-foreground/90">
            {descriptionText}
          </p>
        )}

        {keyProducts.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2">
            {keyProducts.map((item, index) => (
              <div
                key={`${item.name}-${index}`}
                className="rounded-2xl border border-border/60 bg-slate-50/60 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      Focus {index + 1}
                    </div>
                    <div className="mt-2 text-base font-semibold text-foreground">{item.name}</div>
                    {item.tagline && (
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.tagline}</p>
                    )}
                  </div>
                  {item.pageUrl && (
                    <a
                      href={item.pageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 rounded-full border border-border/60 px-3 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                    >
                      Fonte
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {aiDescriptionSources.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {aiDescriptionSources.map((source: any, index: number) => (
              <a
                key={`${source.url}-${index}`}
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center rounded-full border border-border/60 px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                {typeof source?.title === "string" && source.title.trim() ? source.title : `Fonte ${index + 1}`}
              </a>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LegacyAnalysisSections({ analysis, isPremium }: { analysis: any; isPremium: boolean }) {
  if (!analysis || typeof analysis !== "object") return null;

  return (
    <>
      {Array.isArray(analysis?.keyMetrics) && analysis.keyMetrics.length > 0 && (
        <Card data-testid="section-key-metrics">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Indicatori Chiave
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {analysis.keyMetrics.map((metric: any, i: number) => (
                <div key={i} className="rounded-lg border border-border/60 p-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{metric.label}</span>
                    {metric.trend === "up" && <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />}
                    {metric.trend === "down" && <TrendingDown className="h-3.5 w-3.5 text-red-500" />}
                    {metric.trend === "stable" && <Minus className="h-3.5 w-3.5 text-muted-foreground" />}
                  </div>
                  <div className="text-lg font-bold">{metric.value}</div>
                  {metric.description && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{metric.description}</p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {analysis?.summary && (
        <Card data-testid="section-ai-summary">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Sintesi Analisi AI
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/90">{analysis.summary}</p>
          </CardContent>
        </Card>
      )}

      {analysis?.incomeStatementAnalysis && (
        <Card data-testid="section-income-statement">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Analisi Conto Economico
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/90">{analysis.incomeStatementAnalysis}</p>
          </CardContent>
        </Card>
      )}

      {analysis?.balanceSheetAnalysis && (
        <Card data-testid="section-balance-sheet">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Analisi Stato Patrimoniale
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/90">{analysis.balanceSheetAnalysis}</p>
          </CardContent>
        </Card>
      )}

      {analysis?.cashFlowAnalysis && (
        <Card data-testid="section-cash-flow-analysis">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Analisi Cash Flow
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/90">{analysis.cashFlowAnalysis}</p>
          </CardContent>
        </Card>
      )}

      {(analysis?.strengths?.length > 0 || analysis?.weaknesses?.length > 0 || analysis?.opportunities?.length > 0 || analysis?.threats?.length > 0) && (
        <PremiumGate isUnlocked={isPremium} featureLabel="Analisi SWOT">
          <Card data-testid="section-swot">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Analisi SWOT
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {analysis.strengths?.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-emerald-600">
                      <ShieldCheck className="h-4 w-4" />
                      <span className="text-xs font-semibold uppercase">Punti di Forza</span>
                    </div>
                    <ul className="space-y-1.5">
                      {analysis.strengths.map((item: string, index: number) => (
                        <li key={index} className="flex gap-2 text-sm text-foreground/90">
                          <span className="mt-1 shrink-0 text-emerald-500">+</span>
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {analysis.weaknesses?.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-red-500">
                      <AlertTriangle className="h-4 w-4" />
                      <span className="text-xs font-semibold uppercase">Punti di Debolezza</span>
                    </div>
                    <ul className="space-y-1.5">
                      {analysis.weaknesses.map((item: string, index: number) => (
                        <li key={index} className="flex gap-2 text-sm text-foreground/90">
                          <span className="mt-1 shrink-0 text-red-400">-</span>
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {analysis.opportunities?.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-blue-500">
                      <Target className="h-4 w-4" />
                      <span className="text-xs font-semibold uppercase">Opportunita'</span>
                    </div>
                    <ul className="space-y-1.5">
                      {analysis.opportunities.map((item: string, index: number) => (
                        <li key={index} className="flex gap-2 text-sm text-foreground/90">
                          <span className="mt-1 shrink-0 text-blue-400">*</span>
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {analysis.threats?.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-amber-500">
                      <AlertTriangle className="h-4 w-4" />
                      <span className="text-xs font-semibold uppercase">Minacce</span>
                    </div>
                    <ul className="space-y-1.5">
                      {analysis.threats.map((item: string, index: number) => (
                        <li key={index} className="flex gap-2 text-sm text-foreground/90">
                          <span className="mt-1 shrink-0 text-amber-400">!</span>
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </PremiumGate>
      )}

      {analysis?.recommendations?.length > 0 && (
        <PremiumGate isUnlocked={isPremium} featureLabel="Raccomandazioni Strategiche">
          <Card data-testid="section-recommendations">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Raccomandazioni Strategiche
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                {analysis.recommendations.map((rec: string, index: number) => (
                  <li key={index} className="flex gap-3 text-sm text-foreground/90">
                    <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                      {index + 1}
                    </div>
                    {rec}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </PremiumGate>
      )}

      {analysis?.marketComparison && (
        <PremiumGate isUnlocked={isPremium} featureLabel="Confronto di Mercato">
          <Card data-testid="section-market-comparison">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Confronto di Mercato
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/90">{analysis.marketComparison}</p>
            </CardContent>
          </Card>
        </PremiumGate>
      )}
    </>
  );
}

// Revenue vs EBITDA Chart with proper tooltip
function RevenueEbitdaChart({ chartData }: { chartData: ChartData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { years, revenues, ebitdas, ebitdaDetails } = chartData;

  const drawChart = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || years.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = rect.height;
    const padLeft = 65;
    const padRight = 16;
    const padTop = 52;
    const padBottom = 48;
    const chartW = W - padLeft - padRight;
    const chartH = H - padTop - padBottom;

    ctx.clearRect(0, 0, W, H);

    const allVals = [...revenues, ...ebitdas].filter(v => v > 0);
    const maxVal = allVals.length > 0 ? Math.max(...allVals) * 1.15 : 100000;

    // Grid
    const gridLines = 4;
    for (let i = 0; i <= gridLines; i++) {
      const y = padTop + (chartH / gridLines) * i;
      const val = maxVal - (maxVal / gridLines) * i;

      ctx.strokeStyle = "rgba(128,128,128,0.12)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.moveTo(padLeft, y);
      ctx.lineTo(W - padRight, y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "rgba(128,128,128,0.55)";
      ctx.font = "10px 'General Sans', system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(formatAxisValue(val), padLeft - 8, y);
    }

    // Bars
    const n = years.length;
    const groupW = chartW / n;
    const maxBarW = 28;
    const barW = Math.min(Math.max(groupW * 0.28, 8), maxBarW);
    const gap = Math.max(barW * 0.2, 2);
    const radius = Math.min(3, barW / 2);
    const pillHeight = 24;
    const labelGap = 7;
    const labelFont = "600 10px 'General Sans', system-ui, sans-serif";
    const pillVerticalGap = 22;
    const highestSeriesValue = Math.max(...allVals, 0);
    const highestBarY =
      highestSeriesValue > 0
        ? padTop + chartH - Math.max((highestSeriesValue / maxVal) * chartH, 2)
        : padTop + 8;
    const sharedPillY = Math.max(8, highestBarY - pillHeight - pillVerticalGap);

    years.forEach((year, i) => {
      const gcx = padLeft + groupW * i + groupW / 2;
      const baseline = padTop + chartH;

      // Revenue bar (blue)
      const revH = revenues[i] > 0 ? Math.max((revenues[i] / maxVal) * chartH, 2) : 0;
      const revX = gcx - barW - gap / 2;
      const revY = baseline - revH;

      if (revH > 0) {
        ctx.fillStyle = "#3B82F6";
        ctx.beginPath();
        ctx.moveTo(revX, baseline);
        ctx.lineTo(revX, revY + radius);
        ctx.quadraticCurveTo(revX, revY, revX + radius, revY);
        ctx.lineTo(revX + barW - radius, revY);
        ctx.quadraticCurveTo(revX + barW, revY, revX + barW, revY + radius);
        ctx.lineTo(revX + barW, baseline);
        ctx.closePath();
        ctx.fill();
      }

      // EBITDA bar (orange)
      const ebitdaH = ebitdas[i] > 0 ? Math.max((ebitdas[i] / maxVal) * chartH, 2) : 0;
      const ebitdaX = gcx + gap / 2;
      const ebitdaY = baseline - ebitdaH;

      if (ebitdaH > 0) {
        ctx.fillStyle = "#F59E0B";
        ctx.beginPath();
        ctx.moveTo(ebitdaX, baseline);
        ctx.lineTo(ebitdaX, ebitdaY + radius);
        ctx.quadraticCurveTo(ebitdaX, ebitdaY, ebitdaX + radius, ebitdaY);
        ctx.lineTo(ebitdaX + barW - radius, ebitdaY);
        ctx.quadraticCurveTo(ebitdaX + barW, ebitdaY, ebitdaX + barW, ebitdaY + radius);
        ctx.lineTo(ebitdaX + barW, baseline);
        ctx.closePath();
        ctx.fill();
      }

      ctx.save();
      ctx.fillStyle = "rgba(15, 23, 42, 0.82)";
      ctx.font = labelFont;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      if (revH > 0) {
        ctx.fillText(formatBarValue(revenues[i]), revX + barW / 2, revY - labelGap);
      }
      if (ebitdaH > 0) {
        ctx.fillText(formatBarValue(ebitdas[i]), ebitdaX + barW / 2, ebitdaY - labelGap);
      }
      ctx.restore();

      const detail = ebitdaDetails[year];
      const fallbackMargin =
        revenues[i] > 0 && Number.isFinite(ebitdas[i])
          ? (ebitdas[i] / revenues[i]) * 100
          : null;
      const marginLabel = formatMarginLabel(detail?.margin_pct ?? fallbackMargin);
      const pillFont = "600 11px 'General Sans', system-ui, sans-serif";
      ctx.font = pillFont;
      const textWidth = ctx.measureText(marginLabel).width;
      const pillWidth = Math.max(56, textWidth + 18);
      const pillX = gcx - pillWidth / 2;
      const pillRadius = pillHeight / 2;

      ctx.save();
      ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
      ctx.strokeStyle = "rgba(148, 163, 184, 0.45)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(pillX + pillRadius, sharedPillY);
      ctx.lineTo(pillX + pillWidth - pillRadius, sharedPillY);
      ctx.quadraticCurveTo(pillX + pillWidth, sharedPillY, pillX + pillWidth, sharedPillY + pillRadius);
      ctx.lineTo(pillX + pillWidth, sharedPillY + pillHeight - pillRadius);
      ctx.quadraticCurveTo(pillX + pillWidth, sharedPillY + pillHeight, pillX + pillWidth - pillRadius, sharedPillY + pillHeight);
      ctx.lineTo(pillX + pillRadius, sharedPillY + pillHeight);
      ctx.quadraticCurveTo(pillX, sharedPillY + pillHeight, pillX, sharedPillY + pillHeight - pillRadius);
      ctx.lineTo(pillX, sharedPillY + pillRadius);
      ctx.quadraticCurveTo(pillX, sharedPillY, pillX + pillRadius, sharedPillY);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#0F172A";
      ctx.font = pillFont;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(marginLabel, gcx, sharedPillY + pillHeight / 2 + 0.5);
      ctx.restore();

      // Year label
      ctx.save();
      ctx.fillStyle = "rgba(128,128,128,0.7)";
      ctx.font = "10px 'General Sans', system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.translate(gcx, baseline + 6);
      ctx.rotate(-Math.PI / 6);
      ctx.fillText(year, 0, 0);
      ctx.restore();
    });
  }, [years, revenues, ebitdas, ebitdaDetails]);

  useEffect(() => {
    drawChart();
  }, [drawChart]);

  // Resize handler
  useEffect(() => {
    const handleResize = () => drawChart();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [drawChart]);

  if (years.length === 0) return null;

  return (
    <Card data-testid="chart-revenue-ebitda">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Key Financials
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="relative">
          <canvas
            ref={canvasRef}
            className="w-full"
            style={{ height: "280px" }}
            data-testid="chart-canvas"
          />
        </div>

        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          <div className="flex items-center gap-2">
            <div className="h-3 w-5 rounded-[3px] bg-blue-500" />
            <span className="text-xs text-muted-foreground">Ricavi</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3 w-5 rounded-[3px] bg-amber-500" />
            <span className="text-xs text-muted-foreground">EBITDA</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-6 w-14 rounded-full border border-dashed border-slate-300 bg-white shadow-sm">
            </div>
            <span className="text-xs text-muted-foreground">EBITDA margin %</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function ResultsPage() {
  const [, setLocation] = useLocation();
  const [data, setData] = useState<ResultData | null>(null);
  const [ebitdaData, setEbitdaData] = useState<EbitdaResponse | null>(null);
  const [isLoadingEbitda, setIsLoadingEbitda] = useState(false);
  const [userTier, setUserTier] = useState<string>("free");
  const bilanciSectionRef = useRef<HTMLDivElement | null>(null);
  const { token } = useAuth();

  const isPremium = userTier === "pro" || userTier === "business";

  useEffect(() => {
    const stored = (window as any).__bilancioResults;
    if (stored) {
      setData(stored);
    } else {
      setLocation("/");
    }
  }, [setLocation]);

  // Fetch user tier for premium gating
  useEffect(() => {
    if (!token) return;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    fetch(`${API_BASE}/api/billing/me`, { headers })
      .then(r => r.ok ? r.json() : null)
      .then(json => {
        if (json?.data?.tier) setUserTier(json.data.tier);
      })
      .catch(() => {});
  }, [token]);

  // Load structured revenue/EBITDA from legacy OpenAPI bilancio riclassificato flows.
  useEffect(() => {
    if (!data) return;
    if (isBilancioOtticoBusinessSource(data.mode, data.financialData?.source)) return;
    const fromDetails = data.companyDetails?.dettaglio?.bilanci || {};
    const fromFinancial = data.financialData?.bilanci || {};
    const purchasedBilanci = data.financialData?.purchasedBilanci || {};
    const bilanci = mergeBilanciMaps(fromDetails, fromFinancial);
    if (!bilanci || Object.keys(bilanci).length === 0) return;

    const hasDirectEbitda = Object.values(bilanci).some(
      (b: any) => typeof b?.ebitda === "number" && Number.isFinite(b.ebitda),
    );
    if (hasDirectEbitda) return;

    const hasAnyData = Object.values(bilanci).some(
      (b: any) => (b.fatturato ?? b.turnover ?? 0) > 0 || (b.patrimonio_netto ?? 0) > 0
    );
    if (!hasAnyData) return;

    const hasStructuredFinancials = Object.values(purchasedBilanci).some(
      (entry: any) => entry?.bilancioData && typeof entry.bilancioData === "object",
    );
    if (!hasStructuredFinancials) return;

    setIsLoadingEbitda(true);

    const headers: any = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    fetch(`${API_BASE}/api/company/estimate-ebitda`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        bilanci,
        purchasedBilanci,
      }),
    })
      .then(res => res.json())
      .then(result => {
        if (result.error) {
          console.warn("Structured EBITDA API error:", result.error);
          return;
        }
        if (result.data && typeof result.data === "object") {
          const raw = result.data as {
            ebitda?: Record<string, Partial<EbitdaYear>>;
            revenue?: Record<string, number>;
          };
          const normalized: EbitdaResponse = { ebitda: {}, revenue: {} };

          for (const [year, item] of Object.entries(raw.ebitda || {})) {
            if (typeof item?.value !== "number") continue;
            normalized.ebitda[year] = {
              value: item.value,
              margin_pct: typeof item.margin_pct === "number" ? item.margin_pct : 0,
              confidence: typeof item.confidence === "string" ? item.confidence : "low",
              method: typeof item.method === "string" ? item.method : "",
            };
          }

          for (const [year, value] of Object.entries(raw.revenue || {})) {
            if (typeof value === "number") {
              normalized.revenue[year] = value;
            }
          }

          if (Object.keys(normalized.ebitda).length > 0 || Object.keys(normalized.revenue).length > 0) {
            setEbitdaData(normalized);
          }
        }
      })
      .catch(err => console.error("Structured EBITDA fetch error:", err))
      .finally(() => setIsLoadingEbitda(false));
  }, [data, token]);

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Caricamento risultati...</p>
      </div>
    );
  }

  const { company, companyDetails, financialData } = data;
  const bilanciFromDetails = companyDetails?.dettaglio?.bilanci || {};
  const bilanciFromFinancial = financialData?.bilanci || {};
  const isComparativeBusinessSource = isBilancioOtticoBusinessSource(data.mode, financialData?.source);
  const mergedBilanci = mergeBilanciMaps(bilanciFromDetails, bilanciFromFinancial);
  const bilanci = isComparativeBusinessSource ? bilanciFromFinancial : mergedBilanci;
  const purchasedBilanci = (financialData?.purchasedBilanci || {}) as Record<string, PurchasedBilancio>;
  const uploadedBilanci = (financialData?.userUploadedBilanci || {}) as Record<string, UploadedBilancioDocument>;
  const insights = data.insights || financialData?.insights || {};
  const isBusinessMode = data.mode === "business";
  const marketBenchmarks = Array.isArray(insights?.marketBenchmarks?.metrics) ? insights.marketBenchmarks.metrics : [];
  const marketBenchmarkSources = Array.isArray(insights?.marketBenchmarks?.sources) ? insights.marketBenchmarks.sources : [];
  const insightRecommendations = Array.isArray(insights?.recommendations) ? insights.recommendations : [];
  const workingCapitalDebt =
    insights?.workingCapitalDebt && typeof insights.workingCapitalDebt === "object"
      ? insights.workingCapitalDebt
      : { summary: "", bullets: [] };
  const companyIdForFiles = companyDetails?.id || company?.id || "";
  const yearsWithData = isComparativeBusinessSource
    ? (Array.isArray(financialData?.coveredYears)
        ? financialData.coveredYears.filter((year: unknown): year is string => typeof year === "string")
        : Object.keys(bilanci).sort())
    : Object.keys(bilanci).filter(
        y => (bilanci[y].fatturato ?? bilanci[y].turnover ?? 0) > 0 || (bilanci[y].ebitda ?? 0) > 0 || (bilanci[y].patrimonio_netto ?? 0) > 0
      ).sort();
  const hasFinancials = yearsWithData.length > 0;
  const hasDirectEbitda = yearsWithData.some(
    (y: string) => typeof bilanci[y]?.ebitda === "number" && Number.isFinite(bilanci[y].ebitda),
  );
  const bilanciYears = Array.from(
    new Set([
      ...Object.keys(purchasedBilanci || {}),
      ...Object.keys(uploadedBilanci || {}),
    ]),
  )
    .filter((year) => {
      const purchasedDocs = Array.isArray(purchasedBilanci[year]?.documents) ? purchasedBilanci[year].documents : [];
      const uploadedDocs = Array.isArray(uploadedBilanci[year]?.documents) ? uploadedBilanci[year].documents : [];
      return purchasedDocs.length > 0 || uploadedDocs.length > 0 || Boolean(purchasedBilanci[year]?.bilancioData) || Boolean(uploadedBilanci[year]?.bilancioData);
    })
    .sort((a, b) => b.localeCompare(a));
  const hasBilanciSection = bilanciYears.length > 0;

  // Build chart data from structured OpenAPI revenue/EBITDA
  let chartData: ChartData | null = null;
  if (isComparativeBusinessSource && hasFinancials) {
    const years = yearsWithData;
    chartData = {
      years,
      revenues: years.map((y: string) => (typeof bilanci[y]?.fatturato === "number" ? bilanci[y].fatturato : 0)),
      ebitdas: years.map((y: string) => (typeof bilanci[y]?.ebitda === "number" ? bilanci[y].ebitda : 0)),
      ebitdaDetails: years.reduce((acc: Record<string, EbitdaYear>, year: string) => {
        const ebitda = bilanci[year]?.ebitda;
        const revenue = bilanci[year]?.fatturato;
        if (typeof ebitda === "number" && Number.isFinite(ebitda)) {
          acc[year] = {
            value: ebitda,
            margin_pct: typeof revenue === "number" && revenue > 0 ? (ebitda / revenue) * 100 : 0,
            confidence: "high",
            method: bilanci[year]?.method || "EBITDA ricavato dal bilancio ottico: EBIT + ammortamenti.",
          };
        }
        return acc;
      }, {} as Record<string, EbitdaYear>),
      bilanci,
    };
  } else if (hasDirectEbitda && hasFinancials) {
    const years = yearsWithData;
    chartData = {
      years,
      revenues: years.map((y: string) => bilanci[y]?.fatturato ?? bilanci[y]?.turnover ?? 0),
      ebitdas: years.map((y: string) => bilanci[y]?.ebitda ?? 0),
      ebitdaDetails: years.reduce((acc: Record<string, EbitdaYear>, year: string) => {
        const ebitda = bilanci[year]?.ebitda;
        if (typeof ebitda === "number" && Number.isFinite(ebitda)) {
          const revenue = bilanci[year]?.fatturato ?? bilanci[year]?.turnover ?? 0;
          const method =
            financialData?.source === "it-advanced+xbrl" || financialData?.source === "xbrl-only-v1"
              ? "Valore EBITDA estratto dai bilanci XBRL OpenAPI."
              : "Valore EBITDA restituito direttamente da OpenAPI.";
          acc[year] = {
            value: ebitda,
            margin_pct: revenue > 0 ? (ebitda / revenue) * 100 : 0,
            confidence: "high",
            method,
          };
        }
        return acc;
      }, {} as Record<string, EbitdaYear>),
      bilanci,
    };
  } else if (ebitdaData && hasFinancials) {
    const years = yearsWithData;
    const revenues = years.map((y: string) => {
      return ebitdaData.revenue?.[y] || bilanci[y]?.fatturato || 0;
    });
    const ebitdas = years.map((y: string) => ebitdaData.ebitda?.[y]?.value || 0);
    chartData = {
      years,
      revenues,
      ebitdas,
      ebitdaDetails: ebitdaData.ebitda || {},
      bilanci,
    };
  }

  // Fallback chart data without EBITDA
  const fallbackChartData: ChartData | null = hasFinancials ? {
    years: yearsWithData,
    revenues: yearsWithData.map((y: string) => bilanci[y]?.fatturato ?? bilanci[y]?.turnover ?? 0),
    ebitdas: yearsWithData.map(() => 0),
    ebitdaDetails: {},
    bilanci,
  } : null;

  // Description
  const descrizione = companyDetails?.dettaglio?.descrizione_ateco || "";
  const codiceAteco = companyDetails?.dettaglio?.codice_ateco || "";
  const formaGiuridica = companyDetails?.forma_giuridica || "";
  const comune = companyDetails?.comune || company?.comune || "";
  const provincia = companyDetails?.provincia || company?.provincia || "";
  const foundationYearCandidates = [
    companyDetails?.data_iscrizione,
    companyDetails?.data_inizio,
    companyDetails?.dettaglio?.data_inizio_attivita,
  ]
    .map((value) => extractYear(typeof value === "string" ? value : null))
    .filter((year): year is string => Boolean(year));
  const foundationYear = foundationYearCandidates.length > 0
    ? String(Math.min(...foundationYearCandidates.map((year) => Number(year))))
    : null;
  const aiDescriptionText = typeof companyDetails?.aiDescription === "string" ? companyDetails.aiDescription.trim() : "";
  const aiDescriptionSources = Array.isArray(companyDetails?.aiDescriptionSources)
    ? companyDetails.aiDescriptionSources.filter((source: any) => typeof source?.url === "string" && source.url.trim())
    : [];
  const aiKeyProducts = normalizeKeyProducts(companyDetails?.aiKeyProducts);
  let fallbackDescriptionText = "";
  if (company.denominazione) {
    fallbackDescriptionText = `${company.denominazione}`;
    if (formaGiuridica) fallbackDescriptionText += ` è una ${formaGiuridica.toLowerCase()}`;
    if (comune) fallbackDescriptionText += ` con sede a ${comune}`;
    if (provincia && provincia !== comune) fallbackDescriptionText += ` (${provincia})`;
    fallbackDescriptionText += ".";
    if (descrizione) {
      fallbackDescriptionText += ` Opera nel settore ${descrizione.toLowerCase()}.`;
    }
    if (hasFinancials) {
      const lastYear = [...yearsWithData].reverse().find((year: string) => typeof bilanci[year]?.fatturato === "number") || yearsWithData[yearsWithData.length - 1];
      const lastRevenue = bilanci[lastYear]?.fatturato;
      const lastEmployees = bilanci[lastYear]?.dipendenti;
      if (lastRevenue && lastRevenue > 0) {
        fallbackDescriptionText += ` Nell'ultimo esercizio disponibile (${lastYear}) ha registrato ricavi per ${formatCurrency(lastRevenue)}`;
        if (lastEmployees && lastEmployees > 0) {
          fallbackDescriptionText += ` con ${lastEmployees} dipendenti`;
        }
        fallbackDescriptionText += ".";
      }
    }
  }

  const descriptionText = aiDescriptionText || fallbackDescriptionText;
  const derivedBusinessCeoBrief = isBusinessMode
    ? buildLocalBusinessCeoBriefFromBilanci(bilanci)
    : null;
  const fallbackBusinessCeoBrief = isBusinessMode
    ? derivedBusinessCeoBrief || buildFallbackBusinessCeoBrief(insightRecommendations, workingCapitalDebt)
    : null;
  const businessCeoBrief = isBusinessMode
    ? normalizeBusinessCeoBrief(insights?.ceoBrief, fallbackBusinessCeoBrief)
    : null;

  const activeChartData = chartData || fallbackChartData;
  const financialTableYears = activeChartData?.years || [];
  const revenueGrowthValues = financialTableYears.map((year, index) => {
    const currentRevenue = bilanci[year]?.fatturato ?? bilanci[year]?.turnover;
    if (!isFiniteNumeric(currentRevenue) || index === 0) return null;

    const previousYear = financialTableYears[index - 1];
    const previousRevenue = bilanci[previousYear]?.fatturato ?? bilanci[previousYear]?.turnover;
    if (!isFiniteNumeric(previousRevenue) || previousRevenue === 0) return null;

    return ((currentRevenue - previousRevenue) / previousRevenue) * 100;
  });
  const cashFlowTableRows: CashFlowTableRow[] = activeChartData
    ? [
        {
          key: "ricavi",
          label: "Ricavi",
          type: "currency",
          values: activeChartData.years.map((year) => {
            const revenue = bilanci[year]?.fatturato ?? bilanci[year]?.turnover;
            return isFiniteNumeric(revenue) ? revenue : null;
          }),
          emphasize: true,
        },
        {
          key: "ricavi-growth",
          label: "% crescita",
          type: "percent",
          values: revenueGrowthValues,
          secondary: true,
        },
        {
          key: "ebitda",
          label: "EBITDA",
          type: "currency",
          values: activeChartData.years.map((year) => (isFiniteNumeric(bilanci[year]?.ebitda) ? bilanci[year].ebitda : null)),
          emphasize: true,
        },
        {
          key: "ebitda-margin",
          label: "% margine",
          type: "percent",
          values: activeChartData.years.map((year) => calculateMarginPercent(
            bilanci[year]?.ebitda,
            bilanci[year]?.fatturato ?? bilanci[year]?.turnover,
          )),
          secondary: true,
        },
        {
          key: "net-income",
          label: "Utile Netto",
          type: "currency",
          values: activeChartData.years.map((year) => (isFiniteNumeric(bilanci[year]?.utile_netto) ? bilanci[year].utile_netto : null)),
          emphasize: true,
        },
        {
          key: "net-income-margin",
          label: "% margine",
          type: "percent",
          values: activeChartData.years.map((year) => calculateMarginPercent(
            bilanci[year]?.utile_netto,
            bilanci[year]?.fatturato ?? bilanci[year]?.turnover,
          )),
          secondary: true,
        },
        {
          key: "ufcf",
          label: "Unlevered Free Cash Flow",
          type: "currency",
          values: activeChartData.years.map((year) => (
            isFiniteNumeric(bilanci[year]?.unlevered_free_cash_flow)
              ? bilanci[year].unlevered_free_cash_flow
              : null
          )),
          emphasize: true,
        },
        {
          key: "ufcf-cash-conversion",
          label: "% cash conversion",
          type: "percent",
          values: activeChartData.years.map((year) => calculateMarginPercent(
            bilanci[year]?.unlevered_free_cash_flow,
            bilanci[year]?.ebitda,
          )),
          secondary: true,
        },
      ]
    : [];
  const showCashFlowTable = data.mode === "business" && Boolean(activeChartData?.years.length);
  const workingCapitalTableRows = activeChartData?.years.length
    ? [
        {
          key: "nwc",
          label: "Capitale circolante",
          type: "currency" as const,
          values: activeChartData.years.map((year) => (isFiniteNumeric(bilanci[year]?.nwc) ? bilanci[year].nwc : null)),
          emphasize: true,
        },
        {
          key: "dso",
          label: "DSO",
          type: "days" as const,
          values: activeChartData.years.map((year) => (isFiniteNumeric(bilanci[year]?.dso) ? bilanci[year].dso : null)),
        },
        {
          key: "dio",
          label: "DIO",
          type: "days" as const,
          values: activeChartData.years.map((year) => (isFiniteNumeric(bilanci[year]?.dio) ? bilanci[year].dio : null)),
        },
        {
          key: "dpo",
          label: "DPO",
          type: "days" as const,
          values: activeChartData.years.map((year) => (isFiniteNumeric(bilanci[year]?.dpo) ? bilanci[year].dpo : null)),
        },
      ]
    : [];
  const debtTableRows = activeChartData?.years.length
    ? [
        {
          key: "net-debt",
          label: "Debito netto",
          type: "currency" as const,
          values: activeChartData.years.map((year) => (isFiniteNumeric(bilanci[year]?.net_debt) ? bilanci[year].net_debt : null)),
          emphasize: true,
        },
        {
          key: "net-debt-ebitda",
          label: "Debito netto / EBITDA",
          type: "multiple" as const,
          values: activeChartData.years.map((year) => (isFiniteNumeric(bilanci[year]?.net_debt_ebitda) ? bilanci[year].net_debt_ebitda : null)),
        },
      ]
    : [];
  const hasWorkingCapitalTable = workingCapitalTableRows.some((row) => row.values.some((value) => isFiniteNumeric(value)));
  const hasDebtTable = debtTableRows.some((row) => row.values.some((value) => isFiniteNumeric(value)));
  const workingCapitalSummaryItems: SummaryStatItem[] = activeChartData?.years.length
    ? [
        {
          label: "Cap. circolante / ricavi",
          value: formatSummaryStatValue(
            averageNumeric(activeChartData.years.map((year) => bilanci[year]?.nwc_pct_revenue ?? null)),
            "percent",
          ),
          hint: "Media anni disponibili",
        },
        {
          label: "Tempo incasso",
          value: formatSummaryStatValue(
            averageNumeric(activeChartData.years.map((year) => bilanci[year]?.dso ?? null)),
            "days",
          ),
          hint: "DSO medio",
        },
        {
          label: "Tempo magazzino",
          value: formatSummaryStatValue(
            averageNumeric(activeChartData.years.map((year) => bilanci[year]?.dio ?? null)),
            "days",
          ),
          hint: "DIO medio",
        },
        {
          label: "Tempo pagamento",
          value: formatSummaryStatValue(
            averageNumeric(activeChartData.years.map((year) => bilanci[year]?.dpo ?? null)),
            "days",
          ),
          hint: "DPO medio",
        },
      ]
    : [];
  const hasLegacyAnalysisContent = Boolean(
    data.analysis?.summary ||
    data.analysis?.incomeStatementAnalysis ||
    data.analysis?.balanceSheetAnalysis ||
    data.analysis?.cashFlowAnalysis ||
    data.analysis?.marketComparison ||
    (Array.isArray(data.analysis?.keyMetrics) && data.analysis.keyMetrics.length > 0) ||
    (Array.isArray(data.analysis?.strengths) && data.analysis.strengths.length > 0) ||
    (Array.isArray(data.analysis?.weaknesses) && data.analysis.weaknesses.length > 0) ||
    (Array.isArray(data.analysis?.opportunities) && data.analysis.opportunities.length > 0) ||
    (Array.isArray(data.analysis?.threats) && data.analysis.threats.length > 0) ||
    (Array.isArray(data.analysis?.recommendations) && data.analysis.recommendations.length > 0)
  );

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/60 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 h-14 sm:h-16 flex items-center">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0">
            <Button variant="ghost" size="sm" onClick={() => setLocation("/")} data-testid="button-back-home" className="shrink-0 px-2 sm:px-3">
              <ArrowLeft className="w-4 h-4 sm:mr-1.5" />
              <span className="hidden sm:inline">Nuova analisi</span>
            </Button>
            <div className="h-5 w-px bg-border shrink-0" />
            <div className="flex items-center gap-2 min-w-0">
              <Building2 className="w-4 h-4 text-primary shrink-0" />
              <span className="font-semibold text-sm truncate">{company.denominazione}</span>
            </div>
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-6">

        {isBusinessMode && businessCeoBrief && (
          <BusinessCeoBriefCard ceoBrief={businessCeoBrief} />
        )}

        {/* ANAGRAFICA */}
        <Card data-testid="section-anagrafica">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Anagrafica
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <h2 className="text-xl font-bold">{company.denominazione}</h2>
              {companyDetails?.forma_giuridica && (
                <span className="text-xs text-muted-foreground">{companyDetails.forma_giuridica}</span>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              {(company.comune || companyDetails?.comune) && (
                <div className="flex items-start gap-2.5">
                  <MapPin className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                  <div>
                    <div className="text-foreground">
                      {companyDetails?.indirizzo || company.indirizzo}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {[companyDetails?.cap || company.cap, companyDetails?.comune || company.comune, companyDetails?.provincia || company.provincia].filter(Boolean).join(", ")}
                    </div>
                  </div>
                </div>
              )}

              {companyDetails?.pec && (
                <div className="flex items-center gap-2.5">
                  <Mail className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="text-foreground break-all">{companyDetails.pec}</span>
                </div>
              )}

              {companyDetails?.telefono && (
                <div className="flex items-center gap-2.5">
                  <Phone className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="text-foreground">{companyDetails.telefono}</span>
                </div>
              )}

              {(company.piva || companyDetails?.partita_iva) && (
                <div className="flex items-center gap-2.5">
                  <Globe className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="text-foreground">P.IVA: {companyDetails?.partita_iva || company.piva}</span>
                </div>
              )}

              {foundationYear && (
                <div className="flex items-center gap-2.5">
                  <CalendarDays className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="text-foreground">Anno di fondazione: {foundationYear}</span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              {company.stato_attivita && (
                <Badge variant={company.stato_attivita === "ATTIVA" ? "default" : "secondary"} className="text-xs">
                  {company.stato_attivita}
                </Badge>
              )}
              {companyDetails?.dettaglio?.codice_ateco && (
                <Badge variant="outline" className="text-xs">
                  ATECO {companyDetails.dettaglio.codice_ateco}
                </Badge>
              )}
              {companyDetails?.dettaglio?.descrizione_ateco && (
                <Badge variant="outline" className="text-xs max-w-[250px] truncate">
                  {companyDetails.dettaglio.descrizione_ateco}
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>

        {isBusinessMode ? (
          <BusinessSnapshotCard
            descriptionText={descriptionText}
            aiDescriptionSources={aiDescriptionSources}
            keyProducts={aiKeyProducts}
          />
        ) : descriptionText ? (
          <Card data-testid="section-descrizione">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Descrizione
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-line text-sm text-foreground/90 leading-relaxed">
                {descriptionText}
              </p>
              {aiDescriptionSources.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {aiDescriptionSources.map((source: any, index: number) => (
                    <a
                      key={`${source.url}-${index}`}
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center rounded-full border border-border/60 px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                    >
                      {typeof source?.title === "string" && source.title.trim() ? source.title : `Fonte ${index + 1}`}
                    </a>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}

        {/* CHART */}
        {isLoadingEbitda && (
          <Card>
            <CardContent className="py-8 flex flex-col items-center gap-3">
              <Loader2 className="w-5 h-5 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Recupero EBITDA da bilanci OpenAPI...</p>
            </CardContent>
          </Card>
        )}

        {!isLoadingEbitda && activeChartData && activeChartData.years.length > 0 && (
          <RevenueEbitdaChart chartData={activeChartData} />
        )}

        {showCashFlowTable && activeChartData && (
          <Card data-testid="section-cash-flow-bridge">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Summary Financials
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="min-w-full border-separate border-spacing-y-1 text-sm">
                  <thead>
                    <tr>
                      <th className="px-4 pb-4 text-left align-bottom">
                        <div className="text-sm font-semibold text-foreground">FYE (31-Dec)</div>
                        <div className="pt-0.5 text-xs italic text-muted-foreground">(Dati in €m)</div>
                      </th>
                      {activeChartData.years.map((year) => (
                        <th
                          key={`cash-flow-head-${year}`}
                          className="px-4 pb-4 text-right align-bottom text-sm font-semibold text-foreground"
                        >
                          {year}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cashFlowTableRows.map((row) => (
                      <tr key={row.key}>
                        <th
                          className={`px-4 py-0.5 text-left ${
                            row.secondary
                              ? "pl-8 font-normal italic text-muted-foreground"
                              : row.emphasize
                                ? "font-semibold text-foreground"
                                : "font-medium text-foreground"
                          }`}
                        >
                          {row.label}
                        </th>
                        {row.values.map((value, index) => (
                          <td
                            key={`${row.key}-${activeChartData.years[index]}`}
                            className={`px-4 py-0.5 text-right tabular-nums ${
                              row.secondary
                                ? "italic text-muted-foreground"
                                : row.emphasize
                                  ? "font-semibold text-foreground"
                                  : "text-foreground/90"
                            }`}
                          >
                            {row.type === "percent" ? formatFinancialTablePercent(value) : formatFinancialTableMillions(value)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {isBusinessMode && marketBenchmarks.length > 0 && (
          <Card data-testid="section-performance-vs-market">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Performance vs Market
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="overflow-x-auto">
                <div className="min-w-[680px] overflow-hidden rounded-2xl border border-border/60">
                  <div className="grid grid-cols-[minmax(0,1.2fr)_120px_150px_110px] border-b border-border/60 bg-slate-50/80 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    <div>Metrica</div>
                    <div className="text-right">Azienda</div>
                    <div className="text-right">Mercato</div>
                    <div className="text-right">Stato</div>
                  </div>
                  {marketBenchmarks.map((item: any, index: number) => {
                    const tone = getBenchmarkStatusTone(item?.status);
                    return (
                      <div
                        key={`${item.metric}-${index}`}
                        className="grid grid-cols-[minmax(0,1.2fr)_120px_150px_110px] items-start gap-3 border-b border-border/50 px-4 py-4 last:border-b-0"
                      >
                        <div>
                          <div className="text-sm font-semibold text-foreground">{item.metric}</div>
                          {typeof item?.comment === "string" && item.comment.trim() && (
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.comment}</p>
                          )}
                        </div>
                        <div className="text-right text-sm font-semibold text-foreground">
                          {formatMetricValue(item?.companyValue, "percent")}
                        </div>
                        <div className="text-right text-sm text-foreground/85">
                          {isFiniteNumeric(item?.marketRangeLow) && isFiniteNumeric(item?.marketRangeHigh)
                            ? `${item.marketRangeLow.toFixed(1)}% - ${item.marketRangeHigh.toFixed(1)}%`
                            : "N/D"}
                        </div>
                        <div className="flex justify-end">
                          <span className={`rounded-full border px-3 py-1 text-[11px] font-medium ${tone.className}`}>
                            {tone.badge}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {marketBenchmarkSources.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {marketBenchmarkSources.map((source: any, index: number) => (
                    <a
                      key={`${source.url}-${index}`}
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center rounded-full border border-border/60 px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
                    >
                      {source.title || `Fonte ${index + 1}`}
                    </a>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {isBusinessMode && hasWorkingCapitalTable && (
          <FinancialTableCard
            title="Capitale Circolante"
            note="(Dati in €m e giorni)"
            years={activeChartData?.years || []}
            rows={workingCapitalTableRows}
            testId="section-working-capital"
            summaryItems={workingCapitalSummaryItems}
            showTable={false}
          />
        )}

        {isBusinessMode && hasDebtTable && (
          <FinancialTableCard
            title="Debito"
            note="(Dati in €m e x)"
            years={activeChartData?.years || []}
            rows={debtTableRows}
            testId="section-debt"
          />
        )}

        {hasBilanciSection && (
          <div className="flex justify-center">
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => bilanciSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
              data-testid="button-view-bilanci"
            >
              <FileText className="w-4 h-4" />
              Vedi bilanci
            </Button>
          </div>
        )}

        {hasBilanciSection && (
          <Card ref={bilanciSectionRef} data-testid="section-view-bilanci">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Vedi Bilanci
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Qui trovi i documenti usati da BilancioAI: quelli acquistati dal provider e, se presenti,
                i bilanci caricati da te in modo privato. Ogni acquisto o upload puo' coprire due annualita':
                anno corrente del deposito e comparativo precedente.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <Accordion type="single" collapsible className="w-full">
                {bilanciYears.map((year) => {
                  const summary = bilanci[year];
                  const purchased = purchasedBilanci[year];
                  const uploaded = uploadedBilanci[year];
                  const documentSource = typeof purchased?.bilancioData?.source === "string" ? purchased.bilancioData.source : "";
                  const structuredPreview =
                    uploaded?.bilancioData?.structuredData ||
                    (uploaded?.bilancioData?.periods ? uploaded.bilancioData : null) ||
                    purchased?.bilancioData?.structuredData ||
                    (purchased?.bilancioData?.periods ? purchased.bilancioData : null);
                  const coveredYearsForPurchase = Array.from(
                    new Set([
                      ...(Array.isArray((uploaded as any)?.bilancioData?.coveredYears)
                        ? ((uploaded as any).bilancioData.coveredYears as string[])
                        : Object.keys(((uploaded as any)?.bilancioData?.periods || {}) as Record<string, unknown>).sort()),
                      ...(Array.isArray((purchased as any)?.bilancioData?.coveredYears)
                        ? ((purchased as any).bilancioData.coveredYears as string[])
                        : Object.keys(((purchased as any)?.bilancioData?.periods || {}) as Record<string, unknown>).sort()),
                    ]),
                  );
                  const documentEntries = [
                    ...(uploaded?.documents || []).map((document, index) => ({ document, index, source: "user_upload" as const })),
                    ...(purchased?.documents || []).map((document, index) => ({ document, index, source: "openapi" as const })),
                  ];
                  const pdfDocuments = documentEntries.filter(({ document }) => isPdfDocument(document));
                  const structuredDocuments = documentEntries.filter(({ document }) => isStructuredBilancioDocument(document));
                  const hasStructuredPreview = Boolean(structuredPreview && typeof structuredPreview === "object");

                  return (
                    <AccordionItem key={year} value={year}>
                      <AccordionTrigger className="text-left">
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <span className="font-semibold">{year}</span>
                          <div className="flex flex-wrap gap-2">
                            {uploaded?.documents?.length > 0 && (
                              <Badge variant="outline" className="text-[10px]">
                                Privato
                              </Badge>
                            )}
                            {pdfDocuments.length > 0 && (
                              <Badge className="text-[10px]">{pdfDocuments.length} PDF</Badge>
                            )}
                            {(structuredDocuments.length > 0 || hasStructuredPreview) && (
                              <Badge variant="secondary" className="text-[10px]">
                                {structuredDocuments.length || 1} XBRL
                              </Badge>
                            )}
                            {coveredYearsForPurchase.length > 0 && (
                              <Badge variant="outline" className="text-[10px]">
                                Copre {coveredYearsForPurchase.join(" e ")}
                              </Badge>
                            )}
                            {summary && <Badge variant="outline" className="text-[10px]">Dati sintetici</Badge>}
                          </div>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent className="space-y-4">
                        <div className="space-y-3 rounded-lg border border-border/50 bg-slate-50 p-4 dark:bg-slate-950/40">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span>Salvato il {formatDateTime(uploaded?.fetchedAt || purchased?.fetchedAt)}</span>
                            {pdfDocuments.length > 0 && (
                              <>
                                <span>•</span>
                                <span>{pdfDocuments.length} PDF disponibile/i</span>
                              </>
                            )}
                            {(structuredDocuments.length > 0 || hasStructuredPreview) && (
                              <>
                                <span>•</span>
                                <span>{structuredDocuments.length || 1} XBRL disponibile/i</span>
                              </>
                            )}
                            {coveredYearsForPurchase.length > 0 && (
                              <>
                                <span>•</span>
                                <span>Copre {coveredYearsForPurchase.join(" e ")}</span>
                              </>
                            )}
                          </div>

                          {documentEntries.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                              {documentEntries.map(({ document, index, source }) => {
                                const params = new URLSearchParams();
                                if (documentSource) params.set("source", documentSource);
                                if (token) params.set("access_token", token);
                                const queryString = params.toString();
                                const href = source === "user_upload" && typeof document?.privateDocumentId === "number"
                                  ? `${API_BASE}/api/private-bilanci/${document.privateDocumentId}/file${token ? `?access_token=${encodeURIComponent(token)}` : ""}`
                                  : `${API_BASE}/api/bilancio/cached/${encodeURIComponent(companyIdForFiles)}/${encodeURIComponent(year)}/${index}${queryString ? `?${queryString}` : ""}`;

                                return (
                                <Button
                                  key={`${year}-${source}-${index}`}
                                  asChild
                                  size="sm"
                                  variant={isStructuredBilancioDocument(document) ? "default" : "outline"}
                                  className="gap-2"
                                >
                                  <a
                                    href={href}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    <FileText className="w-4 h-4" />
                                    {getBilancioDocumentBadge(document)} {document.originalName || document.filename || `Bilancio ${year}`}
                                  </a>
                                </Button>
                                );
                              })}
                            </div>
                          )}

                          {hasStructuredPreview && (
                            <div className="space-y-2 rounded-lg border border-border/50 bg-background p-3">
                              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                Dati strutturati estratti dal bilancio ottico
                              </div>
                              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-950 p-3 text-[11px] leading-5 text-slate-100">
                                {JSON.stringify(structuredPreview, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>

                        {summary && (
                          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                            {(summary.fatturato ?? summary.turnover) > 0 && (
                              <div>
                                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Fatturato</div>
                                <div className="text-sm font-semibold">{formatCurrency(summary.fatturato ?? summary.turnover)}</div>
                              </div>
                            )}
                            {summary.patrimonio_netto > 0 && (
                              <div>
                                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Patrimonio Netto</div>
                                <div className="text-sm font-semibold">{formatCurrency(summary.patrimonio_netto)}</div>
                              </div>
                            )}
                            {summary.totale_attivo > 0 && (
                              <div>
                                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Totale Attivo</div>
                                <div className="text-sm font-semibold">{formatCurrency(summary.totale_attivo)}</div>
                              </div>
                            )}
                            {summary.costo_personale > 0 && (
                              <div>
                                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Costo Personale</div>
                                <div className="text-sm font-semibold">{formatCurrency(summary.costo_personale)}</div>
                              </div>
                            )}
                            {summary.dipendenti > 0 && (
                              <div>
                                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Dipendenti</div>
                                <div className="text-sm font-semibold">{summary.dipendenti.toLocaleString("it-IT")}</div>
                              </div>
                            )}
                            {summary.data_chiusura_bilancio && (
                              <div>
                                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Chiusura</div>
                                <div className="text-sm font-semibold">{summary.data_chiusura_bilancio}</div>
                              </div>
                            )}
                          </div>
                        )}
                      </AccordionContent>
                    </AccordionItem>
                  );
                })}
              </Accordion>
            </CardContent>
          </Card>
        )}
        {isBusinessMode && hasLegacyAnalysisContent && (
          <Card data-testid="section-technical-appendix">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Appendice Tecnica
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Accordion type="single" collapsible className="w-full">
                <AccordionItem value="legacy-analysis" className="border-b-0">
                  <AccordionTrigger className="py-1 text-left text-sm font-medium text-foreground">
                    Apri dettaglio analitico legacy
                  </AccordionTrigger>
                  <AccordionContent className="space-y-6 pt-4">
                    <LegacyAnalysisSections analysis={data.analysis} isPremium={isPremium} />
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>
        )}

        {!isBusinessMode && (
          <LegacyAnalysisSections analysis={data.analysis} isPremium={isPremium} />
        )}

        {!isBusinessMode && data.competitors?.competitors?.length > 0 && (
          <PremiumGate isUnlocked={isPremium} featureLabel="Analisi Competitor">
            <Card data-testid="section-competitors">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Competitor Principali
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {data.competitors.competitors.map((comp: any, i: number) => (
                    <div key={i} className="flex gap-3 items-start rounded-lg border border-border/60 p-3">
                      <div className="shrink-0 flex items-center justify-center w-8 h-8 rounded-full bg-muted text-muted-foreground">
                        <Users className="w-4 h-4" />
                      </div>
                      <div>
                        <div className="font-semibold text-sm">{comp.name}</div>
                        <p className="text-xs text-muted-foreground mt-0.5">{comp.reason}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </PremiumGate>
        )}

      </div>

      <footer className="border-t border-border/50 py-6 px-6 mt-8">
        <div className="max-w-3xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
          <p className="text-xs text-muted-foreground md:text-left text-center order-2 md:order-1">
            Dati forniti da Camera di Commercio tramite OpenAPI.it
          </p>
          <div className="order-1 md:order-2 text-center">
            <PoweredByAttribution />
          </div>
          <div className="hidden md:block md:order-3" aria-hidden="true" />
        </div>
      </footer>
    </div>
  );
}
