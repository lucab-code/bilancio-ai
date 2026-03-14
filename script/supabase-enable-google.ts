/**
 * Abilita il provider Google in Supabase Auth via Management API.
 * Richiede: SUPABASE_ACCESS_TOKEN (PAT da https://supabase.com/dashboard/account/tokens)
 *           GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (da Google Cloud Console).
 * In Google Cloud Console → Credenziali → Client OAuth 2.0 → URI di reindirizzamento autorizzati
 *   aggiungi: https://tsfffttkonzoefellxov.supabase.co/auth/v1/callback
 * Esegui: npm run supabase:enable-google
 */
import "dotenv/config";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const PAT = process.env.SUPABASE_ACCESS_TOKEN || "";
const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID ||
  "307696250732-rltiitugs6ngv0m65dvau0dkk5b35hpa.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";

function getProjectRef(url: string): string | null {
  const m = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/);
  return m ? m[1] : null;
}

async function main() {
  const ref = getProjectRef(SUPABASE_URL);
  if (!ref) {
    console.error("SUPABASE_URL non valida o ref non trovata.");
    process.exit(1);
  }
  if (!PAT) {
    console.error(
      "Imposta SUPABASE_ACCESS_TOKEN (PAT da https://supabase.com/dashboard/account/tokens)"
    );
    process.exit(1);
  }
  if (!GOOGLE_CLIENT_SECRET) {
    console.error(
      "Imposta GOOGLE_CLIENT_SECRET in .env (da Google Cloud Console → Credenziali → Client OAuth 2.0)"
    );
    process.exit(1);
  }

  const res = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/config/auth`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${PAT}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        external_google_enabled: true,
        external_google_client_id: GOOGLE_CLIENT_ID,
        external_google_secret: GOOGLE_CLIENT_SECRET,
        site_url: process.env.FRONTEND_ORIGIN || "http://localhost:3000",
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    console.error("PATCH auth config fallito:", res.status, text);
    process.exit(1);
  }
  console.log("Google provider abilitato in Supabase Auth.");
}

main();
