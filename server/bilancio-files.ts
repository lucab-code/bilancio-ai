import fs from "fs/promises";
import path from "path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface StoredBilancioDocument {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  originalName?: string | null;
  storageBackend?: "local" | "supabase";
  bucket?: string | null;
}

const PURCHASED_BILANCI_DIR = path.join(process.cwd(), ".data", "purchased-bilanci");
const USER_UPLOADED_BILANCI_DIR = path.join(process.cwd(), ".data", "user-uploaded-bilanci");
const DEFAULT_SUPABASE_BILANCI_BUCKET = process.env.SUPABASE_BILANCI_BUCKET || "purchased-bilanci";
const DEFAULT_SUPABASE_PRIVATE_BILANCI_BUCKET = process.env.SUPABASE_PRIVATE_BILANCI_BUCKET || "private-bilanci";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

let supabaseStorageClient: SupabaseClient | null | undefined;
let ensureBucketPromise: Promise<string | null> | null = null;
let ensurePrivateBucketPromise: Promise<string | null> | null = null;

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function inferExtension(mimeType: string, filename: string): string {
  const existing = path.extname(filename);
  if (existing) return existing;
  if (mimeType === "application/pdf") return ".pdf";
  if (mimeType === "application/json" || mimeType === "text/json") return ".json";
  if (mimeType === "application/zip") return ".zip";
  return ".bin";
}

export function resolveBilancioDocumentPath(storageKey: string): string {
  return path.join(PURCHASED_BILANCI_DIR, storageKey);
}

export function resolvePrivateBilancioDocumentPath(storageKey: string): string {
  return path.join(USER_UPLOADED_BILANCI_DIR, storageKey);
}

function getSupabaseStorageClient(): SupabaseClient | null {
  if (supabaseStorageClient !== undefined) {
    return supabaseStorageClient;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    supabaseStorageClient = null;
    return supabaseStorageClient;
  }

  supabaseStorageClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supabaseStorageClient;
}

function getBilancioStorageBucket(document?: { bucket?: string | null }): string {
  return (typeof document?.bucket === "string" && document.bucket.trim()) || DEFAULT_SUPABASE_BILANCI_BUCKET;
}

function getPrivateBilancioStorageBucket(document?: { bucket?: string | null }): string {
  return (typeof document?.bucket === "string" && document.bucket.trim()) || DEFAULT_SUPABASE_PRIVATE_BILANCI_BUCKET;
}

async function ensureSupabaseBilanciBucket(): Promise<string | null> {
  const supabase = getSupabaseStorageClient();
  if (!supabase) return null;

  if (!ensureBucketPromise) {
    ensureBucketPromise = (async () => {
      const bucket = getBilancioStorageBucket();
      const { data: existing, error: existingError } = await supabase.storage.getBucket(bucket);

      if (existingError && !/not found/i.test(existingError.message)) {
        throw new Error(`Supabase storage getBucket failed: ${existingError.message}`);
      }

      if (!existing) {
        const { error: createError } = await supabase.storage.createBucket(bucket, {
          public: false,
          fileSizeLimit: "50MB",
        });

        if (createError && !/already exists/i.test(createError.message)) {
          throw new Error(`Supabase storage createBucket failed: ${createError.message}`);
        }
      }

      return bucket;
    })().catch((error) => {
      ensureBucketPromise = null;
      throw error;
    });
  }

  return ensureBucketPromise;
}

async function ensureSupabasePrivateBilanciBucket(): Promise<string | null> {
  const supabase = getSupabaseStorageClient();
  if (!supabase) return null;

  if (!ensurePrivateBucketPromise) {
    ensurePrivateBucketPromise = (async () => {
      const bucket = getPrivateBilancioStorageBucket();
      const { data: existing, error: existingError } = await supabase.storage.getBucket(bucket);

      if (existingError && !/not found/i.test(existingError.message)) {
        throw new Error(`Supabase storage getBucket failed: ${existingError.message}`);
      }

      if (!existing) {
        const { error: createError } = await supabase.storage.createBucket(bucket, {
          public: false,
          fileSizeLimit: "50MB",
        });

        if (createError && !/already exists/i.test(createError.message)) {
          throw new Error(`Supabase storage createBucket failed: ${createError.message}`);
        }
      }

      return bucket;
    })().catch((error) => {
      ensurePrivateBucketPromise = null;
      throw error;
    });
  }

  return ensurePrivateBucketPromise;
}

export function isStoredPdfDocument(document: any): boolean {
  const mimeType = typeof document?.mimeType === "string" ? document.mimeType.toLowerCase() : "";
  const filename = typeof document?.filename === "string" ? document.filename.toLowerCase() : "";
  return mimeType.includes("pdf") || filename.endsWith(".pdf");
}

export function isStoredInlineBilancioDocument(document: any): boolean {
  const mimeType = typeof document?.mimeType === "string" ? document.mimeType.toLowerCase() : "";
  const filename = typeof document?.filename === "string"
    ? document.filename.toLowerCase()
    : typeof document?.originalName === "string"
      ? document.originalName.toLowerCase()
      : "";

  return (
    isStoredPdfDocument(document) ||
    mimeType.includes("json") ||
    mimeType.includes("xml") ||
    filename.endsWith(".json") ||
    filename.endsWith(".xml") ||
    filename.endsWith(".xbrl")
  );
}

