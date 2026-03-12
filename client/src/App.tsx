import { useState, createContext, useContext, useEffect } from "react";
import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import HomePage from "@/pages/home";
import AnalysisPage from "@/pages/analysis";
import ResultsPage from "@/pages/results";
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
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<{ id: number; email: string; name?: string } | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    if (!supabase) {
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
      setToken(accessToken);
      try {
        const res = await fetch(`${API_BASE}/api/auth/me`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (res.ok) {
          const data = await res.json();
          setUser(data.user);
        } else {
          setUser(null);
        }
      } catch {
        setUser(null);
      } finally {
        setAuthReady(true);
      }
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      syncUser(session?.access_token ?? null);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
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
