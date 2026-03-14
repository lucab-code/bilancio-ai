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
  type: "currency" | "percent";
  values: Array<number | null>;
  emphasize?: boolean;
  secondary?: boolean;
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

function formatNullableCurrency(value: unknown): string {
  return isFiniteNumeric(value) ? formatCurrency(value) : "N/D";
}

function formatNullablePercent(value: unknown): string {
  return isFiniteNumeric(value) ? `${value.toFixed(1)}%` : "N/D";
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
  const bilanciYears = Object.keys(purchasedBilanci)
    .filter((year) => {
      const documents = Array.isArray(purchasedBilanci[year]?.documents) ? purchasedBilanci[year].documents : [];
      return documents.length > 0 || Boolean(purchasedBilanci[year]?.bilancioData);
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
  const aiKeyProducts = Array.isArray(companyDetails?.aiKeyProducts)
    ? companyDetails.aiKeyProducts
        .filter((item: any) => typeof item?.name === "string" && item.name.trim())
        .slice(0, 4)
    : [];
  const keyProductsWithImages = aiKeyProducts.filter((item: any) => typeof item?.imageUrl === "string" && item.imageUrl.trim());

  let fallbackDescriptionText = "";
  if (company.denominazione) {
    fallbackDescriptionText = `${company.denominazione}`;
    if (formaGiuridica) fallbackDescriptionText += ` è una ${formaGiuridica.toLowerCase()}`;
    if (comune) fallbackDescriptionText += ` con sede a ${comune}`;
    if (provincia && provincia !== comune) fallbackDescriptionText += ` (${provincia})`;
    fallbackDescriptionText += ".";
    if (descrizione) {
      fallbackDescriptionText += ` Opera nel settore: ${descrizione.toLowerCase()}`;
      if (codiceAteco) fallbackDescriptionText += ` (ATECO ${codiceAteco})`;
      fallbackDescriptionText += ".";
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

        {/* DESCRIPTION */}
        {descriptionText && (
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
        )}

        {keyProductsWithImages.length > 0 && (
          <Card data-testid="section-key-products">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Key Products
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex flex-wrap gap-3">
                {keyProductsWithImages.map((product: any, index: number) => (
                  <div
                    key={`${product.name}-${index}`}
                    className="w-full max-w-[220px] overflow-hidden rounded-2xl border border-border/60 bg-card"
                  >
                    <div className="h-28 bg-slate-100">
                      <img
                        src={product.imageUrl}
                        alt={product.name}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    </div>
                    <div className="space-y-1 p-2">
                      <div className="text-sm font-semibold text-foreground">{product.name}</div>
                      {typeof product?.tagline === "string" && product.tagline.trim() && (
                        <p className="text-xs text-muted-foreground">{product.tagline}</p>
                      )}
                      {typeof product?.pageUrl === "string" && product.pageUrl.trim() && (
                        <a
                          href={product.pageUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                        >
                          Vedi prodotto
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

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
                Qui trovi i documenti del bilancio ottico salvati in cache.
                Se OpenAPI restituisce allegati strutturati li vedi qui; altrimenti il grafico deriva dai PDF.
                Ogni acquisto puo' coprire due annualita': anno corrente del deposito e comparativo precedente.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <Accordion type="single" collapsible className="w-full">
                {bilanciYears.map((year) => {
                  const summary = bilanci[year];
                  const purchased = purchasedBilanci[year];
                  const documentSource = typeof purchased?.bilancioData?.source === "string" ? purchased.bilancioData.source : "";
                  const structuredPreview =
                    purchased?.bilancioData?.structuredData ||
                    (purchased?.bilancioData?.periods ? purchased.bilancioData : null);
                  const coveredYearsForPurchase = Array.isArray((purchased as any)?.bilancioData?.coveredYears)
                    ? ((purchased as any).bilancioData.coveredYears as string[])
                    : Object.keys(((purchased as any)?.bilancioData?.periods || {}) as Record<string, unknown>).sort();
                  const documentEntries = (purchased?.documents || [])
                    .map((document, index) => ({ document, index }));
                  const pdfDocuments = documentEntries.filter(({ document }) => isPdfDocument(document));
                  const structuredDocuments = documentEntries.filter(({ document }) => isStructuredBilancioDocument(document));
                  const hasStructuredPreview = Boolean(structuredPreview && typeof structuredPreview === "object");

                  return (
                    <AccordionItem key={year} value={year}>
                      <AccordionTrigger className="text-left">
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <span className="font-semibold">{year}</span>
                          <div className="flex flex-wrap gap-2">
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
                            <span>Salvato il {formatDateTime(purchased?.fetchedAt)}</span>
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
                              {documentEntries.map(({ document, index }) => {
                                const params = new URLSearchParams();
                                if (documentSource) params.set("source", documentSource);
                                if (token) params.set("access_token", token);
                                const queryString = params.toString();

                                return (
                                <Button
                                  key={`${year}-${index}`}
                                  asChild
                                  size="sm"
                                  variant={isStructuredBilancioDocument(document) ? "default" : "outline"}
                                  className="gap-2"
                                >
                                  <a
                                    href={`${API_BASE}/api/bilancio/cached/${encodeURIComponent(companyIdForFiles)}/${encodeURIComponent(year)}/${index}${queryString ? `?${queryString}` : ""}`}
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
        {/* ── PREMIUM SECTIONS ── */}

        {/* Key Metrics */}
        {data.analysis?.keyMetrics && data.analysis.keyMetrics.length > 0 && (
          <Card data-testid="section-key-metrics">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Indicatori Chiave
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {data.analysis.keyMetrics.map((metric: any, i: number) => (
                  <div key={i} className="rounded-lg border border-border/60 p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{metric.label}</span>
                      {metric.trend === "up" && <TrendingUp className="w-3.5 h-3.5 text-emerald-500" />}
                      {metric.trend === "down" && <TrendingDown className="w-3.5 h-3.5 text-red-500" />}
                      {metric.trend === "stable" && <Minus className="w-3.5 h-3.5 text-muted-foreground" />}
                    </div>
                    <div className="text-lg font-bold">{metric.value}</div>
                    {metric.description && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">{metric.description}</p>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* AI Analysis Summary */}
        {data.analysis?.summary && (
          <Card data-testid="section-ai-summary">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Sintesi Analisi AI
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-line text-sm text-foreground/90 leading-relaxed">{data.analysis.summary}</p>
            </CardContent>
          </Card>
        )}

        {/* Income Statement Analysis */}
        {data.analysis?.incomeStatementAnalysis && (
          <Card data-testid="section-income-statement">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Analisi Conto Economico
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-line text-sm text-foreground/90 leading-relaxed">{data.analysis.incomeStatementAnalysis}</p>
            </CardContent>
          </Card>
        )}

        {/* Balance Sheet Analysis */}
        {data.analysis?.balanceSheetAnalysis && (
          <Card data-testid="section-balance-sheet">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Analisi Stato Patrimoniale
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-line text-sm text-foreground/90 leading-relaxed">{data.analysis.balanceSheetAnalysis}</p>
            </CardContent>
          </Card>
        )}

        {/* Cash Flow Analysis */}
        {data.analysis?.cashFlowAnalysis && (
          <Card data-testid="section-cash-flow-analysis">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Analisi Cash Flow
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-line text-sm text-foreground/90 leading-relaxed">{data.analysis.cashFlowAnalysis}</p>
            </CardContent>
          </Card>
        )}

        {/* SWOT Analysis — PREMIUM */}
        {data.analysis && (data.analysis.strengths?.length > 0 || data.analysis.weaknesses?.length > 0 || data.analysis.opportunities?.length > 0 || data.analysis.threats?.length > 0) && (
          <PremiumGate isUnlocked={isPremium} featureLabel="Analisi SWOT">
            <Card data-testid="section-swot">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Analisi SWOT
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {data.analysis.strengths?.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-emerald-600">
                        <ShieldCheck className="w-4 h-4" />
                        <span className="text-xs font-semibold uppercase">Punti di Forza</span>
                      </div>
                      <ul className="space-y-1.5">
                        {data.analysis.strengths.map((s: string, i: number) => (
                          <li key={i} className="text-sm text-foreground/90 flex gap-2">
                            <span className="text-emerald-500 mt-1 shrink-0">+</span>
                            {s}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {data.analysis.weaknesses?.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-red-500">
                        <AlertTriangle className="w-4 h-4" />
                        <span className="text-xs font-semibold uppercase">Punti di Debolezza</span>
                      </div>
                      <ul className="space-y-1.5">
                        {data.analysis.weaknesses.map((w: string, i: number) => (
                          <li key={i} className="text-sm text-foreground/90 flex gap-2">
                            <span className="text-red-400 mt-1 shrink-0">-</span>
                            {w}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {data.analysis.opportunities?.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-blue-500">
                        <Target className="w-4 h-4" />
                        <span className="text-xs font-semibold uppercase">Opportunità</span>
                      </div>
                      <ul className="space-y-1.5">
                        {data.analysis.opportunities.map((o: string, i: number) => (
                          <li key={i} className="text-sm text-foreground/90 flex gap-2">
                            <span className="text-blue-400 mt-1 shrink-0">*</span>
                            {o}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {data.analysis.threats?.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-amber-500">
                        <AlertTriangle className="w-4 h-4" />
                        <span className="text-xs font-semibold uppercase">Minacce</span>
                      </div>
                      <ul className="space-y-1.5">
                        {data.analysis.threats.map((t: string, i: number) => (
                          <li key={i} className="text-sm text-foreground/90 flex gap-2">
                            <span className="text-amber-400 mt-1 shrink-0">!</span>
                            {t}
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

        {/* Recommendations — PREMIUM */}
        {data.analysis?.recommendations?.length > 0 && (
          <PremiumGate isUnlocked={isPremium} featureLabel="Raccomandazioni Strategiche">
            <Card data-testid="section-recommendations">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Raccomandazioni Strategiche
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3">
                  {data.analysis.recommendations.map((rec: string, i: number) => (
                    <li key={i} className="flex gap-3 text-sm text-foreground/90">
                      <div className="shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold mt-0.5">
                        {i + 1}
                      </div>
                      {rec}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </PremiumGate>
        )}

        {/* Market Comparison — PREMIUM */}
        {data.analysis?.marketComparison && (
          <PremiumGate isUnlocked={isPremium} featureLabel="Confronto di Mercato">
            <Card data-testid="section-market-comparison">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Confronto di Mercato
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-line text-sm text-foreground/90 leading-relaxed">{data.analysis.marketComparison}</p>
              </CardContent>
            </Card>
          </PremiumGate>
        )}

        {/* Competitors — PREMIUM */}
        {data.competitors?.competitors?.length > 0 && (
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
