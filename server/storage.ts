import type { Analysis, InsertAnalysis, User, InsertUser } from "@shared/schema";
import { users, analyses, sessions, bilanciCache, companyDetailsCache, companyFullCache } from "@shared/schema";
import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { getDb } from "./db";

export interface IStorage {
  // Users
  createUser(data: InsertUser): Promise<User>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserById(id: number): Promise<User | undefined>;
  getUserByAuthId(authId: string): Promise<User | undefined>;

  // Analyses
  createAnalysis(data: InsertAnalysis): Promise<Analysis>;
  getAnalysis(id: number): Promise<Analysis | undefined>;
  updateAnalysis(id: number, data: Partial<Analysis>): Promise<Analysis | undefined>;
  deleteAnalysis(id: number): Promise<boolean>;
  listAnalyses(): Promise<Analysis[]>;
  listAnalysesByUser(userId: number): Promise<Analysis[]>;

  // Bilanci cache (to avoid re-purchasing)
  cacheBilancio(companyId: string, taxCode: string, data: any): Promise<void>;
  getCachedBilancio(companyId: string): Promise<any | undefined>;
  getCachedBilancioByTaxCode(taxCode: string): Promise<any | undefined>;
  getCachedBilancioPackage(companyId: string): Promise<CachedBilancioPackage | undefined>;
  getCachedBilancioPackageByTaxCode(taxCode: string): Promise<CachedBilancioPackage | undefined>;
  cachePurchasedBilancio(
    companyId: string,
    taxCode: string,
    year: string,
    documents: any[],
    bilancioData: any,
  ): Promise<CachedBilancioPackage>;

  // Dettagli azienda OpenAPI (evita richieste IT-advanced ripetute)
  getCachedCompanyDetails(companyId: string): Promise<any | undefined>;
  setCachedCompanyDetails(companyId: string, data: any): Promise<void>;

  // Full Company OpenAPI (flow business grafico ricavi + EBITDA)
  getCachedCompanyFullData(companyId: string): Promise<any | undefined>;
  getCachedCompanyFullDataByTaxCode(taxCode: string): Promise<any | undefined>;
  setCachedCompanyFullData(companyId: string, taxCode: string, data: any): Promise<void>;
}

// Persistent JSON file storage
const DATA_DIR = path.join(process.cwd(), ".data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const ANALYSES_FILE = path.join(DATA_DIR, "analyses.json");
const BILANCI_FILE = path.join(DATA_DIR, "bilanci.json");
const COMPANY_DETAILS_FILE = path.join(DATA_DIR, "company_details.json");
const COMPANY_FULL_FILE = path.join(DATA_DIR, "company_full.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJSON<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (e) {
    console.error(`Error reading ${filePath}:`, e);
  }
  return fallback;
}

function writeJSON(filePath: string, data: any) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

interface StoredData {
  users: User[];
  nextUserId: number;
}

interface StoredAnalyses {
  analyses: Analysis[];
  nextAnalysisId: number;
}

interface StoredBilanci {
  entries: Record<string, { companyId: string; taxCode: string; data: any; ts: number }>;
}

interface StoredCompanyFull {
  entries: Record<string, { companyId: string; taxCode: string; data: any; ts: number }>;
}

export interface CachedPurchasedBilancio {
  year: string;
  fetchedAt: string;
  documents: any[];
  bilancioData: any;
}

export interface CachedBilancioPackage {
  bilanci: Record<string, any>;
  purchasedBilanci: Record<string, CachedPurchasedBilancio>;
  purchasedBilanciBySource?: Record<string, Record<string, CachedPurchasedBilancio>>;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCachedBilancioPackage(data: unknown): CachedBilancioPackage {
  if (isPlainObject(data) && ("bilanci" in data || "purchasedBilanci" in data)) {
    return {
      bilanci: isPlainObject(data.bilanci) ? data.bilanci : {},
      purchasedBilanci: isPlainObject(data.purchasedBilanci) ? data.purchasedBilanci : {},
      purchasedBilanciBySource: isPlainObject(data.purchasedBilanciBySource)
        ? data.purchasedBilanciBySource as Record<string, Record<string, CachedPurchasedBilancio>>
        : {},
    };
  }

  return {
    bilanci: isPlainObject(data) ? data : {},
    purchasedBilanci: {},
    purchasedBilanciBySource: {},
  };
}

export class FileStorage implements IStorage {
  private userData: StoredData;
  private analysisData: StoredAnalyses;
  private bilanciData: StoredBilanci;
  private companyFullData: StoredCompanyFull;

