import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { LogIn, UserPlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { PerplexityAttribution } from "@/components/PerplexityAttribution";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

function openGoogleLogin() {
  window.location.href = `${API_BASE}/api/auth/google`;
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

export default function LoginPage({
  onLogin,
  onGoogleCallbackToken,
}: {
  onLogin: (token: string, user: any) => void;
  onGoogleCallbackToken?: (token: string, user: any) => void;
}) {
  const [, setLocation] = useLocation();
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [allowRegistration, setAllowRegistration] = useState(true);
  const [hasGoogle, setHasGoogle] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/config`)
      .then((r) => r.ok ? r.json() : { allowRegistration: true, hasGoogle: false })
      .then((data) => {
        setAllowRegistration(data.allowRegistration !== false);
        setHasGoogle(!!data.hasGoogle);
      })
      .catch(() => {});
  }, []);

  const googleCallbackHandled = useRef(false);
  // Handle redirect from Google OAuth: ?token=... or ?error=...
  useEffect(() => {
    if (googleCallbackHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    const error = params.get("error");
    if (error) {
      googleCallbackHandled.current = true;
      toast({ title: "Login Google annullato o fallito", description: decodeURIComponent(error), variant: "destructive" });
      window.history.replaceState({}, "", window.location.pathname + window.location.hash);
      return;
    }
    if (!token || !onGoogleCallbackToken) return;
    googleCallbackHandled.current = true;
    fetch(`${API_BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.user) onGoogleCallbackToken(token, data.user);
        window.history.replaceState({}, "", window.location.pathname + window.location.hash);
      })
      .catch(() => {
        window.history.replaceState({}, "", window.location.pathname + window.location.hash);
      });
  }, [onGoogleCallbackToken, toast]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      toast({ title: "Compila tutti i campi", variant: "destructive" });
      return;
    }

    setIsLoading(true);
    try {
      const endpoint = isRegister ? "/api/auth/register" : "/api/auth/login";
      const body: any = { email, password };
      if (isRegister && name) body.name = name;

      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        toast({ title: data.error || "Errore", variant: "destructive" });
        return;
      }

      onLogin(data.token, data.user);
    } catch (error: any) {
      toast({ title: "Errore di connessione", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4">
      <div className="flex items-center gap-3 mb-8">
        <BilancioLogo className="w-10 h-10 text-primary" />
        <span className="text-2xl font-bold tracking-tight">BilancioAI</span>
      </div>

      <Card className="w-full max-w-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-lg text-center">
            {isRegister ? "Crea account" : "Accedi"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {isRegister && (
              <div className="space-y-1.5">
                <Label htmlFor="name" className="text-sm">Nome (opzionale)</Label>
                <Input
                  id="name"
                  type="text"
                  placeholder="Il tuo nome"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="input-name"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-sm">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="email@esempio.it"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                data-testid="input-email"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-sm">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                data-testid="input-password"
              />
            </div>
            <Button type="submit" className="w-full" disabled={isLoading} data-testid="button-submit-auth">
              {isLoading ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : isRegister ? (
                <UserPlus className="w-4 h-4 mr-2" />
              ) : (
                <LogIn className="w-4 h-4 mr-2" />
              )}
              {isRegister ? "Registrati" : "Accedi"}
            </Button>

            {hasGoogle && (
              <>
                <div className="relative my-4">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t border-border" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase text-muted-foreground">
                    <span className="bg-card px-2">oppure</span>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={openGoogleLogin}
                  data-testid="button-google-login"
                >
                  <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" aria-hidden>
                    <path
                      fill="#4285F4"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    />
                  </svg>
                  Accedi con Google
                </Button>
              </>
            )}
          </form>

          {allowRegistration && (
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={() => setIsRegister(!isRegister)}
                className="text-sm text-primary hover:underline"
                data-testid="button-toggle-auth"
              >
                {isRegister ? "Hai già un account? Accedi" : "Non hai un account? Registrati"}
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="mt-8">
        <PerplexityAttribution />
      </div>
    </div>
  );
}
