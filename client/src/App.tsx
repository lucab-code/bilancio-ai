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

const AUTH_STORAGE_KEY = "bilancio_ai_auth";
const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

function loadStoredAuth(): { token: string; user: { id: number; email: string; name?: string } } | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data?.token && data?.user) return data;
  } catch {
    /* ignore */
  }
  return null;
}

function saveAuth(token: string, user: { id: number; email: string; name?: string }) {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token, user }));
}

function clearStoredAuth() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

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
    const stored = loadStoredAuth();
    if (!stored) {
      setAuthReady(true);
      return;
    }
    fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${stored.token}` },
    })
      .then((res) => {
        if (res.ok) return res.json();
        clearStoredAuth();
        return null;
      })
      .then((data) => {
        if (data?.user) {
          setToken(stored.token);
          setUser(data.user);
        }
      })
      .catch(() => clearStoredAuth())
      .finally(() => setAuthReady(true));
  }, []);

  const handleLogin = (newToken: string, newUser: any) => {
    setToken(newToken);
    setUser(newUser);
    saveAuth(newToken, newUser);
  };

  const handleLogout = () => {
    const currentToken = token;
    setToken(null);
    setUser(null);
    clearStoredAuth();
    if (currentToken) {
      fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${currentToken}` },
      }).catch(() => {});
    }
  };

  if (!authReady) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Caricamento...</div>
      </div>
    );
  }

  if (!token) {
    return (
      <QueryClientProvider client={queryClient}>
        <LoginPage onLogin={handleLogin} onGoogleCallbackToken={handleLogin} />
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
