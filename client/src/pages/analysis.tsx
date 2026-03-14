import { useState, useCallback, useRef, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { Search, Building2, Users, MapPin, ArrowLeft, Loader2, Plus, X, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/App";
import { PoweredByAttribution } from "@/components/PoweredByAttribution";

// API base for deployed proxy
const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

interface CompanyResult {
  id: string;
  denominazione: string;
  indirizzo?: string;
  comune?: string;
  provincia?: string;
  cap?: string;
  piva?: string;
  cf?: string;
  stato_attivita?: string;
}

type FinancialDataState = {
  bilanci?: Record<string, any>;
  bilancioData?: any;
  purchasedBilanci?: Record<string, { year: string; fetchedAt: string; documents: any[]; bilancioData: any }>;
  latestPurchasedYear?: string | null;
  targetYears?: string[];
};

type WalletState = {
  balanceCents: number;
  currency: string;
  businessAnalysisCents: number;
};

const ANALYSIS_WAIT_MESSAGES = [
  "Stiamo costruendo il profilo societario e ripulendo i dati grezzi.",
  "Incrociamo bilanci, anagrafica e segnali pubblici per evitare output vuoti.",
  "L'AI sta trasformando numeri sparsi in un memo leggibile da investitore.",
  "Prepariamo grafico, descrizione e key takeaways in un unico passaggio.",
] as const;

function formatRemainingMinutes(seconds: number | null): string {
  if (seconds === null) return "Stiamo ancora elaborando oltre il tempo stimato";
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `~${minutes} min rimanenti`;
}

function formatCents(value: number): string {
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
  }).format((value || 0) / 100);
}

function getHashQueryParam(name: string): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  const queryIndex = hash.indexOf("?");
  if (queryIndex === -1) return null;
  const query = hash.slice(queryIndex + 1);
  return new URLSearchParams(query).get(name);
}

function getTargetBilancioYears(bilanci?: Record<string, any>): string[] {
  if (!bilanci || typeof bilanci !== "object") return [];

  const years = Object.keys(bilanci)
    .map((year) => Number.parseInt(year, 10))
    .filter((year) => Number.isFinite(year))
    .sort((a, b) => b - a);

  if (years.length === 0) return [];

  const yearSet = new Set(years);
  const latestYear = years[0];
  return [latestYear, latestYear - 2]
    .filter((year) => yearSet.has(year))
    .map(String);
}

function getAnalysisProgressState(
  step: string,
  mode: "business" | "competitor",
  stepElapsedSeconds: number,
): {
  progress: number;
  remainingSeconds: number | null;
  isOvertime: boolean;
} {
  const normalized = step.toLowerCase();
  let minProgress = 12;
  let maxProgress = 32;
  let expectedSeconds = 18;

  if (!normalized) {
    minProgress = 8;
    maxProgress = 18;
    expectedSeconds = 8;
  } else if (normalized.includes("credito")) {
    minProgress = 10;
    maxProgress = 18;
    expectedSeconds = 8;
  } else if (normalized.includes("dettagli") || normalized.includes("bilanci ottici")) {
    minProgress = mode === "business" ? 24 : 22;
    maxProgress = mode === "business" ? 92 : 52;
    expectedSeconds = mode === "business" ? 150 : 24;
  } else if (normalized.includes("richiesta bilancio") || normalized.includes("scarico bilanci")) {
    minProgress = 36;
    maxProgress = 80;
    expectedSeconds = 90;
  } else if (normalized.includes("competitor")) {
    minProgress = 56;
    maxProgress = 84;
    expectedSeconds = 45;
  } else if (normalized.includes("chatgpt") || normalized.includes("ai")) {
    minProgress = 72;
    maxProgress = 95;
    expectedSeconds = 55;
  } else if (normalized.includes("cache")) {
    minProgress = 88;
    maxProgress = 97;
    expectedSeconds = 12;
  }

  const clampedRatio = Math.min(stepElapsedSeconds / expectedSeconds, 1);
  const easedRatio = 1 - Math.pow(1 - clampedRatio, 1.15);
  let progress = Math.round(minProgress + (maxProgress - minProgress) * easedRatio);
  let remainingSeconds: number | null = Math.max(expectedSeconds - stepElapsedSeconds, 1);
  let isOvertime = false;

  if (stepElapsedSeconds >= expectedSeconds) {
    isOvertime = true;
    remainingSeconds = null;
    const overtimeSeconds = stepElapsedSeconds - expectedSeconds;
    progress = Math.max(progress, Math.min(97, maxProgress + 1 + Math.floor(overtimeSeconds / 20)));
  }

  return { progress, remainingSeconds, isOvertime };
}