  constructor() {
    ensureDataDir();
    this.userData = readJSON<StoredData>(USERS_FILE, { users: [], nextUserId: 1 });
    this.analysisData = readJSON<StoredAnalyses>(ANALYSES_FILE, { analyses: [], nextAnalysisId: 1 });
    this.bilanciData = readJSON<StoredBilanci>(BILANCI_FILE, { entries: {} });
    this.companyFullData = readJSON<StoredCompanyFull>(COMPANY_FULL_FILE, { entries: {} });
  }

  private saveUsers() {
    writeJSON(USERS_FILE, this.userData);
  }

  private saveAnalyses() {
    writeJSON(ANALYSES_FILE, this.analysisData);
  }

  private saveBilanci() {
    writeJSON(BILANCI_FILE, this.bilanciData);
  }

  private saveCompanyFull() {
    writeJSON(COMPANY_FULL_FILE, this.companyFullData);
  }

  private getBilancioEntryByCompanyId(companyId: string) {
    return this.bilanciData.entries[`company:${companyId}`];
  }

  private getBilancioEntryByTaxCode(taxCode: string) {
    return this.bilanciData.entries[`tax:${taxCode}`];
  }

  private getCompanyFullEntryByCompanyId(companyId: string) {
    return this.companyFullData.entries[`company:${companyId}`];
  }

  private getCompanyFullEntryByTaxCode(taxCode: string) {
    return this.companyFullData.entries[`tax:${taxCode}`];
  }

  private upsertBilancioEntry(companyId: string, taxCode: string, data: CachedBilancioPackage) {
    const entry = { companyId, taxCode, data, ts: Date.now() };
    this.bilanciData.entries[`company:${companyId}`] = entry;
    this.bilanciData.entries[`tax:${taxCode}`] = entry;
    this.saveBilanci();
  }

  private upsertCompanyFullEntry(companyId: string, taxCode: string, data: any) {
    const entry = { companyId, taxCode, data, ts: Date.now() };
    this.companyFullData.entries[`company:${companyId}`] = entry;
    this.companyFullData.entries[`tax:${taxCode}`] = entry;
    this.saveCompanyFull();
  }

  // Users
  async createUser(data: InsertUser): Promise<User> {
    const id = this.userData.nextUserId++;
    const user: User = {
      id,
      authId: data.authId ?? null,
      email: data.email,
      passwordHash: data.passwordHash,
      name: data.name ?? null,
    };
    this.userData.users.push(user);
    this.saveUsers();
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    return this.userData.users.find(u => u.email === email);
  }

  async getUserById(id: number): Promise<User | undefined> {
    return this.userData.users.find(u => u.id === id);
  }

  async getUserByAuthId(authId: string): Promise<User | undefined> {
    return this.userData.users.find(u => u.authId === authId);
  }

  // Analyses
  async createAnalysis(data: InsertAnalysis): Promise<Analysis> {
    const id = this.analysisData.nextAnalysisId++;
    const analysis: Analysis = {
      id,
      userId: data.userId ?? null,
      mode: data.mode,
      companyName: data.companyName,
      companyId: data.companyId ?? null,
      taxCode: data.taxCode ?? null,
      address: data.address ?? null,
      status: data.status ?? "pending",
      companyDetails: data.companyDetails ?? null,
      financialData: data.financialData ?? null,
      aiAnalysis: data.aiAnalysis ?? null,
      competitors: data.competitors ?? null,
      createdAt: data.createdAt ?? new Date().toISOString(),
    };
    this.analysisData.analyses.push(analysis);
    this.saveAnalyses();
    return analysis;
  }

