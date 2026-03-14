import { useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, Check, Crown, Zap, Building2, CreditCard, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/App";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

const PLANS = [
  {
    id: "free",
    name: "Free",
    price: "0",
    period: "",
    description: "Scopri BilancioAI",
    features: [
      "Ricerca aziende illimitata",
      "Dati base azienda (fatturato, settore, dipendenti)",
    ],
    excluded: [
      "Analisi finanziaria completa",
      "Grafici EBITDA e ricavi",
      "SWOT Analysis",
      "Raccomandazioni strategiche",
      "Analisi competitor",
      "Export PDF",
    ],
    cta: null,
    highlight: false,
    icon: Building2,
  },
  {
    id: "single",
    name: "Analisi Singola",
    price: "15",
    period: "per analisi",
    description: "Paga solo quando ti serve",
    features: [
      "Analisi finanziaria completa",
      "Download bilanci CCIAA (4 anni)",
      "Grafici EBITDA e ricavi",
      "Conto economico e stato patrimoniale",
      "Analisi Cash Flow",
      "Indicatori chiave con trend",
    ],
    excluded: [
      "Raccomandazioni strategiche",
      "Analisi competitor",
      "Confronto di mercato",
      "Export PDF",
    ],
    cta: "Ricarica credito",
    ctaAction: "checkout",
    highlight: false,
    icon: CreditCard,
  },
  {
    id: "pro",
    name: "Pro",
    price: "79",
    period: "/mese",
    yearlyPrice: "699/anno",
    description: "Per professionisti e consulenti",
    features: [
      "5 analisi incluse al mese",
      "Tutto dell'Analisi Singola",
      "Raccomandazioni strategiche",
      "Analisi competitor (3-5 aziende)",
      "Confronto di mercato",
      "Profilo web aziendale",
      "Export PDF del report",
      "Analisi extra a \u20ac12 ciascuna",
    ],
    excluded: [],
    cta: "Abbonati a Pro",
    ctaAction: "subscribe_pro",
    highlight: true,
    icon: Crown,
  },
  {
    id: "business",
    name: "Business",
    price: "199",
    period: "/mese",
    yearlyPrice: "1.799/anno",
    description: "Per studi e team",
    features: [
      "15 analisi incluse al mese",
      "Tutto del Pro",
      "Analisi extra a \u20ac10 ciascuna",
      "Supporto prioritario",
    ],
    excluded: [],
    cta: "Abbonati a Business",
    ctaAction: "subscribe_business",
    highlight: false,
    icon: Zap,
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
          body: JSON.stringify({ topUpCents: 1500 }),
        });
        const data = await res.json();
        if (data?.data?.url) {
          window.location.href = data.data.url;
        }
      } else if (action === "subscribe_pro" || action === "subscribe_business") {
        const plan = action === "subscribe_pro" ? "pro" : "business";
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
            Analisi finanziarie complete con dati dalla Camera di Commercio e intelligenza artificiale.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
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
                  {"yearlyPrice" in plan && plan.yearlyPrice && (
                    <p className="text-xs text-muted-foreground">
                      oppure {"\u20ac"}{plan.yearlyPrice} (~2 mesi gratis)
                    </p>
                  )}
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
                L'analisi completa include download dei bilanci ufficiali dalla Camera di Commercio (fino a 4 anni),
                grafici comparativi EBITDA e ricavi, analisi del conto economico, stato patrimoniale, cash flow,
                e indicatori chiave con trend.
              </p>
            </div>
            <div>
              <h3 className="font-medium text-sm">Cosa sblocca l'abbonamento Pro?</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Con Pro hai 5 analisi al mese incluse, pi{"\u00f9"} le funzionalit{"\u00e0"} premium: raccomandazioni strategiche
                personalizzate, analisi dei competitor, confronto di mercato, profilo web aziendale,
                e export PDF del report completo.
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
                Se superi le analisi incluse nel tuo piano, puoi acquistarne altre a prezzo scontato
                ({"\u20ac"}12 per Pro, {"\u20ac"}10 per Business) tramite il tuo credito wallet.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