// Shared search hook to avoid code duplication
function useCompanySearch(token: string | null) {
  const [results, setResults] = useState<CompanyResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const search = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([]);
      setShowDropdown(false);
      return;
    }
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsSearching(true);
    setResults([]);
    setShowDropdown(true);

    try {
      const res = await fetch(
        `${API_BASE}/api/company/search?q=${encodeURIComponent(q)}&mode=sse`,
        {
          signal: controller.signal,
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        }
      );
      if (!res.ok) {
        throw new Error(`Search request failed with status ${res.status}`);
      }
      if (controller.signal.aborted) return;

      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done || controller.signal.aborted) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const payload = JSON.parse(line.slice(6));
            if (payload.company && !controller.signal.aborted) {
              setResults(prev => {
                if (prev.find(c => c.id === payload.company.id)) return prev;
                return [...prev, payload.company];
              });
            }
            if (payload.done) {
              if (!controller.signal.aborted) setIsSearching(false);
            }
          } catch {}
        }
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      console.error("Search failed", e);
    } finally {
      if (!controller.signal.aborted) setIsSearching(false);
    }
  }, [token]);

  const debouncedSearch = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(q), 300);
  }, [search]);

  const cancel = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  return { results, isSearching, showDropdown, setShowDropdown, setResults, debouncedSearch, cancel };
}