  async getAnalysis(id: number): Promise<Analysis | undefined> {
    return this.analysisData.analyses.find(a => a.id === id);
  }

  async updateAnalysis(id: number, data: Partial<Analysis>): Promise<Analysis | undefined> {
    const idx = this.analysisData.analyses.findIndex(a => a.id === id);
    if (idx === -1) return undefined;
    this.analysisData.analyses[idx] = { ...this.analysisData.analyses[idx], ...data };
    this.saveAnalyses();
    return this.analysisData.analyses[idx];
  }

  async deleteAnalysis(id: number): Promise<boolean> {
    const initialLength = this.analysisData.analyses.length;
    this.analysisData.analyses = this.analysisData.analyses.filter(a => a.id !== id);
    if (this.analysisData.analyses.length === initialLength) return false;
    this.saveAnalyses();
    return true;
  }

  async listAnalyses(): Promise<Analysis[]> {
    return this.analysisData.analyses;
  }

  async listAnalysesByUser(userId: number): Promise<Analysis[]> {
    return this.analysisData.analyses.filter(a => a.userId === userId);
  }

  // Bilanci cache
  async cacheBilancio(companyId: string, taxCode: string, data: any): Promise<void> {
    const existing = normalizeCachedBilancioPackage(
      this.getBilancioEntryByCompanyId(companyId)?.data ?? this.getBilancioEntryByTaxCode(taxCode)?.data,
    );
    this.upsertBilancioEntry(companyId, taxCode, {
      bilanci: isPlainObject(data) ? data : existing.bilanci,
      purchasedBilanci: existing.purchasedBilanci,
      purchasedBilanciBySource: existing.purchasedBilanciBySource,
    });
  }

  async getCachedBilancio(companyId: string): Promise<any | undefined> {
    return normalizeCachedBilancioPackage(this.getBilancioEntryByCompanyId(companyId)?.data).bilanci;
  }

  async getCachedBilancioByTaxCode(taxCode: string): Promise<any | undefined> {
    return normalizeCachedBilancioPackage(this.getBilancioEntryByTaxCode(taxCode)?.data).bilanci;
  }

  async getCachedBilancioPackage(companyId: string): Promise<CachedBilancioPackage | undefined> {
    const entry = this.getBilancioEntryByCompanyId(companyId);
    if (!entry) return undefined;
    return normalizeCachedBilancioPackage(entry.data);
  }

  async getCachedBilancioPackageByTaxCode(taxCode: string): Promise<CachedBilancioPackage | undefined> {
    const entry = this.getBilancioEntryByTaxCode(taxCode);
    if (!entry) return undefined;
    return normalizeCachedBilancioPackage(entry.data);
  }

  async cachePurchasedBilancio(
    companyId: string,
    taxCode: string,
    year: string,
    documents: any[],
    bilancioData: any,
  ): Promise<CachedBilancioPackage> {
    const existing = normalizeCachedBilancioPackage(
      this.getBilancioEntryByCompanyId(companyId)?.data ?? this.getBilancioEntryByTaxCode(taxCode)?.data,
    );
    const entry = {
      year,
      fetchedAt: new Date().toISOString(),
      documents,
      bilancioData,
    };
    const source = typeof bilancioData?.source === "string" ? bilancioData.source : "";
    const purchasedBilanciBySource = {
      ...(existing.purchasedBilanciBySource || {}),
    };
    if (source) {
      purchasedBilanciBySource[source] = {
        ...(purchasedBilanciBySource[source] || {}),
        [year]: entry,
      };
    }
    const merged: CachedBilancioPackage = {
      bilanci: existing.bilanci,
      purchasedBilanci: source
        ? existing.purchasedBilanci
        : {
            ...existing.purchasedBilanci,
            [year]: entry,
          },
      purchasedBilanciBySource,
    };
    this.upsertBilancioEntry(companyId, taxCode, merged);
    return merged;
  }

  async getCachedCompanyDetails(companyId: string): Promise<any | undefined> {
    const data = readJSON<Record<string, { data: any; ts: number }>>(COMPANY_DETAILS_FILE, {});
    const entry = data[companyId];
    if (!entry) return undefined;
    const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 giorni
    if (Date.now() - entry.ts > maxAge) return undefined;
    return entry.data;
  }