export async function readStoredBilancioDocument(document: { storageKey?: string; storageBackend?: string; bucket?: string | null }): Promise<Buffer> {
  const storageKey = typeof document?.storageKey === "string" ? document.storageKey : "";
  if (!storageKey) {
    throw new Error("Bilancio document storageKey mancante");
  }

  const useSupabase =
    document?.storageBackend === "supabase" ||
    (typeof document?.bucket === "string" && document.bucket.trim().length > 0);

  if (!useSupabase) {
    try {
      return await fs.readFile(resolveBilancioDocumentPath(storageKey));
    } catch {
      return fs.readFile(resolvePrivateBilancioDocumentPath(storageKey));
    }
  }

  const supabase = getSupabaseStorageClient();
  if (!supabase) {
    throw new Error("Supabase Storage non configurato per il documento richiesto");
  }

  const bucket = getBilancioStorageBucket(document);
  const { data, error } = await supabase.storage.from(bucket).download(storageKey);
  if (error || !data) {
    throw new Error(`Supabase storage download failed: ${error?.message || "documento non disponibile"}`);
  }

  return Buffer.from(await data.arrayBuffer());
}

export async function persistBilancioDocument(
  companyId: string,
  year: string,
  index: number,
  sourceDocument: any,
  buffer: Buffer,
  mimeType: string,
): Promise<StoredBilancioDocument> {
  const safeCompanyId = sanitizeSegment(companyId);
  const safeYear = sanitizeSegment(year);
  const originalName =
    (typeof sourceDocument?.fileName === "string" && sourceDocument.fileName) ||
    (typeof sourceDocument?.filename === "string" && sourceDocument.filename) ||
    (typeof sourceDocument?.name === "string" && sourceDocument.name) ||
    `document-${index + 1}`;

  const extension = inferExtension(mimeType, originalName);
  const safeFilename = sanitizeSegment(path.basename(originalName, path.extname(originalName))) + extension;
  const storageKey = path.join(safeCompanyId, safeYear, `${String(index + 1).padStart(2, "0")}-${safeFilename}`);
  const supabaseBucket = await ensureSupabaseBilanciBucket();

  if (supabaseBucket) {
    const supabase = getSupabaseStorageClient();
    if (!supabase) {
      throw new Error("Supabase Storage non disponibile");
    }

    const { error } = await supabase.storage.from(supabaseBucket).upload(storageKey, buffer, {
      upsert: true,
      contentType: mimeType || "application/octet-stream",
    });

    if (error) {
      throw new Error(`Supabase storage upload failed: ${error.message}`);
    }

    return {
      filename: path.basename(storageKey),
      mimeType: mimeType || "application/octet-stream",
      sizeBytes: buffer.byteLength,
      storageKey,
      originalName,
      storageBackend: "supabase",
      bucket: supabaseBucket,
    };
  }

  const fullPath = resolveBilancioDocumentPath(storageKey);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buffer);

  return {
    filename: path.basename(fullPath),
    mimeType: mimeType || "application/octet-stream",
    sizeBytes: buffer.byteLength,
    storageKey,
    originalName,
    storageBackend: "local",
    bucket: null,
  };
}

export async function persistPrivateBilancioDocument(
  userId: number,
  companyId: string,
  year: string,
  index: number,
  sourceDocument: any,
  buffer: Buffer,
  mimeType: string,
): Promise<StoredBilancioDocument> {
  const safeUserId = sanitizeSegment(String(userId));
  const safeCompanyId = sanitizeSegment(companyId);
  const safeYear = sanitizeSegment(year);
  const originalName =
    (typeof sourceDocument?.fileName === "string" && sourceDocument.fileName) ||
    (typeof sourceDocument?.filename === "string" && sourceDocument.filename) ||
    (typeof sourceDocument?.name === "string" && sourceDocument.name) ||
    `document-${index + 1}`;

  const extension = inferExtension(mimeType, originalName);
  const safeFilename = sanitizeSegment(path.basename(originalName, path.extname(originalName))) + extension;
  const storageKey = path.join(safeUserId, safeCompanyId, safeYear, `${String(index + 1).padStart(2, "0")}-${safeFilename}`);
  const supabaseBucket = await ensureSupabasePrivateBilanciBucket();

  if (supabaseBucket) {
    const supabase = getSupabaseStorageClient();
    if (!supabase) {
      throw new Error("Supabase Storage non disponibile");
    }

    const { error } = await supabase.storage.from(supabaseBucket).upload(storageKey, buffer, {
      upsert: true,
      contentType: mimeType || "application/octet-stream",
    });

    if (error) {
      throw new Error(`Supabase storage upload failed: ${error.message}`);
    }

    return {
      filename: path.basename(storageKey),
      mimeType: mimeType || "application/octet-stream",
      sizeBytes: buffer.byteLength,
      storageKey,
      originalName,
      storageBackend: "supabase",
      bucket: supabaseBucket,
    };
  }

  const fullPath = resolvePrivateBilancioDocumentPath(storageKey);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buffer);

  return {
    filename: path.basename(fullPath),
    mimeType: mimeType || "application/octet-stream",
    sizeBytes: buffer.byteLength,
    storageKey,
    originalName,
    storageBackend: "local",
    bucket: null,
  };
}

export async function deleteStoredBilancioDocument(document: { storageKey?: string; storageBackend?: string; bucket?: string | null }): Promise<void> {
  const storageKey = typeof document?.storageKey === "string" ? document.storageKey : "";
  if (!storageKey) return;

  const useSupabase =
    document?.storageBackend === "supabase" ||
    (typeof document?.bucket === "string" && document.bucket.trim().length > 0);

  if (useSupabase) {
    const supabase = getSupabaseStorageClient();
    if (!supabase) return;
    const bucket = typeof document?.bucket === "string" && document.bucket.trim()
      ? document.bucket.trim()
      : getBilancioStorageBucket(document);
    await supabase.storage.from(bucket).remove([storageKey]);
    return;
  }

  await fs.rm(resolveBilancioDocumentPath(storageKey), { force: true }).catch(() => undefined);
  await fs.rm(resolvePrivateBilancioDocumentPath(storageKey), { force: true }).catch(() => undefined);
}
