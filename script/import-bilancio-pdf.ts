import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { and, eq } from "drizzle-orm";
import { companyFullCache } from "@shared/schema";
import { persistBilancioDocument } from "../server/bilancio-files";
import { getDb } from "../server/db";
import { storage } from "../server/storage";

const DEFAULT_SOURCE = "bilancio-ottico-pdf-v1";

function inferMimeType(filePath: string): string {
  const normalized = filePath.toLowerCase();
  if (normalized.endsWith(".pdf")) return "application/pdf";
  if (normalized.endsWith(".json")) return "application/json";
  if (normalized.endsWith(".xml") || normalized.endsWith(".xbrl")) return "application/xml";
  if (normalized.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}

async function main() {
  const [companyId, taxCode, year, filePath, source = DEFAULT_SOURCE] = process.argv.slice(2);

  if (!companyId || !taxCode || !year || !filePath) {
    throw new Error(
      "Usage: tsx script/import-bilancio-pdf.ts <companyId> <taxCode> <year> <filePath> [source]",
    );
  }

  const absoluteFilePath = path.resolve(filePath);
  const buffer = await fs.readFile(absoluteFilePath);
  const originalName = path.basename(absoluteFilePath);

  const storedDocument = await persistBilancioDocument(
    companyId,
    year,
    0,
    { fileName: originalName, originalName, name: originalName },
    buffer,
    inferMimeType(absoluteFilePath),
  );

  const bilancioData = {
    source,
    purchaseYear: year,
    documentType: "bilancio-ottico",
    structuredData: null,
    coveredYears: [],
    parsedFrom: null,
    importedManually: true,
  };

  await storage.cachePurchasedBilancio(
    companyId,
    taxCode,
    year,
    [{ ...storedDocument }],
    bilancioData,
  );

  await getDb()
    .delete(companyFullCache)
    .where(and(eq(companyFullCache.companyId, companyId), eq(companyFullCache.taxCode, taxCode)));

  console.log(
    JSON.stringify(
      {
        ok: true,
        companyId,
        taxCode,
        year,
        source,
        storageBackend: storedDocument.storageBackend || "local",
        storageKey: storedDocument.storageKey,
        bucket: storedDocument.bucket || null,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
