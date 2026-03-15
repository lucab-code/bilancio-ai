import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Building2, Users, TrendingUp, BarChart3, Eye, Shield, Zap, LogOut, User, History, Clock3, ArrowRight, CreditCard, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/App";
import { PoweredByAttribution } from "@/components/PoweredByAttribution";
import { AppTopBar } from "@/components/AppTopBar";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

type SavedAnalysis = {
  id: number;
  mode: "business" | "competitor";
  companyName: string;
  companyId?: string | null;
  taxCode?: string | null;
  address?: string | null;
  status?: string | null;
  companyDetails?: any;
  financialData?: any;
  aiAnalysis?: any;
  competitors?: any;
  createdAt?: string | null;
};

type WalletState = {
  balanceCents: number;
  currency: string;
  businessAnalysisCents: number;
  billingEnabled: boolean;
};

function formatCents(value: number): string {
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
  }).format((value || 0) / 100);
}

function formatAnalysisDate(value?: string | null): string {
  if (!value) return "Data non disponibile";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("it-IT", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function buildResultDataFromAnalysis(analysis: SavedAnalysis) {
  const companyDetails = analysis.companyDetails || {};
  const company = {
    id: analysis.companyId || companyDetails?.id || String(analysis.id),
    denominazione: companyDetails?.denominazione || analysis.companyName,
    indirizzo: companyDetails?.indirizzo || analysis.address || "",
    comune: companyDetails?.comune || "",
    provincia: companyDetails?.provincia || "",
    cap: companyDetails?.cap || "",
    piva: companyDetails?.partita_iva || null,
    cf: companyDetails?.codice_fiscale || analysis.taxCode || null,
    stato_attivita: companyDetails?.stato_attivita || "",
  };

  return {
    company,
    companyDetails,
    financialData: analysis.financialData || {},
    insights: analysis.financialData?.insights || analysis.aiAnalysis?.insights || null,
    documentSource: analysis.financialData?.documentSource || null,
    analysis: analysis.aiAnalysis || null,
    competitors: analysis.competitors || null,
    mode: analysis.mode,
  };
}

function BilancioLogo({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" fill="none" className={className} aria-label="BilancioAI Logo">
      <rect x="2" y="8" width="14" height="24" rx="2" stroke="currentColor" strokeWidth="2.5" />
      <rect x="24" y="4" width="14" height="28" rx="2" stroke="currentColor" strokeWidth="2.5" />
      <path d="M6 20h6M6 24h6M6 28h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M28 16h6M28 20h6M28 24h6M28 28h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M16 20h8" stroke="hsl(var(--accent))" strokeWidth="2" strokeLinecap="round" strokeDasharray="2 3" />
      <circle cx="20" cy="6" r="4" fill="hsl(var(--accent))" opacity="0.2" />
      <circle cx="20" cy="6" r="2" fill="hsl(var(--accent))" />
    </svg>
  );
}

export default function HomePage() {
  const { user, token, logout } = useAuth();
  const [, setLocation] = useLocation();
  const [savedAnalyses, setSavedAnalyses] = useState<SavedAnalysis[]>([]);
  const [isLoadingAnalyses, setIsLoadingAnalyses] = useState(true);
  const [deletingAnalysisId, setDeletingAnalysisId] = useState<number | null>(null);
  const [walletState, setWalletState] = useState<WalletState | null>(null);
  const [isLoadingWallet, setIsLoadingWallet] = useState(false);

  useEffect(() => {
    let isMounted = true;

    async function loadAnalyses() {
      if (!token) {
        if (isMounted) {
          setSavedAnalyses([]);
          setIsLoadingAnalyses(false);
        }
        return;
      }

      setIsLoadingAnalyses(true);
      try {
        const res = await fetch(`${API_BASE}/api/analyses`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        const payload = await res.json().catch(() => ({}));
        if (!isMounted) return;
        if (res.ok && Array.isArray(payload?.data)) {
          setSavedAnalyses(payload.data);
        } else {
          setSavedAnalyses([]);
        }
      } catch (error) {
        console.error("Could not load analyses history", error);
        if (isMounted) setSavedAnalyses([]);
      } finally {
        if (isMounted) setIsLoadingAnalyses(false);
      }
    }

    loadAnalyses();
    return () => {
      isMounted = false;
    };
  }, [token]);

  useEffect(() => {
    let isMounted = true;

    async function loadWallet() {
      if (!token) {
        if (isMounted) {
          setWalletState(null);
          setIsLoadingWallet(false);
        }
        return;
      }

      setIsLoadingWallet(true);
      try {
        const res = await fetch(`${API_BASE}/api/billing/me`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        const payload = await res.json().catch(() => ({}));
        if (!isMounted) return;
        if (res.ok && payload?.data) {
          setWalletState(payload.data);
        } else {
          setWalletState(null);
        }
      } catch (error) {
        console.error("Could not load wallet", error);
        if (isMounted) setWalletState(null);
      } finally {
        if (isMounted) setIsLoadingWallet(false);
      }
    }

    loadWallet();
    return () => {
      isMounted = false;
    };
  }, [token]);

  const redirectToCheckout = async () => {
    if (!token) return;

    const res = await fetch(`${API_BASE}/api/billing/checkout`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ topUpCents: walletState?.businessAnalysisCents }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload?.data?.url) {
      console.error("Could not start checkout", payload);
      return;
    }

    window.location.href = payload.data.url;
  };

  const recentCompanies = useMemo(() => {
    const deduped = new Map<string, SavedAnalysis>();

    for (const analysis of savedAnalyses) {
      const key = analysis.companyId || analysis.taxCode || analysis.companyName;
      if (!deduped.has(key)) {
        deduped.set(key, analysis);
      }
    }

    return Array.from(deduped.values()).slice(0, 6);
  }, [savedAnalyses]);

  const openSavedAnalysis = (analysis: SavedAnalysis) => {
    (window as any).__bilancioResults = buildResultDataFromAnalysis(analysis);
    setLocation("/results");
  };

  const deleteSavedAnalysis = async (analysis: SavedAnalysis) => {
    if (!token || deletingAnalysisId === analysis.id) return;

    const companyKey =
      analysis.companyId ||
      analysis.taxCode ||
      analysis.companyName;
    const relatedAnalyses = savedAnalyses.filter((item) => {
      const itemKey = item.companyId || item.taxCode || item.companyName;
      return itemKey === companyKey;
    });
    const idsToDelete = relatedAnalyses.map((item) => item.id);

    const confirmed = window.confirm(
      `Vuoi eliminare ${idsToDelete.length > 1 ? "tutte le analisi" : "l'analisi"} di "${analysis.companyDetails?.denominazione || analysis.companyName}"?`,
    );
    if (!confirmed) return;

    setDeletingAnalysisId(analysis.id);
    try {
      for (const id of idsToDelete) {
        const res = await fetch(`${API_BASE}/api/analyses/${id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          console.error("Could not delete analysis", payload);
          window.alert("Impossibile eliminare l'analisi.");
          return;
        }
      }

      setSavedAnalyses((current) => current.filter((item) => !idsToDelete.includes(item.id)));
    } catch (error) {
      console.error("Could not delete analysis", error);
      window.alert("Impossibile eliminare l'analisi.");
    } finally {
      setDeletingAnalysisId(null);
    }
  };

  return (
    <div className="stripe-page min-h-screen bg-background">
      <AppTopBar
        left={(
          <div className="stripe-topbar-brand">
            <div className="stripe-topbar-logo">
              <BilancioLogo className="h-6 w-6 text-primary" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-[1.08rem] font-semibold tracking-[-0.05em] text-slate-950">
                BilancioAI
              </div>
              <div className="hidden text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400 sm:block">
                Financial intelligence
              </div>
            </div>
          </div>
        )}
        right={(
          <>
            {token && (
              <div className="stripe-topbar-chip hidden sm:inline-flex">
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <CreditCard className="h-4 w-4 text-primary" />
                  <span className="font-medium text-slate-500">Credito</span>
                  <span className="font-semibold text-slate-950">
                    {isLoadingWallet ? "..." : formatCents(walletState?.balanceCents || 0)}
                  </span>
                </div>
                {walletState?.billingEnabled && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-full border-white/90 bg-white px-3 shadow-none"
                    onClick={redirectToCheckout}
                  >
                    Ricarica
                  </Button>
                )}
              </div>
            )}
            {user && (
              <div className="stripe-topbar-chip stripe-topbar-chip-muted max-w-[220px]">
                <User className="h-4 w-4 shrink-0 text-slate-500" />
                <span className="truncate text-sm font-medium">{user.name || user.email}</span>
              </div>
            )}
            {user && (
              <Button
                variant="ghost"
                size="sm"
                onClick={logout}
                data-testid="button-logout"
                className="h-11 w-11 rounded-2xl border border-white/80 bg-white/82 p-0 text-slate-600 shadow-[0_18px_34px_-30px_rgba(15,23,42,0.24)] hover:bg-white hover:text-slate-950"
              >
                <LogOut className="h-4 w-4" />
              </Button>
            )}
          </>
        )}
      />

      {/* Hero */}
      <section className="stripe-shell px-6 pb-20 pt-10">
        <div className="stripe-panel stripe-subtle-grid mx-auto max-w-6xl px-6 py-10 sm:px-10 sm:py-14">
          <div className="mx-auto max-w-5xl slide-up text-center lg:text-left">
          <div className="stripe-kicker mb-6">
            <Zap className="w-3.5 h-3.5" />
            Powered by AI e Camera di Commercio
          </div>
          <h1 className="stripe-display mb-5">
            Analizza i bilanci aziendali
            <br />
            <span className="bg-[linear-gradient(120deg,#635bff_0%,#0a84ff_55%,#ff7a00_100%)] bg-clip-text text-transparent">
              con benchmark e raccomandazioni
            </span>
          </h1>
          <p className="stripe-lead mb-12 max-w-3xl lg:mx-0">
            BilancioAI unisce bilanci ufficiali, confronto con il mercato, lettura di circolante e debito
            e ti lascia usare anche i bilanci che hai gia', se vuoi partire dai tuoi documenti.
          </p>

          <div className="mx-auto grid max-w-5xl gap-5 md:grid-cols-2">
            <Link href="/analysis/business">
              <div
                className="stripe-card-hover stripe-hero-card group flex min-h-[320px] h-full flex-col rounded-[32px] p-8 text-left"
                data-testid="card-business-mode"
              >
                <div className="mb-6 inline-flex w-fit items-center gap-2 rounded-full border border-primary/15 bg-primary/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-primary">
                  Checkup
                </div>
                <div className="w-12 h-12 rounded-2xl bg-[linear-gradient(135deg,rgba(99,91,255,0.16),rgba(10,132,255,0.12))] flex items-center justify-center mb-5 transition-colors">
                  <Building2 className="w-6 h-6 text-primary" />
                </div>
                <h2 className="mb-3 text-[28px] font-semibold tracking-[-0.04em] text-slate-950">Analizza la mia azienda</h2>
                <p className="text-sm leading-7 text-slate-600">
                  Cerca la tua azienda, scarica il bilancio e ottieni un'analisi 
                  finanziaria completa con indici, benchmark e raccomandazioni.
                </p>
                <div className="mt-auto pt-6 text-sm font-semibold text-primary flex items-center gap-2 transition-all">
                  Inizia l'analisi
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                </div>
              </div>
            </Link>

            <Link href="/analysis/competitor">
              <div
                className="stripe-card-hover stripe-hero-card group flex min-h-[320px] h-full flex-col rounded-[32px] p-8 text-left"
                data-testid="card-competitor-mode"
              >
                <div className="mb-6 inline-flex w-fit items-center gap-2 rounded-full border border-accent/15 bg-accent/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
                  Market map
                </div>
                <div className="w-12 h-12 rounded-2xl bg-[linear-gradient(135deg,rgba(10,132,255,0.16),rgba(99,91,255,0.12))] flex items-center justify-center mb-5 transition-colors">
                  <Users className="w-6 h-6 text-accent" />
                </div>
                <h2 className="mb-3 text-[28px] font-semibold tracking-[-0.04em] text-slate-950">Analizza i competitor</h2>
                <p className="text-sm leading-7 text-slate-600">
                  Inserisci la tua azienda e confrontala con i competitor. Puoi fornirli 
                  tu oppure lasciare che l'AI li identifichi automaticamente.
                </p>
                <div className="mt-auto pt-6 text-sm font-semibold text-accent flex items-center gap-2 transition-all">
                  Analisi competitiva
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                </div>
              </div>
            </Link>

            <Link href="/analysis/business?intent=target">
              <div
                className="stripe-card-hover stripe-hero-card group flex min-h-[320px] h-full flex-col rounded-[32px] p-8 text-left"
                data-testid="card-target-mode"
              >
                <div className="mb-6 inline-flex w-fit items-center gap-2 rounded-full border border-emerald-500/15 bg-emerald-500/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-emerald-600">
                  Deal flow
                </div>
                <div className="w-12 h-12 rounded-2xl bg-[linear-gradient(135deg,rgba(16,185,129,0.16),rgba(10,132,255,0.12))] flex items-center justify-center mb-5 transition-colors">
                  <TrendingUp className="w-6 h-6 text-emerald-600" />
                </div>
                <h2 className="mb-3 text-[28px] font-semibold tracking-[-0.04em] text-slate-950">Analizza una target</h2>
                <p className="text-sm leading-7 text-slate-600">
                  Valuta rapidamente una societa' target con storico economico, descrizione del business model
                  e indicatori chiave per una prima lettura da investitore.
                </p>
                <div className="mt-auto pt-6 text-sm font-semibold text-emerald-600 flex items-center gap-2 transition-all">
                  Valuta la target
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                </div>
              </div>
            </Link>

            <Link href="/analysis/business?intent=explore">
              <div
                className="stripe-card-hover stripe-hero-card group flex min-h-[320px] h-full flex-col rounded-[32px] p-8 text-left"
                data-testid="card-explore-mode"
              >
                <div className="mb-6 inline-flex w-fit items-center gap-2 rounded-full border border-violet-500/15 bg-violet-500/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-violet-600">
                  Explore
                </div>
                <div className="w-12 h-12 rounded-2xl bg-[linear-gradient(135deg,rgba(139,92,246,0.16),rgba(99,91,255,0.12))] flex items-center justify-center mb-5 transition-colors">
                  <Eye className="w-6 h-6 text-violet-600" />
                </div>
                <h2 className="mb-3 text-[28px] font-semibold tracking-[-0.04em] text-slate-950">Sto semplicemente curiosando 😏</h2>
                <p className="text-sm leading-7 text-slate-600">
                  Sbircia aziende, bilanci e numeri per pura curiosita' imprenditoriale, senza un caso d'uso troppo serio.
                </p>
                <div className="mt-auto pt-6 text-sm font-semibold text-violet-600 flex items-center gap-2 transition-all">
                  Fammi curiosare
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                </div>
              </div>
            </Link>
          </div>
          </div>
        </div>
      </section>

      <section className="stripe-shell px-6 py-6">
        <div className="stripe-panel stripe-subtle-grid mx-auto max-w-5xl px-6 py-8 sm:px-8">
          <div className="mb-6 flex items-end justify-between gap-3">
            <div>
              <div className="mb-2 stripe-kicker">
                <History className="h-3.5 w-3.5" />
                History
              </div>
              <h3 className="text-2xl font-semibold tracking-tight">Societa' analizzate</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Riapri velocemente le ultime analisi salvate sul tuo account.
              </p>
            </div>
            {recentCompanies.length > 0 && (
              <Badge variant="outline" className="hidden sm:inline-flex">
                {recentCompanies.length} societa'
              </Badge>
            )}
          </div>

          {isLoadingAnalyses ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 3 }).map((_, index) => (
              <Card key={index} className="animate-pulse border-border/60 p-5">
                  <div className="h-4 w-32 rounded bg-muted" />
                  <div className="mt-3 h-3 w-24 rounded bg-muted" />
                  <div className="mt-5 h-9 w-full rounded bg-muted" />
                </Card>
              ))}
            </div>
          ) : recentCompanies.length > 0 ? (
            <div className="space-y-4">
              {recentCompanies.map((analysis) => {
                const coveredYears = Array.isArray(analysis.financialData?.coveredYears)
                  ? analysis.financialData.coveredYears
                  : [];
                const subtitle = [
                  analysis.companyDetails?.comune,
                  analysis.companyDetails?.provincia,
                ].filter(Boolean).join(", ");

                return (
                  <Card
                    key={analysis.id}
                    className="stripe-card-hover group w-full border-border/70 bg-card/88 p-5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-base font-semibold leading-tight text-foreground">
                          {analysis.companyDetails?.denominazione || analysis.companyName}
                        </div>
                        {subtitle && (
                          <div className="mt-1 text-sm text-muted-foreground">{subtitle}</div>
                        )}
                      </div>
                      <Badge variant={analysis.mode === "business" ? "default" : "secondary"} className="shrink-0">
                        {analysis.mode === "business" ? "Business" : "Competitor"}
                      </Badge>
                    </div>

                    <div className="mt-4 space-y-2 text-xs text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <Clock3 className="h-3.5 w-3.5 shrink-0" />
                        <span>Ultima analisi: {formatAnalysisDate(analysis.createdAt)}</span>
                      </div>
                      {coveredYears.length > 0 && (
                        <div className="flex items-center gap-2">
                          <BarChart3 className="h-3.5 w-3.5 shrink-0" />
                          <span>Storico: {coveredYears.join(" - ")}</span>
                        </div>
                      )}
                    </div>

                    <div className="mt-5 flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="flex-1 justify-between border-primary/20 bg-primary/5 text-primary hover:bg-primary/10"
                        onClick={() => openSavedAnalysis(analysis)}
                        data-testid={`button-open-analysis-${analysis.id}`}
                      >
                        Apri analisi
                        <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="shrink-0 border-destructive/20 bg-destructive/5 text-destructive hover:bg-destructive/10"
                        onClick={() => deleteSavedAnalysis(analysis)}
                        disabled={deletingAnalysisId === analysis.id}
                        data-testid={`button-delete-analysis-${analysis.id}`}
                        aria-label={`Elimina analisi ${analysis.companyDetails?.denominazione || analysis.companyName}`}
                      >
                        <Trash2 className="h-4 w-4" />
                        <span>Elimina</span>
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>
          ) : (
            <Card className="border-dashed border-border/70 bg-card/75 p-6">
              <div className="flex flex-col gap-2">
                <div className="text-sm font-medium text-foreground">Nessuna societa' analizzata ancora</div>
                <p className="text-sm text-muted-foreground">
                  Le analisi completate compariranno qui e potrai riaprirle dalla home.
                </p>
              </div>
            </Card>
          )}
        </div>
      </section>

      {/* Features */}
      <section className="stripe-shell px-6 py-16">
        <div className="stripe-panel stripe-subtle-grid mx-auto max-w-5xl px-6 py-10 sm:px-8">
          <h3 className="text-center text-sm font-medium text-muted-foreground uppercase tracking-[0.24em] mb-10">
            Come funziona
          </h3>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                icon: <BarChart3 className="w-5 h-5" />,
                title: "Bilanci ufficiali o tuoi upload",
                desc: "Usa i documenti ufficiali oppure carica i tuoi PDF/XBRL e analizza l'azienda partendo direttamente dai tuoi file.",
              },
              {
                icon: <TrendingUp className="w-5 h-5" />,
                title: "Benchmark e market context",
                desc: "Confronta margini, crescita e cash conversion con range di mercato costruiti via ricerca web e AI.",
              },
              {
                icon: <Shield className="w-5 h-5" />,
                title: "Working capital e raccomandazioni",
                desc: "Leggi in pochi minuti circolante, debito e priorità operative invece di fermarti ai numeri grezzi.",
              },
            ].map((f, i) => (
              <div key={i} className="stripe-card-hover rounded-[28px] border border-white/80 bg-white/82 p-6 text-center fade-in" style={{ animationDelay: `${i * 100}ms` }}>
                <div className="w-12 h-12 rounded-2xl bg-[linear-gradient(135deg,rgba(99,91,255,0.12),rgba(10,132,255,0.1))] flex items-center justify-center mx-auto mb-4 text-foreground">
                  {f.icon}
                </div>
                <h4 className="mb-2 text-lg font-semibold tracking-[-0.03em] text-slate-950">{f.title}</h4>
                <p className="text-sm leading-7 text-slate-600">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="stripe-shell px-6 pb-8 pt-4">
        <div className="mx-auto grid max-w-5xl grid-cols-1 gap-4 border-t border-white/70 pt-6 md:grid-cols-3 items-center">
          <div className="flex items-center gap-2 text-sm text-muted-foreground md:justify-start justify-center order-2 md:order-1">
            <BilancioLogo className="w-5 h-5" />
            BilancioAI — Analisi finanziaria intelligente
          </div>
          <div className="order-1 md:order-2 text-center">
            <PoweredByAttribution />
          </div>
          <div className="hidden md:block md:order-3" aria-hidden="true" />
        </div>
      </footer>
    </div>
  );
}
