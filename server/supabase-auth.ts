import { createClient } from "@supabase/supabase-js";
import { storage } from "./storage";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const OAUTH_PASSWORD_PLACEHOLDER = "supabase-auth-placeholder";

let supabase: ReturnType<typeof createClient> | null = null;

function getSupabase() {
  if (!supabase) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabase;
}

/**
 * Verifica il token Supabase (access_token dalla sessione) e restituisce il nostro user (id, email, name).
 * Se l'utente Supabase non esiste nella nostra users table, lo crea (link auth_id).
 */
export async function getOrCreateUserFromSupabaseToken(
  accessToken: string
): Promise<{ id: number; email: string; name?: string } | null> {
  const sb = getSupabase();
  if (!sb) return null;

  const { data: { user: authUser }, error } = await sb.auth.getUser(accessToken);
  if (error || !authUser) return null;

  const authId = authUser.id;
  const email = (authUser.email || "").toLowerCase();
  const name = authUser.user_metadata?.name ?? authUser.user_metadata?.full_name ?? null;

  let user = await storage.getUserByAuthId(authId);
  if (!user) {
    const existingByEmail = email ? await storage.getUserByEmail(email) : undefined;

    if (existingByEmail) {
      user =
        existingByEmail.authId === authId
          ? existingByEmail
          : (await storage.updateUserAuthId(existingByEmail.id, authId)) ?? existingByEmail;
    } else {
      user = await storage.createUser({
        authId,
        email: email || `user-${authId}@supabase.local`,
        passwordHash: OAUTH_PASSWORD_PLACEHOLDER,
        name,
      });
    }
  }
  return { id: user.id, email: user.email, name: user.name ?? undefined };
}

export function isSupabaseAuthConfigured(): boolean {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}
