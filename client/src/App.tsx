import { useState, createContext, useContext, useEffect } from "react";
import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import HomePage from "@/pages/home";
import AnalysisPage from "@/pages/analysis";
import ResultsPage from "@/pages/results";
import PricingPage from "@/pages/pricing";
import LoginPage from "@/pages/login";
import NotFound from "@/pages/not-found";
import { supabase } from "./lib/supabase";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// Auth context
interface AuthState {
  token: string | null;
  user: { id: number; email: string; name?: string } | null;
  logout: () => void;
}

export const AuthContext = createContext<AuthState>({
  token: null,
  user: null,
  logout: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={HomePage} />
      <Route path="/analysis/:mode" component={AnalysisPage} />
      <Route path="/results" component={ResultsPage} />
      <Route path="/pricing" component={PricingPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<{ id: number; email: string; name?: string } | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    const sb = supabase;
    if (!sb) {
      setAuthReady(true);
      return;
    }

    const syncUser = async (accessToken: string | null) => {
      if (!accessToken) {
        setToken(null);
        setUser(null);
        setAuthReady(true);
        return;
      }
      try {
        const res = await fetch(`${API_BASE}/api/auth/me`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (res.ok) {
          const data = await res.json();
          setToken(accessToken);
          setUser(data.user);
        } else {
          setToken(null);
          setUser(null);
        }
      } catch {
        setToken(null);
        setUser(null);
      } finally {
        setAuthReady(true);
      }
    };

    const clearAuthCallbackUrl = () => {
      const nextPath = window.location.pathname === "/auth/callback" ? "/" : window.location.pathname;
      window.history.replaceState(null, "", `${nextPath}${window.location.search.includes("billing=") ? window.location.search : ""}#/`);
    };

    const consumeAuthRedirect = async (): Promise<boolean> => {
      const searchParams = new URLSearchParams(window.location.search);
      const oauthCode = searchParams.get("code");
      const oauthError = searchParams.get("error_description") || searchParams.get("error");

      if (oauthError) {
        console.error("Supabase OAuth callback error:", oauthError);
        clearAuthCallbackUrl();
        return false;
      }

      if (oauthCode) {
        try {
          const { error } = await sb.auth.exchangeCodeForSession(window.location.href);
          if (error) {
            console.error("Supabase exchangeCodeForSession failed:", error);
            clearAuthCallbackUrl();
            return false;
          }

          clearAuthCallbackUrl();
          const { data: { session } } = await sb.auth.getSession();
          await syncUser(session?.access_token ?? null);
          return true;
        } catch (error) {
          console.error("Supabase OAuth callback exchange threw:", error);
          clearAuthCallbackUrl();
          return false;
        }
      }

      const hash = window.location.hash.replace(/^#/, "");
      const params = new URLSearchParams(hash);
      const accessToken = params.get("access_token");
      const refreshToken = params.get("refresh_token");

      if (accessToken && refreshToken) {
        try {
          const { error } = await sb.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
          if (!error) {
            clearAuthCallbackUrl();
            const { data: { session } } = await sb.auth.getSession();
            await syncUser(session?.access_token ?? null);
            return true;
          }
        } catch (error) {
          console.error("Supabase OAuth hash session restore failed:", error);
        }
      }

      return false;
    };

    const runAuth = async () => {
      if (await consumeAuthRedirect()) {
        return;
      }

      const hash = window.location.hash.replace(/^#/, "");
      const params = new URLSearchParams(hash);
      const accessToken = params.get("access_token");
      const refreshToken = params.get("refresh_token");

      const { data: { session } } = await sb.auth.getSession();
      await syncUser(session?.access_token ?? null);
    };

    runAuth();

    const { data: { subscription } } = sb.auth.onAuthStateChange((_event, session) => {
      syncUser(session?.access_token ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleLogout = async () => {
    if (supabase) await supabase.auth.signOut();
    setToken(null);
    setUser(null);
  };

  if (!authReady) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Caricamento...</div>
      </div>
    );
  }

  if (!token || !user) {
    return (
      <QueryClientProvider client={queryClient}>
        <LoginPage onLoggedIn={() => {}} />
        <Toaster />
      </QueryClientProvider>
    );
  }

  return (
    <AuthContext.Provider value={{ token, user, logout: handleLogout }}>
      <QueryClientProvider client={queryClient}>
        <Router hook={useHashLocation}>
          <AppRouter />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthContext.Provider>
  );
}

export default App;
