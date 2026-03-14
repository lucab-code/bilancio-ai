import { useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, Check, Crown, CreditCard, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/App";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

const PLANS = [
  {
    id: "single",
    name: "Analisi Singola",
    price: "29",
    period: "per analisi",
    description: "Per usare BilancioAI quando ti serve",
    features: [
      "Report completo azienda",
      "Summary Financials",
      "Grafici EBITDA e ricavi",
      "Benchmark di mercato",
      "Working Capital & Debt",
      "Recommendations operative",
      "Upload privato dei tuoi bilanci",
    ],
    excluded: [
      "Crediti mensili inclusi",
      "Uso ricorrente da dashboard",
    ],
    cta: "Ricarica credito",
    ctaAction: "checkout",
    highlight: false,
    icon: CreditCard,
  },
  {
    id: "pro",
    name: "BilancioAI Plus",
    price: "79",
    period: "/mese",
    description: "Per imprenditori, advisor e uso ricorrente",
    features: [
      "5 analisi incluse al mese",
      "Summary Financials e grafici completi",
      "Benchmark di mercato",
      "Working Capital & Debt",
      "Recommendations operative",
      "Upload privato dei tuoi bilanci",
      "Storico analisi e watchlist",
      "Analisi extra via wallet",
    ],
    excluded: [],
    cta: "Attiva BilancioAI Plus",
    ctaAction: "subscribe_pro",
    highlight: true,
    icon: Crown,
  },
];

export default function PricingPage() {
  const [, navigate] = useLocation();
  const { token } = useAuth();
  const [loading, setLoading] = useState<string | null>(null);

  const handleAction = async (action: string) => {
    if (!token) return;
    setLoading(action);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };

    try {
      if (action === "checkout") {
        const res = await fetch(`${API_BASE}/api/billing/checkout`, {
          method: "POST",
          headers,
          body: JSON.stringify({ topUpCents: 2900 }),
        });
        const data = await res.json();
        if (data?.data?.url) {
          window.location.href = data.data.url;
        }
      } else if (action === "subscribe_pro") {
        const plan = "pro";
        const res = await fetch(`${API_BASE}/api/billing/subscribe`, {
          method: "POST",
          headers,
          body: JSON.stringify({ plan }),
        });
        const data = await res.json();
        if (data?.data?.url) {
          window.location.href = data.data.url;
        }
      }
    } catch (err) {
      console.error("Pricing action error:", err);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/50 bg-card/60 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 sm:h-16 flex items-center">
          <Button variant="ghost" size="sm" onClick={() => navigate("/")} className="gap-2">
            <ArrowLeft className="w-4 h-4" />
            Home
          </Button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12">
        <div className="text-center mb-12">
          <h1 className="text-3xl font-bold tracking-tight">Scegli il piano giusto per te</h1>
          <p className="text-muted-foreground mt-3 max-w-lg mx-auto">
            BilancioAI combina bilanci ufficiali, benchmark di mercato e raccomandazioni operative in un report unico.
          </p>
        </div>

        <div className="mx-auto grid max-w-4xl grid-cols-1 gap-5 md:grid-cols-2">
          {PLANS.map((plan) => {
            const Icon = plan.icon;
            return (
              <Card
                key={plan.id}
                className={`relative flex flex-col ${plan.highlight ? "border-primary shadow-lg ring-1 ring-primary/20" : ""}`}
              >
                {plan.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge className="bg-primary text-primary-foreground text-xs px-3">Consigliato</Badge>
                  </div>
                )}
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2 mb-2">
                    <Icon className="w-5 h-5 text-primary" />
                    <CardTitle className="text-lg">{plan.name}</CardTitle>
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold">{"\u20ac"}{plan.price}</span>
                    {plan.period && <span className="text-sm text-muted-foreground">{plan.period}</span>}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">{plan.description}</p>
                </CardHeader>
                <CardContent className="flex-1 flex flex-col">
                  <ul className="space-y-2 flex-1">
                    {plan.features.map((f, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm">
                        <Check className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
                        <span>{f}</span>
                      </li>
                    ))}
                    {plan.excluded.map((f, i) => (
                      <li key={`ex-${i}`} className="flex items-start gap-2 text-sm text-muted-foreground/50 line-through">
                        <span className="w-4 text-center shrink-0 mt-0.5">-</span>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  {plan.cta && plan.ctaAction && (
                    <Button
                      className="w-full mt-6 gap-2"
                      variant={plan.highlight ? "default" : "outline"}
                      onClick={() => handleAction(plan.ctaAction!)}
                      disabled={loading !== null}
                    >
                      {loading === plan.ctaAction && <Loader2 className="w-4 h-4 animate-spin" />}
                      {plan.cta}
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="mt-16 max-w-2xl mx-auto">
          <h2 className="text-xl font-semibold text-center mb-6">Domande frequenti</h2>
          <div className="space-y-4">
            <div>
              <h3 className="font-medium text-sm">Cosa include l'analisi singola?</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Include il report completo azienda con grafici ricavi/EBITDA, summary financials,
                benchmark di mercato, analisi di working capital e debito, raccomandazioni operative
                e la possibilita' di usare i bilanci che hai gia' caricandoli direttamente in piattaforma.
              </p>
            </div>
            <div>
              <h3 className="font-medium text-sm">Cosa sblocca BilancioAI Plus?</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Hai 5 analisi incluse al mese, dashboard con storico, benchmark di mercato, raccomandazioni,
                caricamento dei tuoi bilanci e possibilita' di usare il wallet per analisi extra.
              </p>
            </div>
            <div>
              <h3 className="font-medium text-sm">Posso cambiare piano in qualsiasi momento?</h3>
              <p className="text-sm text-muted-foreground mt-1">
                S{"\u00ec"}, puoi aggiornare o cancellare il tuo abbonamento in qualsiasi momento.
                Il cambio ha effetto immediato.
              </p>
            </div>
            <div>
              <h3 className="font-medium text-sm">Come funzionano le analisi extra?</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Se finisci le analisi incluse, puoi ricaricare credito wallet e lanciare nuovi report
                senza cambiare piano.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
