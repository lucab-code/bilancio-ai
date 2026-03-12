import { Link } from "wouter";
import { Building2, Users, TrendingUp, BarChart3, Shield, Zap, LogOut, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PerplexityAttribution } from "@/components/PerplexityAttribution";
import { useAuth } from "@/App";

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
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/60 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BilancioLogo className="w-8 h-8 text-primary" />
            <span className="text-lg font-semibold tracking-tight">BilancioAI</span>
          </div>
          <div className="flex items-center gap-3">
            {user && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <User className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{user.name || user.email}</span>
              </div>
            )}
            <Button variant="ghost" size="sm" onClick={logout} data-testid="button-logout">
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="py-20 px-6">
        <div className="max-w-4xl mx-auto text-center slide-up">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-accent/10 text-accent text-sm font-medium mb-6">
            <Zap className="w-3.5 h-3.5" />
            Powered by AI e Camera di Commercio
          </div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-4 leading-tight">
            Analizza i bilanci aziendali
            <br />
            <span className="text-primary">come un analista bancario</span>
          </h1>
          <p className="text-muted-foreground text-base md:text-lg max-w-2xl mx-auto mb-12">
            Scarica automaticamente i bilanci dalla Camera di Commercio, riclassificali 
            secondo gli standard bancari e ottieni analisi AI con raccomandazioni strategiche.
          </p>

          {/* Two Mode Cards */}
          <div className="grid md:grid-cols-2 gap-5 max-w-3xl mx-auto">
            <Link href="/analysis/business">
              <div
                className="group relative bg-card border border-border rounded-xl p-8 text-left cursor-pointer transition-all duration-200 hover:border-primary/40 hover:shadow-lg"
                data-testid="card-business-mode"
              >
                <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center mb-5 group-hover:bg-primary/15 transition-colors">
                  <Building2 className="w-6 h-6 text-primary" />
                </div>
                <h2 className="text-lg font-semibold mb-2">Analizza la mia azienda</h2>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Cerca la tua azienda, scarica il bilancio e ottieni un'analisi 
                  finanziaria completa con indici, benchmark e raccomandazioni.
                </p>
                <div className="mt-5 text-sm font-medium text-primary flex items-center gap-1.5 group-hover:gap-2.5 transition-all">
                  Inizia l'analisi
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                </div>
              </div>
            </Link>

            <Link href="/analysis/competitor">
              <div
                className="group relative bg-card border border-border rounded-xl p-8 text-left cursor-pointer transition-all duration-200 hover:border-accent/40 hover:shadow-lg"
                data-testid="card-competitor-mode"
              >
                <div className="w-12 h-12 rounded-lg bg-accent/10 flex items-center justify-center mb-5 group-hover:bg-accent/15 transition-colors">
                  <Users className="w-6 h-6 text-accent" />
                </div>
                <h2 className="text-lg font-semibold mb-2">Analizza i competitor</h2>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Inserisci la tua azienda e confrontala con i competitor. Puoi fornirli 
                  tu oppure lasciare che l'AI li identifichi automaticamente.
                </p>
                <div className="mt-5 text-sm font-medium text-accent flex items-center gap-1.5 group-hover:gap-2.5 transition-all">
                  Analisi competitiva
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                </div>
              </div>
            </Link>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-16 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto">
          <h3 className="text-center text-sm font-medium text-muted-foreground uppercase tracking-wider mb-10">
            Come funziona
          </h3>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                icon: <BarChart3 className="w-5 h-5" />,
                title: "Bilancio automatico",
                desc: "Scarica il bilancio ufficiale dalla Camera di Commercio tramite API in meno di 1 minuto.",
              },
              {
                icon: <TrendingUp className="w-5 h-5" />,
                title: "Riclassificazione bancaria",
                desc: "Analisi secondo gli standard bancari: Stato Patrimoniale, Conto Economico, Cash Flow.",
              },
              {
                icon: <Shield className="w-5 h-5" />,
                title: "Analisi AI e raccomandazioni",
                desc: "GPT-4 analizza, confronta con il mercato e fornisce raccomandazioni strategiche.",
              },
            ].map((f, i) => (
              <div key={i} className="text-center fade-in" style={{ animationDelay: `${i * 100}ms` }}>
                <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center mx-auto mb-4 text-foreground">
                  {f.icon}
                </div>
                <h4 className="font-medium mb-2">{f.title}</h4>
                <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border/50 py-8 px-6">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <BilancioLogo className="w-5 h-5" />
            BilancioAI — Analisi finanziaria intelligente
          </div>
          <PerplexityAttribution />
        </div>
      </footer>
    </div>
  );
}