export default function AnalysisPage() {
  const [, params] = useRoute("/analysis/:mode");
  const [, setLocation] = useLocation();
  const mode = params?.mode as "business" | "competitor";
  const { toast } = useToast();
  const { token } = useAuth();

  // Search state
  const [query, setQuery] = useState("");
  const [selectedCompany, setSelectedCompany] = useState<CompanyResult | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);

  const mainSearch = useCompanySearch(token);

  // Competitor mode state
  const [competitorMode, setCompetitorMode] = useState<"provide" | "ai">("ai");
  const [competitorSearchQuery, setCompetitorSearchQuery] = useState("");
  const [selectedCompetitors, setSelectedCompetitors] = useState<CompanyResult[]>([]);
  const competitorSearchRef = useRef<HTMLDivElement>(null);
  const compSearch = useCompanySearch(token);

  // Analysis state
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisStep, setAnalysisStep] = useState("");
  const [walletState, setWalletState] = useState<WalletState | null>(null);
  const [isLoadingWallet, setIsLoadingWallet] = useState(false);
  const [waitMessageIndex, setWaitMessageIndex] = useState(0);
  const [stepElapsedSeconds, setStepElapsedSeconds] = useState(0);
  const stepStartedAtRef = useRef<number | null>(null);
  const lastAnalysisStepRef = useRef("");

  // Click outside to close dropdowns
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        mainSearch.setShowDropdown(false);
      }
      if (competitorSearchRef.current && !competitorSearchRef.current.contains(e.target as Node)) {
        compSearch.setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleQueryChange = (value: string) => {
    setQuery(value);
    setSelectedCompany(null);
    mainSearch.debouncedSearch(value);
  };

  const selectCompany = (company: CompanyResult) => {
    setSelectedCompany(company);
    setQuery(company.denominazione);
    mainSearch.setShowDropdown(false);
  };

  const handleCompetitorQueryChange = (value: string) => {
    setCompetitorSearchQuery(value);
    compSearch.debouncedSearch(value);
  };

  const addCompetitor = (company: CompanyResult) => {
    if (!selectedCompetitors.find(c => c.id === company.id)) {
      setSelectedCompetitors(prev => [...prev, company]);
    }
    setCompetitorSearchQuery("");
    compSearch.setShowDropdown(false);
  };

  const removeCompetitor = (id: string) => {
    setSelectedCompetitors(prev => prev.filter(c => c.id !== id));
  };

  // Helper for authed requests
  const authFetch = (url: string, opts: RequestInit = {}) => {
    const headers: any = { ...(opts.headers || {}) };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return fetch(url, { ...opts, headers });
  };

  const loadWalletState = useCallback(async () => {
    if (!token || mode !== "business") return;

    setIsLoadingWallet(true);
    try {
      const res = await authFetch(`${API_BASE}/api/billing/me`);
      const payload = await res.json().catch(() => ({}));
      if (res.ok && payload?.data) {
        setWalletState(payload.data);
      }
    } catch (error) {
      console.error("Wallet load failed", error);
    } finally {
      setIsLoadingWallet(false);
    }
  }, [token, mode]);

  const redirectToCheckout = useCallback(async (topUpCents?: number) => {
    const res = await authFetch(`${API_BASE}/api/billing/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topUpCents }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload?.data?.url) {
      throw new Error(payload?.error || "Impossibile avviare il pagamento");
    }

    window.location.href = payload.data.url;
  }, [token]);

  useEffect(() => {
    loadWalletState();
  }, [loadWalletState]);

  useEffect(() => {
    if (mode !== "business") return;

    const billingState = getHashQueryParam("billing");
    if (!billingState) return;

    if (billingState === "success") {
      toast({ title: "Pagamento completato", description: "Credito aggiornato. Ora puoi lanciare l'analisi." });
      loadWalletState();
    } else if (billingState === "cancelled") {
      toast({ title: "Pagamento annullato", description: "Nessun credito e' stato addebitato.", variant: "destructive" });
    }

    const hash = window.location.hash.replace(/^#/, "");
    const [path] = hash.split("?");
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${path}`);
  }, [mode, loadWalletState, toast]);

  useEffect(() => {
    if (!isAnalyzing) {
      setWaitMessageIndex(0);
      setStepElapsedSeconds(0);
      stepStartedAtRef.current = null;
      lastAnalysisStepRef.current = "";
      return;
    }

    const now = Date.now();
    if (lastAnalysisStepRef.current !== analysisStep) {
      lastAnalysisStepRef.current = analysisStep;
      stepStartedAtRef.current = now;
      setStepElapsedSeconds(0);
    }

    const updateTimers = () => {
      const stepStart = stepStartedAtRef.current ?? now;
      setStepElapsedSeconds(Math.max(0, Math.floor((Date.now() - stepStart) / 1000)));
    };

    updateTimers();
    const timerIntervalId = window.setInterval(updateTimers, 1000);
    const messageIntervalId = window.setInterval(() => {
      setWaitMessageIndex((current) => (current + 1) % ANALYSIS_WAIT_MESSAGES.length);
    }, 2400);

    return () => {
      window.clearInterval(timerIntervalId);
      window.clearInterval(messageIntervalId);
    };
  }, [analysisStep, isAnalyzing]);

  // Start analysis
  const startAnalysis = async () => {
    if (!selectedCompany) {
      toast({ title: "Seleziona un'azienda", description: "Cerca e seleziona un'azienda dalla lista.", variant: "destructive" });
      return;
    }

    setIsAnalyzing(true);

    try {
      if (mode === "business") {
        setAnalysisStep("Verifico credito disponibile...");
        const walletRes = await authFetch(`${API_BASE}/api/billing/me`);
        const walletPayload = await walletRes.json().catch(() => ({}));
        const balanceCents = walletPayload?.data?.balanceCents ?? walletState?.balanceCents ?? 0;
        const analysisCostCents = walletPayload?.data?.businessAnalysisCents ?? walletState?.businessAnalysisCents ?? 0;

        if (!walletRes.ok) {
          throw new Error(walletPayload?.error || "Errore nel recupero del credito");
        }

        setWalletState(walletPayload.data);

        if (analysisCostCents > 0 && balanceCents < analysisCostCents) {
          const missingCents = analysisCostCents - balanceCents;
          setIsAnalyzing(false);
          toast({
            title: "Credito insufficiente",
            description: `Servono ${formatCents(missingCents)} per avviare l'analisi business.`,
            variant: "destructive",
          });
          await redirectToCheckout(missingCents);
          return;
        }
      }

      let companyDetails = null;
      if (mode !== "business") {
        setAnalysisStep("Recupero dettagli azienda...");
        try {
          const detailRes = await authFetch(`${API_BASE}/api/company/${selectedCompany.id}/details`);
          if (detailRes.ok) {
            const detailData = await detailRes.json();
            companyDetails = detailData.data;
          }
        } catch (e) {
          console.log("Could not fetch details, continuing...");
        }
      }

      if (mode === "business") {
        setAnalysisStep("Recupero dettagli azienda e bilanci ottici...");
        const fullRes = await authFetch(`${API_BASE}/api/company/full-chart-data`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyId: selectedCompany.id,
            vatCode: selectedCompany.piva,
            taxCode: selectedCompany.cf,
          }),
        });

        const fullData = await fullRes.json();
        if (!fullRes.ok || !fullData?.data) {
          if (fullRes.status === 402 && fullData?.code === "INSUFFICIENT_CREDIT") {
            setIsAnalyzing(false);
            const missingCents = typeof fullData?.missingCents === "number"
              ? fullData.missingCents
              : walletState?.businessAnalysisCents || 0;
            toast({
              title: "Credito insufficiente",
              description: `Servono ${formatCents(missingCents)} per avviare l'analisi business.`,
              variant: "destructive",
            });
            await redirectToCheckout(missingCents);
            return;
          }
          throw new Error(fullData?.error || "Errore nel recupero dati da bilancio ottico");
        }

        if (walletState) {
          setWalletState({
            ...walletState,
            balanceCents: Math.max(0, walletState.balanceCents - (walletState.businessAnalysisCents || 0)),
          });
        }

        const resultData = {
          company: selectedCompany,
          companyDetails: fullData.data.companyDetails,
          financialData: fullData.data.financialData,
          analysis: null,
          competitors: null,
          mode,
        };

        (window as any).__bilancioResults = resultData;
        setLocation("/results");
        return;
      }

      // Step 2: Request bilancio riclassificato
      setAnalysisStep("Richiesta bilancio riclassificato alla Camera di Commercio...");
      let financialData: FinancialDataState | null = null;
      const taxCode = selectedCompany.cf || selectedCompany.piva;
      const targetYears = getTargetBilancioYears(companyDetails?.dettaglio?.bilanci);
      
      if (taxCode) {
        try {
          if (targetYears.length > 0) {
            setAnalysisStep(`Scarico bilanci riclassificati ${targetYears.join(", ")}...`);
          }

          const bilancioRes = await authFetch(`${API_BASE}/api/bilancio/ensure-years`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              companyId: selectedCompany.id,
              taxCode,
              targetYears,
              bilanci: companyDetails?.dettaglio?.bilanci || {},
            }),
          });
          const bilancioData = await bilancioRes.json();

          if (bilancioRes.ok && bilancioData.data) {
            setAnalysisStep(
              bilancioData.data.downloadedYears?.length > 0
                ? `Bilanci riclassificati salvati in cache: ${bilancioData.data.downloadedYears.join(", ")}`
                : "Bilanci riclassificati trovati in cache."
            );
            financialData = {
              bilanci: bilancioData.data.bilanci,
              purchasedBilanci: bilancioData.data.purchasedBilanci || {},
              bilancioData: bilancioData.data.bilancioData || null,
              latestPurchasedYear: bilancioData.data.latestPurchasedYear || null,
              targetYears: bilancioData.data.targetYears || targetYears,
            };
          } else {
            console.log("Could not ensure target bilanci riclassificati", bilancioData?.error);
          }
        } catch (e) {
          console.log("Bilancio request failed, continuing with company data...");
        }
      }

      // Step 3: Find competitors (if AI mode)
      let competitors = null;
      if (mode === "competitor") {
        if (competitorMode === "ai") {
          setAnalysisStep("AI sta identificando i competitor...");
          try {
            const compRes = await authFetch(`${API_BASE}/api/find-competitors`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                companyName: selectedCompany.denominazione,
                companyDetails,
              }),
            });
            const compData = await compRes.json();
            competitors = compData.competitors;
          } catch {
            console.log("Could not find competitors");
          }
        } else {
          competitors = selectedCompetitors.map(c => ({
            name: c.denominazione,
            reason: "Selezionato dall'utente",
          }));
        }
      }

      // Step 4: ChatGPT analizza i dati scaricati da OpenAPI (dettaglio azienda + bilancio)
      setAnalysisStep("ChatGPT analizza i dati OpenAPI...");
      const analyzeRes = await authFetch(`${API_BASE}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: selectedCompany.denominazione,
          companyDetails: {
            ...companyDetails,
            bilanci: companyDetails?.dettaglio?.bilanci,
          },
          financialData: financialData ?? {},
          mode,
          competitors,
        }),
      });
      if (!analyzeRes.ok) {
        const errBody = await analyzeRes.json().catch(() => ({}));
        throw new Error(errBody.error || analyzeRes.statusText || "Errore analisi AI");
      }
      const analyzeData = await analyzeRes.json();

      // Garantire che i risultati abbiano sempre bilanci per il grafico EBITDA (da dettaglio, cache o bilancio scaricato)
      const bilanciFromDetails = companyDetails?.dettaglio?.bilanci || {};
      const bilanciFromCache = financialData?.bilanci || {};
      let bilanciToUse = Object.keys(bilanciFromDetails).length > 0 ? bilanciFromDetails : bilanciFromCache;
      if (Object.keys(bilanciToUse).length === 0 && financialData?.bilancioData) {
        const b = financialData.bilancioData;
        const year = b.esercizio ?? b.anno ?? b.year ?? (typeof b.data_chiusura === "string" ? b.data_chiusura.slice(0, 4) : null) ?? new Date().getFullYear().toString();
        const fatturato = b.ricavi_vendite ?? b.ricavi ?? b.fatturato ?? b.turnover ?? b.valore_produzione ?? b.revenue ?? (b.conto_economico?.ricavi ?? b.conto_economico?.ricavi_vendite) ?? 0;
        const patrimonioNetto = b.patrimonio_netto ?? b.netWorth ?? b.totale_passivo ?? 0;
        const costoPersonale = b.costo_personale ?? b.totalStaffCost ?? b.costi_per_il_personale ?? 0;
        const totaleAttivo = b.totale_attivo ?? b.totalAssets ?? 0;
        const dipendenti = b.dipendenti ?? b.employees ?? 0;
        bilanciToUse = {
          [String(year)]: {
            data_chiusura_bilancio: b.data_chiusura ?? b.balanceSheetDate ?? "",
            fatturato: Number(fatturato) || 0,
            patrimonio_netto: Number(patrimonioNetto) || 0,
            costo_personale: Number(costoPersonale) || 0,
            totale_attivo: Number(totaleAttivo) || 0,
            dipendenti: Number(dipendenti) || 0,
          },
        };
      }
      const companyDetailsWithBilanci = companyDetails
        ? { ...companyDetails, dettaglio: { ...companyDetails.dettaglio, bilanci: bilanciToUse } }
        : { dettaglio: { bilanci: bilanciToUse } };
      const financialDataWithBilanci = financialData ? { ...financialData, bilanci: bilanciToUse } : { bilanci: bilanciToUse };

      const resultData = {
        company: selectedCompany,
        companyDetails: companyDetailsWithBilanci,
        financialData: financialDataWithBilanci,
        analysis: analyzeData.analysis,
        competitors,
        mode,
      };

      (window as any).__bilancioResults = resultData;
      setLocation("/results");

    } catch (error: any) {
      console.error("Analysis error:", error);
      toast({
        title: "Errore nell'analisi",
        description: error.message || "Si è verificato un errore. Riprova.",
        variant: "destructive",
      });
    } finally {
      setIsAnalyzing(false);
      setAnalysisStep("");
    }
  };

  const analysisProgressState = getAnalysisProgressState(analysisStep, mode, stepElapsedSeconds);
  const analysisProgress = analysisProgressState.progress;
  const currentStageIndex = getAnalysisStageIndex(analysisStep, mode);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/60 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-6 h-16 flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => setLocation("/")} data-testid="button-back">
            <ArrowLeft className="w-4 h-4 mr-1.5" />
            Indietro
          </Button>
          <div className="h-5 w-px bg-border" />
          <div className="flex items-center gap-2">
            {mode === "business" ? (
              <Building2 className="w-4 h-4 text-primary" />
            ) : (
              <Users className="w-4 h-4 text-accent" />
            )}
            <span className="font-medium text-sm">
              {mode === "business" ? "Analizza la mia azienda" : "Analisi competitiva"}
            </span>
          </div>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-6 py-10">
        {/* Step 1: Company Search */}
        <div className="mb-8 fade-in">
          <h2 className="text-xl font-semibold mb-2">
            Cerca la tua azienda
          </h2>
          <p className="text-sm text-muted-foreground mb-5">
            Scrivi nome e localita' nella stessa ricerca, ad esempio `GEL SPA Castelfidardo`.
          </p>

          <div ref={searchRef} className="relative">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Nome azienda o nome + citta' (es. GEL SPA Castelfidardo)"
                value={query}
                onChange={(e) => handleQueryChange(e.target.value)}
                className="pl-10 pr-12 h-12 text-base"
                data-testid="input-company-search"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                {mainSearch.isSearching && (
                  <div className="flex items-center justify-center w-5 h-5">
                    <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
                  </div>
                )}
              </div>
            </div>

            {/* Dropdown */}
            {mainSearch.showDropdown && (mainSearch.isSearching || mainSearch.results.length > 0) && (
              <div className="absolute z-50 w-full mt-1 bg-popover border border-popover-border rounded-lg shadow-lg max-h-80 overflow-y-auto">
                {mainSearch.results.map((company) => (
                  <button
                    key={company.id}
                    onClick={() => selectCompany(company)}
                    className="w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors border-b border-border/30 last:border-0"
                    data-testid={`company-result-${company.id}`}
                  >
                    <div className="font-medium text-sm">{company.denominazione}</div>
                    {(company.indirizzo || company.comune) && (
                      <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                        <MapPin className="w-3 h-3" />
                        {[company.indirizzo, company.cap, company.comune, company.provincia].filter(Boolean).join(", ")}
                      </div>
                    )}
                    {company.piva && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        P.IVA: {company.piva}
                      </div>
                    )}
                  </button>
                ))}
                {mainSearch.isSearching && (
                  <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
                    <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                    {mainSearch.results.length === 0 ? "Ricerca in corso..." : "Caricamento altri risultati..."}
                  </div>
                )}
                {!mainSearch.isSearching && mainSearch.results.length === 0 && (
                  <div className="px-4 py-3 text-xs text-muted-foreground">
                    Nessun risultato trovato. Prova con ragione sociale completa o nome + citta'.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Selected company card */}
          {selectedCompany && (
            <Card className="mt-4 p-4 border-primary/30 bg-primary/5 fade-in">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-semibold text-sm">{selectedCompany.denominazione}</div>
                  {selectedCompany.indirizzo && (
                    <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                      <MapPin className="w-3 h-3" />
                      {[selectedCompany.indirizzo, selectedCompany.cap, selectedCompany.comune, selectedCompany.provincia].filter(Boolean).join(", ")}
                    </div>
                  )}
                  {selectedCompany.piva && (
                    <div className="text-xs text-muted-foreground mt-1">P.IVA: {selectedCompany.piva}</div>
                  )}
                  {selectedCompany.stato_attivita && (
                    <Badge variant="outline" className="mt-2 text-xs">
                      {selectedCompany.stato_attivita}
                    </Badge>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setSelectedCompany(null); setQuery(""); }}
                  data-testid="button-clear-company"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </Card>
          )}
        </div>

        {/* Step 2: Competitor options (only in competitor mode) */}
        {mode === "competitor" && selectedCompany && (
          <div className="mb-8 fade-in">
            <h2 className="text-xl font-semibold mb-2">Come vuoi identificare i competitor?</h2>
            <p className="text-sm text-muted-foreground mb-5">
              Scegli se vuoi fornirli manualmente o lasciar fare all'AI.
            </p>

            <RadioGroup value={competitorMode} onValueChange={(v) => setCompetitorMode(v as "provide" | "ai")} className="space-y-3">
              <div className="flex items-start gap-3 p-4 rounded-lg border border-border hover:border-primary/30 transition-colors cursor-pointer" onClick={() => setCompetitorMode("ai")}>
                <RadioGroupItem value="ai" id="ai" className="mt-0.5" />
                <Label htmlFor="ai" className="cursor-pointer flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">L'AI identifica i competitor</span>
                    <Sparkles className="w-3.5 h-3.5 text-accent" />
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    L'intelligenza artificiale analizzerà il settore e identificherà i principali competitor.
                  </p>
                </Label>
              </div>

              <div className="flex items-start gap-3 p-4 rounded-lg border border-border hover:border-primary/30 transition-colors cursor-pointer" onClick={() => setCompetitorMode("provide")}>
                <RadioGroupItem value="provide" id="provide" className="mt-0.5" />
                <Label htmlFor="provide" className="cursor-pointer flex-1">
                  <div className="font-medium text-sm">Fornisco io i competitor</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Cerca e aggiungi manualmente le aziende competitor.
                  </p>
                </Label>
              </div>
            </RadioGroup>

            {/* Manual competitor search */}
            {competitorMode === "provide" && (
              <div className="mt-5 fade-in">
                <div ref={competitorSearchRef} className="relative">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      type="text"
                      placeholder="Cerca un competitor..."
                      value={competitorSearchQuery}
                      onChange={(e) => handleCompetitorQueryChange(e.target.value)}
                      className="pl-10 pr-10"
                      data-testid="input-competitor-search"
                    />
                    {compSearch.isSearching && (
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5">
                        <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
                      </div>
                    )}
                  </div>

                  {compSearch.showDropdown && (compSearch.isSearching || compSearch.results.length > 0) && (
                    <div className="absolute z-50 w-full mt-1 bg-popover border border-popover-border rounded-lg shadow-lg max-h-60 overflow-y-auto">
                      {compSearch.results.map((company) => (
                        <button
                          key={company.id}
                          onClick={() => addCompetitor(company)}
                          className="w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors border-b border-border/30 last:border-0"
                        >
                          <div className="flex items-center gap-2">
                            <Plus className="w-3.5 h-3.5 text-accent" />
                            <div>
                              <div className="font-medium text-sm">{company.denominazione}</div>
                              {company.comune && (
                                <div className="text-xs text-muted-foreground">{company.comune}, {company.provincia}</div>
                              )}
                            </div>
                          </div>
                        </button>
                      ))}
                      {compSearch.isSearching && (
                        <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
                          <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                          {compSearch.results.length === 0 ? "Ricerca in corso..." : "Caricamento..."}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Selected competitors */}
                {selectedCompetitors.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {selectedCompetitors.map((comp) => (
                      <div key={comp.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-muted/50 border border-border/50">
                        <div>
                          <div className="text-sm font-medium">{comp.denominazione}</div>
                          {comp.comune && (
                            <div className="text-xs text-muted-foreground">{comp.comune}, {comp.provincia}</div>
                          )}
                        </div>
                        <Button variant="ghost" size="sm" onClick={() => removeCompetitor(comp.id)}>
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Start Analysis Button */}
        {selectedCompany && (
          <div className="fade-in">
            <Button
              onClick={startAnalysis}
              disabled={isAnalyzing || (mode === "competitor" && competitorMode === "provide" && selectedCompetitors.length === 0)}
              className="w-full h-12 text-base font-medium"
              data-testid="button-start-analysis"
            >
              {isAnalyzing ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {analysisStep}
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mr-2" />
                  Avvia analisi
                </>
              )}
            </Button>

            {isAnalyzing && (
              <Card className="analysis-wait-card relative mt-4 overflow-hidden border-primary/15 bg-[linear-gradient(160deg,rgba(255,255,255,0.96),rgba(239,244,255,0.9)_58%,rgba(228,242,242,0.92))] p-0 shadow-lg">
                <div className="pointer-events-none absolute inset-0">
                  <div className="analysis-wait-orb absolute -left-12 top-10 h-28 w-28 rounded-full bg-primary/10 blur-2xl" />
                  <div className="analysis-wait-orb analysis-wait-orb-delay absolute right-0 top-0 h-36 w-36 rounded-full bg-accent/10 blur-3xl" />
                  <div className="analysis-wait-grid absolute inset-0 opacity-40" />
                </div>

                <div className="relative p-5 sm:p-6">
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                    <div className="max-w-lg">
                      <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-white/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-primary shadow-sm">
                        <span className="analysis-live-dot h-2 w-2 rounded-full bg-primary" />
                        Analysis engine
                      </div>
                      <h3 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
                        Stiamo assemblando il memo aziendale
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        {ANALYSIS_WAIT_MESSAGES[waitMessageIndex]}
                      </p>
                    </div>

                    <div className="analysis-radar-shell mx-auto w-full max-w-[280px] lg:mx-0">
                      <div className="analysis-radar-ring analysis-radar-ring-outer" />
                      <div className="analysis-radar-ring analysis-radar-ring-middle" />
                      <div className="analysis-radar-ring analysis-radar-ring-inner" />
                      <div className="analysis-radar-scan" />
                      <div className="analysis-radar-core shadow-sm">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-primary/80">
                          Live step
                        </div>
                        <div className="mt-2 text-sm font-semibold text-foreground">
                          {analysisStep}
                        </div>
                      </div>
                      <div className="analysis-radar-pulse analysis-radar-pulse-a" />
                      <div className="analysis-radar-pulse analysis-radar-pulse-b" />
                      <div className="analysis-radar-pulse analysis-radar-pulse-c" />
                    </div>
                  </div>

                  <div className="mt-5">
                    <div className="mb-2 flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                      <span>{analysisProgress}%</span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-slate-200/70">
                      <div
                        className="analysis-progress-bar h-full rounded-full"
                        style={{ width: `${analysisProgress}%` }}
                      />
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>{formatRemainingMinutes(analysisProgressState.remainingSeconds)}</span>
                      {analysisProgressState.isOvertime && (
                        <span>Non e' bloccato, sta ancora elaborando</span>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            )}
          </div>
        )}
      </div>

      <footer className="border-t border-border/50 py-6 px-6 mt-auto text-center">
        <PoweredByAttribution />
      </footer>
    </div>
  );
}
