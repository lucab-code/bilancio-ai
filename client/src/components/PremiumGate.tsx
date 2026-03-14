import { Lock, Crown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";

interface PremiumGateProps {
  children: React.ReactNode;
  isUnlocked: boolean;
  featureLabel?: string;
}

export function PremiumGate({ children, isUnlocked, featureLabel = "questa funzionalità" }: PremiumGateProps) {
  const [, navigate] = useLocation();

  if (isUnlocked) return <>{children}</>;

  return (
    <div className="relative">
      <div className="pointer-events-none select-none" style={{ filter: "blur(8px)" }}>
        {children}
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/60 backdrop-blur-[2px] rounded-lg">
        <div className="flex flex-col items-center gap-3 p-6 text-center max-w-sm">
          <div className="rounded-full bg-primary/10 p-3">
            <Lock className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold text-foreground text-base">
              Sblocca {featureLabel}
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              Disponibile con abbonamento Pro o Business
            </p>
          </div>
          <Button
            onClick={() => navigate("/pricing")}
            className="gap-2 mt-1"
          >
            <Crown className="w-4 h-4" />
            Vedi piani
          </Button>
        </div>
      </div>
    </div>
  );
}