  async setCachedCompanyDetails(companyId: string, data: any): Promise<void> {
    ensureDataDir();
    const fileData = readJSON<Record<string, { data: any; ts: number }>>(COMPANY_DETAILS_FILE, {});
    fileData[companyId] = { data, ts: Date.now() };
    writeJSON(COMPANY_DETAILS_FILE, fileData);
  }

  async getCachedCompanyFullData(companyId: string): Promise<any | undefined> {
    const entry = this.getCompanyFullEntryByCompanyId(companyId);
    if (!entry) return undefined;
    const maxAge = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - entry.ts > maxAge) return undefined;
    return entry.data;
  }

  async getCachedCompanyFullDataByTaxCode(taxCode: string): Promise<any | undefined> {
    const entry = this.getCompanyFullEntryByTaxCode(taxCode);
    if (!entry) return undefined;
    const maxAge = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - entry.ts > maxAge) return undefined;
    return entry.data;
  }

  async setCachedCompanyFullData(companyId: string, taxCode: string, data: any): Promise<void> {
    this.upsertCompanyFullEntry(companyId, taxCode, data);
  }
}

// Sessions persisted to file
export class FileSessionStore {
  private sessions: Record<string, number>;

  constructor() {
    this.sessions = readJSON<Record<string, number>>(SESSIONS_FILE, {});
  }

  set(token: string, userId: number) {
    this.sessions[token] = userId;
    writeJSON(SESSIONS_FILE, this.sessions);
  }

  get(token: string): number | undefined {
    return this.sessions[token];
  }

  delete(token: string) {
    delete this.sessions[token];
    writeJSON(SESSIONS_FILE, this.sessions);
  }
}

// ========== Supabase / Postgres storage ==========
export class SupabaseStorage implements IStorage {
  private async getBilancioCacheRowByCompanyId(companyId: string) {
    const [row] = await getDb()
      .select()
      .from(bilanciCache)
      .where(eq(bilanciCache.companyId, companyId))
      .limit(1);
    return row;
  }

  private async getBilancioCacheRowByTaxCode(taxCode: string) {
    const [row] = await getDb()
      .select()
      .from(bilanciCache)
      .where(eq(bilanciCache.taxCode, taxCode))
      .limit(1);
    return row;
  }

  private async getCompanyFullCacheRowByCompanyId(companyId: string) {
    const [row] = await getDb()
      .select()
      .from(companyFullCache)
      .where(eq(companyFullCache.companyId, companyId))
      .limit(1);
    return row;
  }

  private async getCompanyFullCacheRowByTaxCode(taxCode: string) {
    const [row] = await getDb()
      .select()
      .from(companyFullCache)
      .where(eq(companyFullCache.taxCode, taxCode))
      .limit(1);
    return row;
  }

  private async upsertBilancioPackage(companyId: string, taxCode: string, data: CachedBilancioPackage): Promise<void> {
    const now = new Date().toISOString();
    await getDb()
      .insert(bilanciCache)
      .values({ companyId, taxCode, data: data as unknown as Record<string, unknown>, updatedAt: now })
      .onConflictDoUpdate({
        target: [bilanciCache.companyId, bilanciCache.taxCode],
        set: { data: data as unknown as Record<string, unknown>, updatedAt: now },
      });
  }

  private async upsertCompanyFullData(companyId: string, taxCode: string, data: any): Promise<void> {
    const now = new Date().toISOString();
    await getDb()
      .insert(companyFullCache)
      .values({ companyId, taxCode, data: data as Record<string, unknown>, updatedAt: now })
      .onConflictDoUpdate({
        target: [companyFullCache.companyId, companyFullCache.taxCode],
        set: { data: data as Record<string, unknown>, updatedAt: now },
      });
  }

  async createUser(data: InsertUser): Promise<User> {
    const [row] = await getDb().insert(users).values(data).returning();
    if (!row) throw new Error("createUser failed");
    return row as User;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [row] = await getDb().select().from(users).where(eq(users.email, email)).limit(1);
    return row as User | undefined;
  }

