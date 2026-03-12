import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import {
  ArrowLeft, Building2, MapPin, Mail, Phone, Globe, Loader2, Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PerplexityAttribution } from "@/components/PerplexityAttribution";
import { useAuth } from "@/App";

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

interface ChartData {
  years: string[];
  revenues: number[];
  ebitdas: number[];
  ebitdaDetails: Record<string, EbitdaYear>;
  bilanci: Record<string, any>;
}

// Revenue vs EBITDA Chart with proper tooltip
function RevenueEbitdaChart({ chartData }: { chartData: ChartData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const barLayoutRef = useRef<Array<{
    groupCenterX: number;
    groupLeft: number;
    groupWidth: number;
    baseline: number;
    revBarY: number;
    ebitdaBarY: number;
  }>>([]);

  const { years, revenues, ebitdas, ebitdaDetails, bilanci } = chartData;

  const drawChart = useCallback((highlightIdx: number | null) => {
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
    const padTop = 20;
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

    const layouts: typeof barLayoutRef.current = [];

    years.forEach((year, i) => {
      const gcx = padLeft + groupW * i + groupW / 2;
      const baseline = padTop + chartH;
      const isActive = highlightIdx === i;
      const isDim = highlightIdx !== null && highlightIdx !== i;

      // Vertical guide line on active
      if (isActive) {
        ctx.strokeStyle = "rgba(59,130,246,0.15)";
        ctx.lineWidth = groupW * 0.8;
        ctx.beginPath();
        ctx.moveTo(gcx, padTop);
        ctx.lineTo(gcx, baseline);
        ctx.stroke();
        ctx.lineWidth = 1;
      }

      // Revenue bar (blue)
      const revH = revenues[i] > 0 ? Math.max((revenues[i] / maxVal) * chartH, 2) : 0;
      const revX = gcx - barW - gap / 2;
      const revY = baseline - revH;

      if (revH > 0) {
        ctx.globalAlpha = isDim ? 0.3 : 1;
        ctx.fillStyle = isActive ? "#60A5FA" : "#3B82F6";
        ctx.beginPath();
        ctx.moveTo(revX, baseline);
        ctx.lineTo(revX, revY + radius);
        ctx.quadraticCurveTo(revX, revY, revX + radius, revY);
        ctx.lineTo(revX + barW - radius, revY);
        ctx.quadraticCurveTo(revX + barW, revY, revX + barW, revY + radius);
        ctx.lineTo(revX + barW, baseline);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // EBITDA bar (orange)
      const ebitdaH = ebitdas[i] > 0 ? Math.max((ebitdas[i] / maxVal) * chartH, 2) : 0;
      const ebitdaX = gcx + gap / 2;
      const ebitdaY = baseline - ebitdaH;

      if (ebitdaH > 0) {
        ctx.globalAlpha = isDim ? 0.3 : 1;
        ctx.fillStyle = isActive ? "#FBBF24" : "#F59E0B";
        ctx.beginPath();
        ctx.moveTo(ebitdaX, baseline);
        ctx.lineTo(ebitdaX, ebitdaY + radius);
        ctx.quadraticCurveTo(ebitdaX, ebitdaY, ebitdaX + radius, ebitdaY);
        ctx.lineTo(ebitdaX + barW - radius, ebitdaY);
        ctx.quadraticCurveTo(ebitdaX + barW, ebitdaY, ebitdaX + barW, ebitdaY + radius);
        ctx.lineTo(ebitdaX + barW, baseline);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Year label
      ctx.save();
      ctx.globalAlpha = isDim ? 0.3 : 1;
      ctx.fillStyle = isActive ? "#1e293b" : "rgba(128,128,128,0.7)";
      ctx.font = isActive ? "bold 11px 'General Sans', system-ui, sans-serif" : "10px 'General Sans', system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.translate(gcx, baseline + 6);
      ctx.rotate(-Math.PI / 6);
      ctx.fillText(year, 0, 0);
      ctx.restore();

      layouts.push({
        groupCenterX: gcx,
        groupLeft: gcx - groupW / 2,
        groupWidth: groupW,
        baseline,
        revBarY: revY,
        ebitdaBarY: ebitdaY,
      });
    });

    barLayoutRef.current = layouts;
  }, [years, revenues, ebitdas]);

  useEffect(() => {
    drawChart(selectedIndex);
  }, [drawChart, selectedIndex]);

  // Resize handler
  useEffect(() => {
    const handleResize = () => drawChart(selectedIndex);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [drawChart, selectedIndex]);

  const getIndexFromEvent = useCallback((clientX: number, clientY: number): number | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    for (let i = 0; i < barLayoutRef.current.length; i++) {
      const lay = barLayoutRef.current[i];
      if (x >= lay.groupLeft && x < lay.groupLeft + lay.groupWidth) {
        return i;
      }
    }
    return null;
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const idx = getIndexFromEvent(e.clientX, e.clientY);
    setSelectedIndex(prev => prev === idx ? null : idx);
  }, [getIndexFromEvent]);

  const handleTouch = useCallback((e: React.TouchEvent) => {
    if (e.changedTouches.length > 0) {
      const t = e.changedTouches[0];
      const idx = getIndexFromEvent(t.clientX, t.clientY);
      setSelectedIndex(prev => prev === idx ? null : idx);
    }
  }, [getIndexFromEvent]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const idx = getIndexFromEvent(e.clientX, e.clientY);
    canvas.style.cursor = idx !== null ? "pointer" : "default";
  }, [getIndexFromEvent]);

  if (years.length === 0) return null;

  // Selected year data for the info panel below the chart
  const sel = selectedIndex !== null ? {
    year: years[selectedIndex],
    revenue: revenues[selectedIndex],
    ebitda: ebitdas[selectedIndex],
    detail: ebitdaDetails[years[selectedIndex]],
    b: bilanci[years[selectedIndex]],
  } : null;

  return (
    <Card data-testid="chart-revenue-ebitda">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Ricavi vs EBITDA
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div ref={containerRef} className="relative">
          <canvas
            ref={canvasRef}
            className="w-full"
            style={{ height: "280px" }}
            onClick={handleClick}
            onTouchEnd={handleTouch}
            onMouseMove={handleMouseMove}
            data-testid="chart-canvas"
          />
        </div>

        {/* Legend */}
        <div className="flex items-center gap-5 justify-center">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-sm bg-blue-500" />
            <span className="text-xs text-muted-foreground">Ricavi</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-sm bg-amber-500" />
            <span className="text-xs text-muted-foreground">EBITDA (stima AI)</span>
          </div>
        </div>

        {/* Selected year info panel — below the chart, like Yahoo Finance */}
        {sel ? (
          <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-border/50 p-4 space-y-3 fade-in" data-testid="chart-detail-panel">
            <div className="flex items-center justify-between">
              <span className="font-bold text-base">{sel.year}</span>
              {sel.detail?.confidence && (
                <Badge variant="outline" className="text-[10px]">
                  Confidenza: {sel.detail.confidence}
                </Badge>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-0.5">
                <div className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-sm bg-blue-500" />
                  <span className="text-xs text-muted-foreground">Ricavi</span>
                </div>
                <div className="text-lg font-bold tabular-nums">
                  {sel.revenue > 0 ? formatCurrency(sel.revenue) : "N/D"}
                </div>
              </div>

              <div className="space-y-0.5">
                <div className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-sm bg-amber-500" />
                  <span className="text-xs text-muted-foreground">EBITDA</span>
                </div>
                <div className="text-lg font-bold tabular-nums">
                  {sel.ebitda > 0 ? formatCurrency(sel.ebitda) : "N/D"}
                </div>
                {sel.detail?.margin_pct != null && (
                  <span className="text-xs text-muted-foreground">
                    Margine: {sel.detail.margin_pct.toFixed(1)}%
                  </span>
                )}
              </div>
            </div>

            {/* Extra data from bilancio */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 pt-2 border-t border-border/50">
              {sel.b?.totale_attivo > 0 && (
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Totale Attivo</div>
                  <div className="text-sm font-semibold tabular-nums">{formatCurrency(sel.b.totale_attivo)}</div>
                </div>
              )}
              {sel.b?.patrimonio_netto > 0 && (
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Patrimonio Netto</div>
                  <div className="text-sm font-semibold tabular-nums">{formatCurrency(sel.b.patrimonio_netto)}</div>
                </div>
              )}
              {sel.b?.costo_personale > 0 && (
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Costo Personale</div>
                  <div className="text-sm font-semibold tabular-nums">{formatCurrency(sel.b.costo_personale)}</div>
                </div>
              )}
              {sel.b?.dipendenti > 0 && (
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Dipendenti</div>
                  <div className="text-sm font-semibold tabular-nums">{sel.b.dipendenti.toLocaleString("it-IT")}</div>
                </div>
              )}
              {sel.b?.capitale_sociale > 0 && (
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Capitale Sociale</div>
                  <div className="text-sm font-semibold tabular-nums">{formatCurrency(sel.b.capitale_sociale)}</div>
                </div>
              )}
            </div>

            {/* AI method explanation */}
            {sel.detail?.method && (
              <div className="flex items-start gap-1.5 pt-1">
                <Info className="w-3 h-3 text-muted-foreground mt-0.5 shrink-0" />
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  {sel.detail.method}
                </p>
              </div>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground/60 text-center">
            Tocca un anno per i dettagli
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function ResultsPage() {
  const [, setLocation] = useLocation();
  const [data, setData] = useState<ResultData | null>(null);
  const [ebitdaData, setEbitdaData] = useState<{ ebitda: Record<string, EbitdaYear>; revenue: Record<string, number> } | null>(null);
  const [isLoadingEbitda, setIsLoadingEbitda] = useState(false);
  const { token } = useAuth();

  useEffect(() => {
    const stored = (window as any).__bilancioResults;
    if (stored) {
      setData(stored);
    } else {
      setLocation("/");
    }
  }, [setLocation]);

  // Fetch EBITDA estimates when we have company data
  useEffect(() => {
    if (!data) return;
    const bilanci = data.companyDetails?.dettaglio?.bilanci;
    if (!bilanci || Object.keys(bilanci).length === 0) return;

    // Check if any year has revenue
    const hasRevenue = Object.values(bilanci).some((b: any) => b.fatturato > 0);
    if (!hasRevenue) return;

    setIsLoadingEbitda(true);

    const headers: any = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    fetch(`${API_BASE}/api/company/estimate-ebitda`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        companyName: data.company.denominazione,
        sector: data.companyDetails?.dettaglio?.descrizione_ateco || "",
        bilanci,
      }),
    })
      .then(res => res.json())
      .then(result => {
        if (result.data) {
          setEbitdaData(result.data);
        }
      })
      .catch(err => console.error("EBITDA fetch error:", err))
      .finally(() => setIsLoadingEbitda(false));
  }, [data, token]);

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Caricamento risultati...</p>
      </div>
    );
  }

  const { company, companyDetails } = data;
  const bilanci = companyDetails?.dettaglio?.bilanci || {};
  const yearsWithData = Object.keys(bilanci).filter(
    y => bilanci[y].fatturato > 0 || bilanci[y].patrimonio_netto > 0
  ).sort();
  const hasFinancials = yearsWithData.length > 0;

  // Build chart data from AI EBITDA
  let chartData: ChartData | null = null;
  if (ebitdaData && hasFinancials) {
    const years = yearsWithData;
    const revenues = years.map(y => {
      // Prefer AI-returned revenue (in case it cleaned the data), fallback to bilanci
      return ebitdaData.revenue?.[y] || bilanci[y]?.fatturato || 0;
    });
    const ebitdas = years.map(y => ebitdaData.ebitda?.[y]?.value || 0);
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
    revenues: yearsWithData.map(y => bilanci[y]?.fatturato || 0),
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

  let descriptionText = "";
  if (company.denominazione) {
    descriptionText = `${company.denominazione}`;
    if (formaGiuridica) descriptionText += ` è una ${formaGiuridica.toLowerCase()}`;
    if (comune) descriptionText += ` con sede a ${comune}`;
    if (provincia && provincia !== comune) descriptionText += ` (${provincia})`;
    descriptionText += ".";
    if (descrizione) {
      descriptionText += ` Opera nel settore: ${descrizione.toLowerCase()}`;
      if (codiceAteco) descriptionText += ` (ATECO ${codiceAteco})`;
      descriptionText += ".";
    }
    if (hasFinancials) {
      const lastYear = yearsWithData[yearsWithData.length - 1];
      const lastRevenue = bilanci[lastYear]?.fatturato;
      const lastEmployees = bilanci[lastYear]?.dipendenti;
      if (lastRevenue && lastRevenue > 0) {
        descriptionText += ` Nell'ultimo esercizio disponibile (${lastYear}) ha registrato ricavi per ${formatCurrency(lastRevenue)}`;
        if (lastEmployees && lastEmployees > 0) {
          descriptionText += ` con ${lastEmployees} dipendenti`;
        }
        descriptionText += ".";
      }
    }
  }

  const activeChartData = chartData || fallbackChartData;

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
              <p className="text-sm text-foreground/90 leading-relaxed">
                {descriptionText}
              </p>
            </CardContent>
          </Card>
        )}

        {/* CHART */}
        {isLoadingEbitda && (
          <Card>
            <CardContent className="py-8 flex flex-col items-center gap-3">
              <Loader2 className="w-5 h-5 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">AI sta calcolando l'EBITDA...</p>
            </CardContent>
          </Card>
        )}

        {!isLoadingEbitda && activeChartData && activeChartData.years.length > 0 && (
          <RevenueEbitdaChart chartData={activeChartData} />
        )}
      </div>

      <footer className="border-t border-border/50 py-6 px-6 mt-8">
        <div className="max-w-3xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground">
            Dati forniti da Camera di Commercio tramite OpenAPI.it
          </p>
          <PerplexityAttribution />
        </div>
      </footer>
    </div>
  );
}
