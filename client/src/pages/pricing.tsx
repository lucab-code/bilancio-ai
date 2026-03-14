import { useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, Check, Crown, CreditCard, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/App";
import { AppTopBar } from "@/components/AppTopBar";

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
    <div className="stripe-page min-h-screen bg-background">
      <AppTopBar
        maxWidthClassName="max-w-5xl"
        left={(
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/")}
              className="stripe-topbar-chip h-11 rounded-full px-4 text-sm font-medium text-slate-700 hover:bg-white hover:text-slate-950"
            >
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              Home
            </Button>
            <div className="stripe-topbar-divider hidden sm:block" />
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                Billing
              </div>
              <div className="truncate text-sm font-semibold text-slate-950">Pricing</div>
            </div>
          </>
        )}
      />

      <div className="stripe-shell mx-auto max-w-5xl px-4 py-12 sm:px-6">
        <div className="stripe-panel mb-12 px-6 py-10 text-center sm:px-10 sm:py-14">
          <div className="stripe-kicker mb-6">Pricing</div>
          <h1 className="stripe-display text-[clamp(2.4rem,3vw,4rem)]">Scegli il piano giusto per te</h1>
          <p className="stripe-lead mt-4 mx-auto max-w-2xl">
            BilancioAI combina bilanci ufficiali, benchmark di mercato e raccomandazioni operative in un report unico.
          </p>
        </div>

        <div className="mx-auto grid max-w-4xl grid-cols-1 gap-5 md:grid-cols-2">
          {PLANS.map((plan) => {
            const Icon = plan.icon;
            return (
              <Card
                key={plan.id}
                className={`stripe-card-hover relative flex flex-col ${plan.highlight ? "border-primary/30 bg-[linear-gradient(180deg,rgba(255,255,255,0.96)_0%,rgba(244,243,255,0.94)_100%)] shadow-[0_32px_80px_-48px_rgba(99,91,255,0.42)] ring-1 ring-primary/15" : ""}`}
              >
                {plan.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge className="bg-primary text-primary-foreground text-xs px-3">Consigliato</Badge>
                  </div>
                )}
                <CardHeader className="pb-2">
                  <div className="mb-3 inline-flex w-fit items-center gap-2 rounded-full border border-white/80 bg-white/75 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                    <Icon className="w-5 h-5 text-primary" />
                    {plan.name}
                  </div>
                  <CardTitle className="text-[28px] tracking-[-0.04em]">{plan.name}</CardTitle>
                  <div className="flex items-baseline gap-1">
                    <span className="text-4xl font-semibold tracking-[-0.05em]">{"\u20ac"}{plan.price}</span>
                    {plan.period && <span className="text-sm text-muted-foreground">{plan.period}</span>}
                  </div>
                  <p className="mt-2 text-sm leading-7 text-slate-600">{plan.description}</p>
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

        <div className="stripe-panel-soft mt-16 mx-auto max-w-2xl px-6 py-8">
          <h2 className="mb-6 text-center text-xl font-semibold tracking-[-0.03em]">Domande frequenti</h2>
          <div className="space-y-4">
            <div className="rounded-[24px] border border-white/75 bg-white/70 p-4">
              <h3 className="font-medium text-sm">Cosa include l'analisi singola?</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Include il report completo azienda con grafici ricavi/EBITDA, summary financials,
                benchmark di mercato, analisi di working capital e debito, raccomandazioni operative
                e la possibilita' di usare i bilanci che hai gia' caricandoli direttamente in piattaforma.
              </p>
            </div>
            <div className="rounded-[24px] border border-white/75 bg-white/70 p-4">
              <h3 className="font-medium text-sm">Cosa sblocca BilancioAI Plus?</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Hai 5 analisi incluse al mese, dashboard con storico, benchmark di mercato, raccomandazioni,
                caricamento dei tuoi bilanci e possibilita' di usare il wallet per analisi extra.
              </p>
            </div>
            <div className="rounded-[24px] border border-white/75 bg-white/70 p-4">
              <h3 className="font-medium text-sm">Posso cambiare piano in qualsiasi momento?</h3>
              <p className="text-sm text-muted-foreground mt-1">
                S{"\u00ec"}, puoi aggiornare o cancellare il tuo abbonamento in qualsiasi momento.
                Il cambio ha effetto immediato.
              </p>
            </div>
            <div className="rounded-[24px] border border-white/75 bg-white/70 p-4">
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