  async getUserById(id: number): Promise<User | undefined> {
    const [row] = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
    return row as User | undefined;
  }

  async getUserByAuthId(authId: string): Promise<User | undefined> {
    const [row] = await getDb().select().from(users).where(eq(users.authId, authId)).limit(1);
    return row as User | undefined;
  }

  async createAnalysis(data: InsertAnalysis): Promise<Analysis> {
    const insert = {
      userId: data.userId ?? null,
      mode: data.mode,
      companyName: data.companyName,
      companyId: data.companyId ?? null,
      taxCode: data.taxCode ?? null,
      address: data.address ?? null,
      status: data.status ?? "pending",
      companyDetails: data.companyDetails ?? null,
      financialData: data.financialData ?? null,
      aiAnalysis: data.aiAnalysis ?? null,
      competitors: data.competitors ?? null,
      createdAt: data.createdAt ?? new Date().toISOString(),
    };
    const [row] = await getDb().insert(analyses).values(insert).returning();
    if (!row) throw new Error("createAnalysis failed");
    return row as Analysis;
  }

  async getAnalysis(id: number): Promise<Analysis | undefined> {
    const [row] = await getDb().select().from(analyses).where(eq(analyses.id, id)).limit(1);
    return row as Analysis | undefined;
  }

  async updateAnalysis(id: number, data: Partial<Analysis>): Promise<Analysis | undefined> {
    const [row] = await getDb()
      .update(analyses)
      .set(data as Record<string, unknown>)
      .where(eq(analyses.id, id))
      .returning();
    return row as Analysis | undefined;
  }

  async deleteAnalysis(id: number): Promise<boolean> {
    const rows = await getDb()
      .delete(analyses)
      .where(eq(analyses.id, id))
      .returning({ id: analyses.id });
    return rows.length > 0;
  }

  async listAnalyses(): Promise<Analysis[]> {
    const rows = await getDb().select().from(analyses);
    return rows as Analysis[];
  }

  async listAnalysesByUser(userId: number): Promise<Analysis[]> {
    const rows = await getDb().select().from(analyses).where(eq(analyses.userId, userId));
    return rows as Analysis[];
  }

  async cacheBilancio(companyId: string, taxCode: string, data: unknown): Promise<void> {
    const existing = normalizeCachedBilancioPackage(
      (await this.getBilancioCacheRowByCompanyId(companyId))?.data ??
      (await this.getBilancioCacheRowByTaxCode(taxCode))?.data,
    );
    await this.upsertBilancioPackage(companyId, taxCode, {
      bilanci: isPlainObject(data) ? data : existing.bilanci,
      purchasedBilanci: existing.purchasedBilanci,
      purchasedBilanciBySource: existing.purchasedBilanciBySource,
    });
  }

  async getCachedBilancio(companyId: string): Promise<unknown> {
    const row = await this.getBilancioCacheRowByCompanyId(companyId);
    return normalizeCachedBilancioPackage(row?.data).bilanci;
  }

  async getCachedBilancioByTaxCode(taxCode: string): Promise<unknown> {
    const row = await this.getBilancioCacheRowByTaxCode(taxCode);
    return normalizeCachedBilancioPackage(row?.data).bilanci;
  }

  async getCachedBilancioPackage(companyId: string): Promise<CachedBilancioPackage | undefined> {
    const row = await this.getBilancioCacheRowByCompanyId(companyId);
    if (!row) return undefined;
    return normalizeCachedBilancioPackage(row.data);
  }

  async getCachedBilancioPackageByTaxCode(taxCode: string): Promise<CachedBilancioPackage | undefined> {
    const row = await this.getBilancioCacheRowByTaxCode(taxCode);
    if (!row) return undefined;
    return normalizeCachedBilancioPackage(row.data);
  }

