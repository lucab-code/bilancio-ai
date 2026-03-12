import { useState, useCallback, useRef, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { Search, Building2, Users, MapPin, ArrowLeft, Loader2, Plus, X, Sparkles, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { PerplexityAttribution } from "@/components/PerplexityAttribution";
import { useAuth } from "@/App";

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

// Shared search hook to avoid code duplication
function useCompanySearch() {
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
        { signal: controller.signal }
      );
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
  }, []);

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
  const [cityFilter, setCityFilter] = useState("");
  const [showCityFilter, setShowCityFilter] = useState(false);
  const [selectedCompany, setSelectedCompany] = useState<CompanyResult | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);

  const mainSearch = useCompanySearch();

  // Competitor mode state
  const [competitorMode, setCompetitorMode] = useState<"provide" | "ai">("ai");
  const [competitorSearchQuery, setCompetitorSearchQuery] = useState("");
  const [selectedCompetitors, setSelectedCompetitors] = useState<CompanyResult[]>([]);
  const competitorSearchRef = useRef<HTMLDivElement>(null);
  const compSearch = useCompanySearch();

  // Analysis state
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisStep, setAnalysisStep] = useState("");

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

  // Filter results by city client-side
  const filteredResults = cityFilter.trim()
    ? mainSearch.results.filter(r => {
        const cityLower = cityFilter.toLowerCase().trim();
        return (
          (r.comune || "").toLowerCase().includes(cityLower) ||
          (r.provincia || "").toLowerCase().includes(cityLower) ||
          (r.cap || "").startsWith(cityLower)
        );
      })
    : mainSearch.results;

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

  // Start analysis
  const startAnalysis = async () => {
    if (!selectedCompany) {
      toast({ title: "Seleziona un'azienda", description: "Cerca e seleziona un'azienda dalla lista.", variant: "destructive" });
      return;
    }

    setIsAnalyzing(true);

    try {
      // Step 1: Get company details
      setAnalysisStep("Recupero dettagli azienda...");
      let companyDetails = null;
      try {
        const detailRes = await authFetch(`${API_BASE}/api/company/${selectedCompany.id}/details`);
        if (detailRes.ok) {
          const detailData = await detailRes.json();
          companyDetails = detailData.data;
        }
      } catch (e) {
        console.log("Could not fetch details, continuing...");
      }

      // Step 2: Request bilancio
      setAnalysisStep("Richiesta bilancio alla Camera di Commercio...");
      let financialData = null;
      const taxCode = selectedCompany.cf || selectedCompany.piva;
      
      if (taxCode) {
        try {
          const bilancioRes = await authFetch(`${API_BASE}/api/bilancio/request`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taxCode }),
          });
          const bilancioData = await bilancioRes.json();

          if (bilancioData.data?.cached) {
            setAnalysisStep("Bilancio trovato in cache.");
            financialData = { bilanci: bilancioData.data.bilanci };
          } else if (bilancioData.data?.results && bilancioData.data.results.length > 0) {
            setAnalysisStep("Bilancio trovato. Elaborazione in corso...");
            
            const sortedResults = bilancioData.data.results
              .sort((a: any, b: any) => b.data.balanceSheetDate.localeCompare(a.data.balanceSheetDate));
            
            financialData = {
              availableYears: sortedResults.map((r: any) => ({
                id: r.id,
                date: r.data.balanceSheetDate,
                type: r.data.balanceSheetTypeDescription,
              })),
              requestId: bilancioData.data.id,
            };

            if (bilancioData.data.state === "SEARCH" || bilancioData.data.state === "NEW") {
              const latestResult = sortedResults[0];
              try {
                setAnalysisStep(`Scarico bilancio ${latestResult.data.balanceSheetDate}...`);
                await authFetch(`${API_BASE}/api/bilancio/${bilancioData.data.id}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ resultId: latestResult.id }),
                });
                
                let attempts = 0;
                while (attempts < 30) {
                  await new Promise(r => setTimeout(r, 3000));
                  const statusRes = await authFetch(`${API_BASE}/api/bilancio/${bilancioData.data.id}/status`);
                  const statusData = await statusRes.json();
                  
                  if (statusData.data?.state === "DONE" || statusData.data?.state === "evaso") {
                    setAnalysisStep("Bilancio pronto. Download dati...");
                    const docRes = await authFetch(`${API_BASE}/api/bilancio/${bilancioData.data.id}/documents`);
                    const docData = await docRes.json();
                    
                    if (docData.data && docData.data.length > 0) {
                      try {
                        const jsonUrl = docData.data[0].downloadUrl;
                        const jsonRes = await fetch(jsonUrl);
                        const jsonData = await jsonRes.json();
                        financialData = { ...financialData, bilancioData: jsonData };
                      } catch {
                        console.log("Could not download bilancio JSON");
                      }
                    }
                    break;
                  }
                  
                  if (statusData.data?.state === "ERROR") {
                    console.error("Bilancio request failed");
                    break;
                  }
                  
                  setAnalysisStep(`Elaborazione bilancio in corso... (${attempts * 3}s)`);
                  attempts++;
                }
              } catch (e) {
                console.log("Could not process bilancio, continuing with available data...");
              }
            }
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

      // Step 4: AI Analysis
      setAnalysisStep("Analisi AI in corso...");
      const analyzeRes = await authFetch(`${API_BASE}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: selectedCompany.denominazione,
          companyDetails: {
            ...companyDetails,
            bilanci: companyDetails?.dettaglio?.bilanci,
          },
          financialData,
          mode,
          competitors,
        }),
      });
      const analyzeData = await analyzeRes.json();

      // Store results and navigate
      const resultData = {
        company: selectedCompany,
        companyDetails,
        financialData,
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
            Digita il nome dell'azienda. Puoi filtrare per città per trovare più facilmente.
          </p>

          <div ref={searchRef} className="relative">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Nome azienda (es. Moncler SPA, GEL SPA...)"
                value={query}
                onChange={(e) => handleQueryChange(e.target.value)}
                className="pl-10 pr-20 h-12 text-base"
                data-testid="input-company-search"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                {mainSearch.isSearching && (
                  <div className="flex items-center justify-center w-5 h-5">
                    <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
                  </div>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setShowCityFilter(!showCityFilter)}
                  data-testid="button-toggle-city-filter"
                  title="Filtra per città"
                >
                  <Filter className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>

            {/* City filter row */}
            {showCityFilter && (
              <div className="mt-2 fade-in">
                <div className="relative">
                  <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    type="text"
                    placeholder="Filtra per città, provincia o CAP..."
                    value={cityFilter}
                    onChange={(e) => setCityFilter(e.target.value)}
                    className="pl-10 h-10 text-sm"
                    data-testid="input-city-filter"
                  />
                  {cityFilter && (
                    <button
                      className="absolute right-3 top-1/2 -translate-y-1/2"
                      onClick={() => setCityFilter("")}
                    >
                      <X className="w-3.5 h-3.5 text-muted-foreground" />
                    </button>
                  )}
                </div>
                {cityFilter && (
                  <p className="text-[11px] text-muted-foreground mt-1 ml-1">
                    {filteredResults.length} risultat{filteredResults.length === 1 ? "o" : "i"} in "{cityFilter}"
                  </p>
                )}
              </div>
            )}

            {/* Dropdown */}
            {mainSearch.showDropdown && (mainSearch.isSearching || mainSearch.results.length > 0) && (
              <div className="absolute z-50 w-full mt-1 bg-popover border border-popover-border rounded-lg shadow-lg max-h-80 overflow-y-auto">
                {filteredResults.map((company) => (
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
                {!mainSearch.isSearching && filteredResults.length === 0 && mainSearch.results.length > 0 && cityFilter && (
                  <div className="px-4 py-3 text-xs text-muted-foreground">
                    Nessun risultato per "{cityFilter}". Prova a rimuovere il filtro città.
                  </div>
                )}
                {!mainSearch.isSearching && mainSearch.results.length === 0 && (
                  <div className="px-4 py-3 text-xs text-muted-foreground">
                    Nessun risultato trovato. Prova un nome diverso.
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
              <div className="mt-4">
                <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                  <div className="h-full bg-primary rounded-full pulse-glow" style={{ width: "60%", transition: "width 1s" }} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <footer className="border-t border-border/50 py-6 px-6 mt-auto">
        <div className="max-w-4xl mx-auto flex justify-center">
          <PerplexityAttribution />
        </div>
      </footer>
    </div>
  );
}
