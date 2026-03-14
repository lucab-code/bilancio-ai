import { createClient } from "@supabase/supabase-js";

declare global {
  interface Window {
    __BILANCIO_RUNTIME_CONFIG__?: {
      supabaseUrl?: string;
      supabaseAnonKey?: string;
    };
  }
}

const runtimeConfig = typeof window !== "undefined" ? window.__BILANCIO_RUNTIME_CONFIG__ : undefined;

const url = runtimeConfig?.supabaseUrl || import.meta.env.VITE_SUPABASE_URL || "";
const anonKey = runtimeConfig?.supabaseAnonKey || import.meta.env.VITE_SUPABASE_ANON_KEY || "";

export const supabase = url && anonKey ? createClient(url, anonKey) : null;