  async cachePurchasedBilancio(
    companyId: string,
    taxCode: string,
    year: string,
    documents: any[],
    bilancioData: any,
  ): Promise<CachedBilancioPackage> {
    const existing = normalizeCachedBilancioPackage(
      (await this.getBilancioCacheRowByCompanyId(companyId))?.data ??
      (await this.getBilancioCacheRowByTaxCode(taxCode))?.data,
    );
    const entry = {
      year,
      fetchedAt: new Date().toISOString(),
      documents,
      bilancioData,
    };
    const source = typeof bilancioData?.source === "string" ? bilancioData.source : "";
    const purchasedBilanciBySource = {
      ...(existing.purchasedBilanciBySource || {}),
    };
    if (source) {
      purchasedBilanciBySource[source] = {
        ...(purchasedBilanciBySource[source] || {}),
        [year]: entry,
      };
    }
    const merged: CachedBilancioPackage = {
      bilanci: existing.bilanci,
      purchasedBilanci: source
        ? existing.purchasedBilanci
        : {
            ...existing.purchasedBilanci,
            [year]: entry,
          },
      purchasedBilanciBySource,
    };
    await this.upsertBilancioPackage(companyId, taxCode, merged);
    return merged;
  }

  async getCachedCompanyDetails(companyId: string): Promise<unknown> {
    const [row] = await getDb()
      .select()
      .from(companyDetailsCache)
      .where(eq(companyDetailsCache.companyId, companyId))
      .limit(1);
    if (!row) return undefined;
    const r = row as { data: unknown; updatedAt: string };
    const updatedAt = new Date(r.updatedAt).getTime();
    const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 giorni
    if (Date.now() - updatedAt > maxAge) return undefined;
    return r.data;
  }

  async setCachedCompanyDetails(companyId: string, data: unknown): Promise<void> {
    const now = new Date().toISOString();
    await getDb()
      .insert(companyDetailsCache)
      .values({ companyId, data: data as Record<string, unknown>, updatedAt: now })
      .onConflictDoUpdate({
        target: companyDetailsCache.companyId,
        set: { data: data as Record<string, unknown>, updatedAt: now },
      });
  }

  async getCachedCompanyFullData(companyId: string): Promise<unknown> {
    const row = await this.getCompanyFullCacheRowByCompanyId(companyId);
    if (!row) return undefined;
    const r = row as { data: unknown; updatedAt: string };
    const updatedAt = new Date(r.updatedAt).getTime();
    const maxAge = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - updatedAt > maxAge) return undefined;
    return r.data;
  }

  async getCachedCompanyFullDataByTaxCode(taxCode: string): Promise<unknown> {
    const row = await this.getCompanyFullCacheRowByTaxCode(taxCode);
    if (!row) return undefined;
    const r = row as { data: unknown; updatedAt: string };
    const updatedAt = new Date(r.updatedAt).getTime();
    const maxAge = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - updatedAt > maxAge) return undefined;
    return r.data;
  }

  async setCachedCompanyFullData(companyId: string, taxCode: string, data: unknown): Promise<void> {
    await this.upsertCompanyFullData(companyId, taxCode, data);
  }
}

export class DbSessionStore {
  private cache = new Map<string, number>();

  constructor() {
    getDb()
      .select()
      .from(sessions)
      .then((rows) => {
        this.cache.clear();
        for (const r of rows) this.cache.set(r.token, r.userId);
      })
      .catch((e) => console.error("DbSessionStore load error:", e));
  }

  set(token: string, userId: number): void {
    this.cache.set(token, userId);
    getDb()
      .insert(sessions)
      .values({ token, userId })
      .onConflictDoUpdate({ target: sessions.token, set: { userId } })
      .catch((e) => console.error("Session set error:", e));
  }

  get(token: string): number | undefined {
    return this.cache.get(token);
  }

  delete(token: string): void {
    this.cache.delete(token);
    getDb().delete(sessions).where(eq(sessions.token, token)).catch((e) => console.error("Session delete error:", e));
  }
}

const useSupabase = !!process.env.DATABASE_URL;
export const storage: IStorage = useSupabase ? new SupabaseStorage() : new FileStorage();
export const sessionStore = useSupabase ? new DbSessionStore() : new FileSessionStore();
