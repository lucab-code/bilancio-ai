import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import {
  ArrowLeft, Building2, MapPin, Mail, Phone, Globe, Loader2, FileText,
  CalendarDays,
  TrendingUp, TrendingDown, Minus, Target, Users, ShieldCheck, AlertTriangle,
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

type CheckPointStatus = "green" | "amber" | "red";
type CheckPointKey = "growth" | "profitability" | "cashGeneration" | "debt";

interface CheckPointItem {
  key: CheckPointKey;
  label: string;
  status: CheckPointStatus;
  metric: string;
  judgment: string;
  evidence: string;
}

interface RecommendationTrackItem {
  key: CheckPointKey;
  label: string;
  title: string;
  diagnosis: string;
  action: string;
  evidence: string;
}

interface CeoBriefData {
  overview: string;
  checkpoints: CheckPointItem[];
  recommendationTracks: RecommendationTrackItem[];
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

const CHECKPOINT_ORDER: Array<{ key: CheckPointKey; label: string }> = [
  { key: "growth", label: "Crescita" },
  { key: "profitability", label: "Profittabilita'" },
  { key: "cashGeneration", label: "Generazione di cassa" },
  { key: "debt", label: "Indebitamento" },
];

function formatCheckpointPercent(value: number | null): string {
  return isFiniteNumeric(value) ? `${value.toFixed(1)}%` : "N/D";
}

function formatCheckpointMultiple(value: number | null): string {
  return isFiniteNumeric(value) ? `${value.toFixed(1)}x` : "N/D";
}

function formatCheckpointPerEmployee(value: number | null): string {
  if (!isFiniteNumeric(value)) return "N/D";
  if (Math.abs(value) >= 1_000_000) return `€${(value / 1_000_000).toFixed(1)}m`;
  if (Math.abs(value) >= 1_000) return `€${(value / 1_000).toFixed(0)}k`;
  return `€${value.toFixed(0)}`;
}

function getCheckpointStatus(
  value: number | null,
  greenTest: (candidate: number) => boolean,
  amberTest: (candidate: number) => boolean,
): CheckPointStatus {
  if (!isFiniteNumeric(value)) return "amber";
  if (greenTest(value)) return "green";
  if (amberTest(value)) return "amber";
  return "red";
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
  const netDebtEbitda = isFiniteNumeric(latest?.net_debt_ebitda) ? latest.net_debt_ebitda : null;
  const debtEquity = isFiniteNumeric(latest?.debt_equity) ? latest.debt_equity : null;

  const cashLeakLabel =
    isFiniteNumeric(changeNwcPctRevenue) && changeNwcPctRevenue > Math.max(capexPctRevenue ?? 0, taxesPctEbitda ?? 0)
      ? "capitale circolante"
      : isFiniteNumeric(capexPctRevenue) && capexPctRevenue > Math.max(changeNwcPctRevenue ?? 0, taxesPctEbitda ?? 0)
        ? "capex"
        : isFiniteNumeric(taxesPctEbitda) && taxesPctEbitda > 0
          ? "imposte"
          : "conversione operativa";

  const growthStatus = getCheckpointStatus(revenueGrowth, (value) => value >= 10, (value) => value >= 0);
  const profitabilityStatus = getCheckpointStatus(ebitdaMargin, (value) => value >= 15, (value) => value >= 8);
  const cashStatus = getCheckpointStatus(cashConversion, (value) => value >= 80, (value) => value >= 50);
  const debtStatus = getCheckpointStatus(netDebtEbitda, (value) => value <= 2, (value) => value <= 4);

  const overallScore =
    (growthStatus === "red" ? 2 : growthStatus === "amber" ? 1 : 0) +
    (profitabilityStatus === "red" ? 2 : profitabilityStatus === "amber" ? 1 : 0) +
    (cashStatus === "red" ? 2 : cashStatus === "amber" ? 1 : 0) +
    (debtStatus === "red" ? 2 : debtStatus === "amber" ? 1 : 0);

  const overview =
    overallScore >= 6
      ? `Nel ${latestYear} il business va ricentrato sulla cassa: crescita, profittabilita' e leva non stanno ancora lavorando insieme.`
      : overallScore >= 3
        ? `Nel ${latestYear} l'azienda ha leve utili, ma va guidata con piu' disciplina su crescita, profittabilita' e conversione in cassa.`
        : `Nel ${latestYear} il business appare ordinato; il punto adesso e' proteggere la cassa senza perdere qualita' di crescita.`;

  return {
    overview,
    checkpoints: [
      {
        key: "growth",
        label: "Crescita",
        status: growthStatus,
        metric: `Ricavi ${latestYear} ${formatCheckpointPercent(revenueGrowth)}`,
        judgment:
          growthStatus === "green"
            ? "La crescita passata e' buona, ora va difesa senza allargare il fabbisogno."
            : growthStatus === "amber"
              ? "La crescita c'e', ma non e' ancora abbastanza forte da essere un vantaggio strutturale."
              : "La crescita e' debole o negativa: prima di spingere volume va chiarita la qualita' dei ricavi.",
        evidence: `Crescita ricavi ${latestYear}: ${formatCheckpointPercent(revenueGrowth)}; ricavi ${latestYear}: ${isFiniteNumeric(latest?.fatturato) ? formatCurrency(latest.fatturato) : "N/D"}; cash conversion ${latestYear}: ${formatCheckpointPercent(cashConversion)}.`,
      },
      {
        key: "profitability",
        label: "Profittabilita'",
        status: profitabilityStatus,
        metric: `EBITDA margin ${latestYear} ${formatCheckpointPercent(ebitdaMargin)}`,
        judgment:
          profitabilityStatus === "green"
            ? "La profittabilita' e' buona, ma va tenuta alta con pricing e produttivita'."
            : profitabilityStatus === "amber"
              ? "Il margine e' utilizzabile, ma non ancora abbastanza forte per assorbire errori o crescita debole."
              : "La profittabilita' e' troppo bassa: costi e produttivita' vanno affrontati con piu' decisione.",
        evidence: `EBITDA margin ${latestYear}: ${formatCheckpointPercent(ebitdaMargin)}; costo personale / ricavi ${latestYear}: ${formatCheckpointPercent(personnelCostPctRevenue)}; ricavi per dipendente ${latestYear}: ${formatCheckpointPerEmployee(revenuePerEmployee)}.`,
      },
      {
        key: "cashGeneration",
        label: "Generazione di cassa",
        status: cashStatus,
        metric: `Cash conversion ${latestYear} ${formatCheckpointPercent(cashConversion)}`,
        judgment:
          cashStatus === "green"
            ? "La cassa viene generata bene, ma il rilascio va protetto su circolante, capex e imposte."
            : cashStatus === "amber"
              ? "La cassa arriva solo in parte: tra EBITDA e UFCF si disperde ancora troppo."
              : "La generazione di cassa e' debole: oggi il business trattiene troppo poco dell'EBITDA.",
        evidence: `Cash conversion ${latestYear}: ${formatCheckpointPercent(cashConversion)}; change NWC / ricavi ${latestYear}: ${formatCheckpointPercent(changeNwcPctRevenue)}; capex / ricavi ${latestYear}: ${formatCheckpointPercent(capexPctRevenue)}; perdita principale su ${cashLeakLabel}.`,
      },
      {
        key: "debt",
        label: "Indebitamento",
        status: debtStatus,
        metric: `Net debt / EBITDA ${latestYear} ${formatCheckpointMultiple(netDebtEbitda)}`,
        judgment:
          debtStatus === "green"
            ? "L'indebitamento e' gestibile e non sembra bloccare la manovra."
            : debtStatus === "amber"
              ? "La leva va presidiata: non e' fuori scala, ma riduce il margine di errore."
              : "L'indebitamento e' alto rispetto all'EBITDA e amplifica il rischio operativo.",
        evidence: `Debito netto / EBITDA ${latestYear}: ${formatCheckpointMultiple(netDebtEbitda)}; Debt / Equity ${latestYear}: ${formatCheckpointMultiple(debtEquity)}; cash conversion ${latestYear}: ${formatCheckpointPercent(cashConversion)}.`,
      },
    ],
    recommendationTracks: [
      {
        key: "growth",
        label: "Crescita",
        title: isFiniteNumeric(revenueGrowth) && revenueGrowth < 0
          ? "Ripartire con crescita che non bruci cassa"
          : "Aumentare la crescita dove prezzo e cassa reggono",
        diagnosis: "La crescita conta solo se tiene insieme ricavi, margine e circolante. Se il business cresce in aree che assorbono troppo capitale, la top line non si traduce in cassa.",
        action: "Sposta energia commerciale su clienti, prodotti e canali che mantengono pricing, margine e tempi di incasso sotto controllo; evita crescita che allarga solo il fabbisogno.",
        evidence: `Crescita ricavi ${latestYear}: ${formatCheckpointPercent(revenueGrowth)}; ricavi ${latestYear}: ${isFiniteNumeric(latest?.fatturato) ? formatCurrency(latest.fatturato) : "N/D"}; cash conversion ${latestYear}: ${formatCheckpointPercent(cashConversion)}.`,
      },
      {
        key: "profitability",
        label: "Profittabilita'",
        title: "Alzare la profittabilita' intervenendo su cost base e produttivita'",
        diagnosis: "Se l'EBITDA margin resta compresso, ogni euro di ricavo aggiuntivo vale troppo poco. Qui vanno guardati pricing, costo del personale, ricavi per dipendente e grado di automazione.",
        action: "Verifica dove recuperare margine con repricing, mix migliore, AI, outsourcing, redesign organizzativo o riduzione selettiva dell'organico se la produttivita' non giustifica la struttura.",
        evidence: `EBITDA margin ${latestYear}: ${formatCheckpointPercent(ebitdaMargin)}; costo personale / ricavi ${latestYear}: ${formatCheckpointPercent(personnelCostPctRevenue)}; ricavi per dipendente ${latestYear}: ${formatCheckpointPerEmployee(revenuePerEmployee)}.`,
      },
      {
        key: "cashGeneration",
        label: "Generazione di cassa",
        title: "Chiudere la perdita di cassa dove il business la disperde davvero",
        diagnosis: "La cash conversion non si migliora in astratto: bisogna isolare se la cassa si perde nel circolante, nel capex o nelle imposte e dare ownership chiara a ciascun leak.",
        action:
          cashLeakLabel === "capitale circolante"
            ? "Attacca crediti, scorte e termini fornitori con target di rilascio cassa; se il problema sono i capex, valuta modelli piu' asset-light o outsourcing; se sono le imposte, apri una review fiscale specialistica."
            : cashLeakLabel === "capex"
              ? "Taglia o rinvia capex non essenziali, valuta alternative asset-light e non finanziare investimenti che non tornano in cassa; tieni comunque il circolante sotto target."
              : cashLeakLabel === "imposte"
                ? "Apri subito una revisione fiscale con specialisti per capire quanto tax cash-out sia ottimizzabile; in parallelo tieni circolante e capex sotto governance esplicita."
                : "Scomponi la cash conversion tra circolante, capex e imposte e assegna una leva concreta a ciascuna perdita di cassa.",
        evidence: `Cash conversion ${latestYear}: ${formatCheckpointPercent(cashConversion)}; change NWC / ricavi ${latestYear}: ${formatCheckpointPercent(changeNwcPctRevenue)}; capex / ricavi ${latestYear}: ${formatCheckpointPercent(capexPctRevenue)}; taxes / EBITDA ${latestYear}: ${formatCheckpointPercent(taxesPctEbitda)}.`,
      },
      {
        key: "debt",
        label: "Indebitamento",
        title: "Impedire che la leva peggiori un problema operativo",
        diagnosis: "Il debito non crea il problema, ma lo amplifica quando margine e cash conversion non sono abbastanza robusti. Se la leva e' tesa, riduce opzioni strategiche e headroom bancaria.",
        action: "Prima difendi cassa e margine, poi riapri il tema della crescita finanziata. Evita nuovo debito per coprire inefficienze operative che il business non sta assorbendo.",
        evidence: `Debito netto / EBITDA ${latestYear}: ${formatCheckpointMultiple(netDebtEbitda)}; Debt / Equity ${latestYear}: ${formatCheckpointMultiple(debtEquity)}; cash conversion ${latestYear}: ${formatCheckpointPercent(cashConversion)}.`,
      },
    ],
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

function getCheckpointTone(status: CheckPointStatus) {
  if (status === "green") {
    return {
      badge: "Verde",
      badgeClassName: "border-emerald-200 bg-emerald-50 text-emerald-700",
      activeClassName: "bg-emerald-500",
    };
  }
  if (status === "red") {
    return {
      badge: "Rosso",
      badgeClassName: "border-rose-200 bg-rose-50 text-rose-700",
      activeClassName: "bg-rose-500",
    };
  }
  return {
    badge: "Arancione",
    badgeClassName: "border-amber-200 bg-amber-50 text-amber-700",
    activeClassName: "bg-amber-500",
  };
}

function mapRecommendationThemeToTrackKey(theme: unknown): CheckPointKey {
  if (theme === "margini_pricing") return "profitability";
  if (theme === "capitale_circolante" || theme === "allocazione_capitale") return "cashGeneration";
  if (theme === "debito_struttura") return "debt";
  return "growth";
}

function mapRecommendationPriorityToStatus(priority: unknown): CheckPointStatus {
  if (priority === "high") return "red";
  if (priority === "medium") return "amber";
  return "green";
}

function buildFallbackBusinessCeoBrief(recommendations: any[], workingCapitalDebt: any): CeoBriefData | null {
  const recommendationList = Array.isArray(recommendations)
    ? recommendations.filter((item) => item && typeof item === "object")
    : [];

  if (recommendationList.length === 0) return null;

  const firstByKey = new Map<CheckPointKey, any>();
  for (const item of recommendationList) {
    const key = mapRecommendationThemeToTrackKey(item?.theme);
    if (!firstByKey.has(key)) firstByKey.set(key, item);
  }

  const fallbackSummary =
    typeof workingCapitalDebt?.summary === "string" && workingCapitalDebt.summary.trim()
      ? workingCapitalDebt.summary.trim()
      : "I dati disponibili indicano leve manageriali concrete ma non una lettura completa di tutte le metriche.";
  const firstBullet = Array.isArray(workingCapitalDebt?.bullets)
    ? workingCapitalDebt.bullets.find((item: unknown) => typeof item === "string" && item.trim())
    : null;

  const checkpoints = CHECKPOINT_ORDER.map(({ key, label }) => {
    const recommendation = firstByKey.get(key);
    return {
      key,
      label,
      status: mapRecommendationPriorityToStatus(recommendation?.priority),
      metric: "Dati parziali",
      judgment:
        typeof recommendation?.title === "string" && recommendation.title.trim()
          ? recommendation.title.trim()
          : `${label}: servono numeri piu' strutturati per un giudizio netto.`,
      evidence:
        typeof recommendation?.evidence === "string" && recommendation.evidence.trim()
          ? recommendation.evidence.trim()
          : typeof firstBullet === "string" && firstBullet.trim()
            ? firstBullet.trim()
            : fallbackSummary,
    };
  });

  const recommendationTracks = CHECKPOINT_ORDER.map(({ key, label }) => {
    const recommendation = firstByKey.get(key);
    return {
      key,
      label,
      title:
        typeof recommendation?.title === "string" && recommendation.title.trim()
          ? recommendation.title.trim()
          : `Priorita' su ${label.toLowerCase()}`,
      diagnosis:
        typeof recommendation?.rationale === "string" && recommendation.rationale.trim()
          ? recommendation.rationale.trim()
          : fallbackSummary,
      action:
        typeof recommendation?.description === "string" && recommendation.description.trim()
          ? recommendation.description.trim()
          : "Servono numeri piu' strutturati per dettagliare una leva operativa credibile.",
      evidence:
        typeof recommendation?.evidence === "string" && recommendation.evidence.trim()
          ? recommendation.evidence.trim()
          : typeof firstBullet === "string" && firstBullet.trim()
            ? firstBullet.trim()
            : fallbackSummary,
    };
  });

  return {
    overview: fallbackSummary,
    checkpoints,
    recommendationTracks,
  };
}

function normalizeBusinessCeoBrief(raw: any, fallback: CeoBriefData | null): CeoBriefData | null {
  if ((!raw || typeof raw !== "object") && !fallback) return null;

  const source = raw && typeof raw === "object" ? raw : {};
  const rawCheckpoints = source?.checkpoints && typeof source.checkpoints === "object" ? source.checkpoints : null;
  const rawRecommendationTracks =
    source?.recommendationTracks && typeof source.recommendationTracks === "object"
      ? source.recommendationTracks
      : null;

  if (!rawCheckpoints || !rawRecommendationTracks) return fallback;

  const checkpointItems = CHECKPOINT_ORDER.map(({ key, label }) => {
    const fallbackItem = fallback?.checkpoints.find((item) => item.key === key);
    const rawItem = rawCheckpoints[key] && typeof rawCheckpoints[key] === "object" ? rawCheckpoints[key] : {};

    return {
      key,
      label,
      status:
        rawItem?.status === "green" || rawItem?.status === "amber" || rawItem?.status === "red"
          ? rawItem.status
          : fallbackItem?.status || "amber",
      metric:
        typeof rawItem?.metric === "string" && rawItem.metric.trim()
          ? rawItem.metric.trim()
          : fallbackItem?.metric || "Dati parziali",
      judgment:
        typeof rawItem?.judgment === "string" && rawItem.judgment.trim()
          ? rawItem.judgment.trim()
          : fallbackItem?.judgment || "",
      evidence:
        typeof rawItem?.evidence === "string" && rawItem.evidence.trim()
          ? rawItem.evidence.trim()
          : fallbackItem?.evidence || "",
    };
  });

  const recommendationTrackItems = CHECKPOINT_ORDER.map(({ key, label }) => {
    const fallbackItem = fallback?.recommendationTracks.find((item) => item.key === key);
    const rawItem =
      rawRecommendationTracks[key] && typeof rawRecommendationTracks[key] === "object"
        ? rawRecommendationTracks[key]
        : {};

    return {
      key,
      label,
      title:
        typeof rawItem?.title === "string" && rawItem.title.trim()
          ? rawItem.title.trim()
          : fallbackItem?.title || `Priorita' su ${label.toLowerCase()}`,
      diagnosis:
        typeof rawItem?.diagnosis === "string" && rawItem.diagnosis.trim()
          ? rawItem.diagnosis.trim()
          : fallbackItem?.diagnosis || "",
      action:
        typeof rawItem?.action === "string" && rawItem.action.trim()
          ? rawItem.action.trim()
          : fallbackItem?.action || "",
      evidence:
        typeof rawItem?.evidence === "string" && rawItem.evidence.trim()
          ? rawItem.evidence.trim()
          : fallbackItem?.evidence || "",
    };
  });

  return {
    overview:
      typeof source?.overview === "string" && source.overview.trim()
        ? source.overview.trim()
        : fallback?.overview || "",
    checkpoints: checkpointItems,
    recommendationTracks: recommendationTrackItems,
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

function HorizontalTrafficLight({ status }: { status: CheckPointStatus }) {
  const dotColors = ["bg-emerald-500", "bg-amber-500", "bg-rose-500"];
  const activeIndex = status === "green" ? 0 : status === "amber" ? 1 : 2;

  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-white/90 px-3 py-2 shadow-sm">
      {dotColors.map((dotClassName, index) => (
        <span
          key={`${status}-${index}`}
          className={`h-3.5 w-3.5 rounded-full ${index === activeIndex ? dotClassName : "bg-slate-200"}`}
        />
      ))}
    </div>
  );
}

function BusinessCheckPointCard({ ceoBrief }: { ceoBrief: CeoBriefData }) {
  return (
    <Card data-testid="section-check-point" className="overflow-hidden border-border/70">
      <CardHeader className="gap-3 border-b border-border/60 bg-slate-50/80">
        <CardTitle className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Check Point
        </CardTitle>
        {ceoBrief.overview && (
          <p className="max-w-3xl text-sm leading-6 text-foreground/85">{ceoBrief.overview}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-4 pt-6">
        {ceoBrief.checkpoints.map((item) => {
          const tone = getCheckpointTone(item.status);

          return (
            <div
              key={item.key}
              className="grid gap-4 rounded-3xl border border-border/70 bg-card px-5 py-5 md:grid-cols-[minmax(0,1fr)_160px] md:items-center"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    {item.label}
                  </span>
                  <span className="rounded-full border border-border/60 px-3 py-1 text-[11px] font-medium text-foreground/80">
                    {item.metric}
                  </span>
                </div>
                <p className="mt-3 text-base font-semibold leading-7 text-foreground">
                  {item.judgment}
                </p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.evidence}</p>
              </div>
              <div className="flex flex-col items-start gap-3 md:items-end">
                <HorizontalTrafficLight status={item.status} />
                <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${tone.badgeClassName}`}>
                  {tone.badge}
                </span>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function BusinessRecommendationsCard({ ceoBrief }: { ceoBrief: CeoBriefData }) {
  return (
    <Card data-testid="section-business-recommendations" className="border-border/70">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Raccomandazioni
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 md:grid-cols-2">
          {ceoBrief.recommendationTracks.map((item) => (
            <div key={item.key} className="rounded-3xl border border-border/70 bg-card p-5 shadow-sm">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {item.label}
              </div>
              <div className="mt-3 text-lg font-semibold leading-snug text-foreground">
                {item.title}
              </div>
              <div className="mt-4 space-y-4">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Insight
                  </div>
                  <p className="mt-1 text-sm leading-6 text-foreground/85">{item.diagnosis}</p>
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Cosa fare
                  </div>
                  <p className="mt-1 text-sm leading-6 text-foreground/85">{item.action}</p>
                </div>
                <div className="rounded-2xl border border-border/60 bg-slate-50/70 px-4 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Evidenza
                  </div>
                  <p className="mt-1 text-xs leading-5 text-foreground/80">{item.evidence}</p>
                </div>
              </div>
            </div>
          ))}
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

        {isBusinessMode && businessCeoBrief && (
          <>
            <BusinessCheckPointCard ceoBrief={businessCeoBrief} />
            <BusinessRecommendationsCard ceoBrief={businessCeoBrief} />
          </>
        )}

        {!isBusinessMode && descriptionText ? (
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

        {isBusinessMode && (
          <BusinessSnapshotCard
            descriptionText={descriptionText}
            aiDescriptionSources={aiDescriptionSources}
            keyProducts={aiKeyProducts}
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
