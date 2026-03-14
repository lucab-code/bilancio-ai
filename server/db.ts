import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

let _db: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (_db) return _db;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for Supabase backend");
  }
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    ssl: connectionString.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  pool.on("error", (err) => console.error("DB pool error:", err.message));
  _db = drizzle(pool, { schema });
  return _db;
}
