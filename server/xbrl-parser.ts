import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";

export const BILANCIO_OTTICO_XBRL_SOURCE = "bilancio-ottico-xbrl-v1";

type ParsedStatus = "ok" | "missing";
type SourcePeriod = "current" | "comparative";

export interface ParsedXbrlPeriod {
  year: string;
  data_chiusura_bilancio: string | null;
  fatturato: number | null;
  ebit: number | null;
  ammortamenti: number | null;
  ebitda: number | null;
  patrimonio_netto: number | null;
  capitale_sociale: number | null;
  costo_personale: number | null;
  totale_attivo: number | null;
  status: ParsedStatus;
  sourcePurchaseYear: string;
  sourcePeriod: SourcePeriod;
}

export interface ParsedBilancioOtticoXbrl {
  source: typeof BILANCIO_OTTICO_XBRL_SOURCE;
  parserVersion: "1";
  documentType: "bilancio-ottico";
  purchaseYear: string;
  parsedFrom: string;
  coveredYears: string[];
  currentYear: string | null;
  comparativeYear: string | null;
  periods: Record<string, ParsedXbrlPeriod>;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  trimValues: true,
});

const REVENUE_TAGS = [
  "ValoreProduzioneRicaviVenditePrestazioni",
  "RicaviDelleVenditeEDellePrestazioni",
  "RicaviVenditePrestazioni",
];

const EBIT_TAGS = [
  "DifferenzaValoreCostiProduzione",
  "DifferenzaTraValoreECostiDellaProduzione",
  "RisultatoOperativo",
  "RisultatoOperativoEBIT",
];

const AMORTIZATION_IMMATERIAL_TAGS = [
  "CostiProduzioneAmmortamentiSvalutazioniAmmortamentoImmobilizzazioniImmateriali",
  "VariazioniEsercizioAmmortamentoEsercizioTotaleImmobilizzazioniImmateriali",
  "AmmortamentoImmobilizzazioniImmateriali",
];

const AMORTIZATION_MATERIAL_TAGS = [
  "CostiProduzioneAmmortamentiSvalutazioniAmmortamentoImmobilizzazioniMateriali",
  "VariazioniEsercizioAmmortamentoEsercizioTotaleImmobilizzazioniMateriali",
  "AmmortamentoImmobilizzazioniMateriali",
];

const TOTAL_ASSETS_TAGS = ["TotaleAttivo"];
const NET_WORTH_TAGS = ["TotalePatrimonioNetto"];
const SHARE_CAPITAL_TAGS = ["DatiAnagraficiCapitaleSociale", "PatrimonioNettoCapitale"];
const STAFF_COST_TAGS = ["CostiProduzionePersonaleTotaleCostiPersonale"];

interface ContextInfo {
  id: string;
  kind: "instant" | "duration";
  endDate: string;
  year: string;
}

interface FactValue {
  localName: string;
  contextRef: string;
  value: number;
}

function stripNamespace(tagName: string): string {
  const clean = String(tagName || "");
  const idx = clean.indexOf(":");
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function normalizeYear(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const match = value.match(/\b(19\d{2}|20\d{2})\b/);
  return match?.[1] ?? null;
}

function normalizeNumber(rawValue: unknown): number | null {
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) return rawValue;
  if (typeof rawValue !== "string") return null;

  const cleaned = rawValue
    .trim()
    .replace(/\s+/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");

  if (!cleaned) return null;
  if (/[^0-9.+-]/.test(cleaned)) return null;
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function looksLikeXml(buffer: Buffer, filename: string, mimeType: string): boolean {
  const normalizedFilename = filename.toLowerCase();
  const normalizedMime = mimeType.toLowerCase();
  if (normalizedFilename.endsWith(".xbrl") || normalizedFilename.endsWith(".xml")) return true;
  if (normalizedMime.includes("xml")) return true;
  if (!normalizedFilename && normalizedMime === "application/octet-stream") {
    const sample = buffer.subarray(0, 64).toString("utf8").trim();
    return sample.startsWith("<?xml") || sample.startsWith("<xbrl");
  }
  return false;
}

function looksLikeJson(filename: string, mimeType: string): boolean {
  const normalizedFilename = filename.toLowerCase();
  const normalizedMime = mimeType.toLowerCase();
  return normalizedFilename.endsWith(".json") || normalizedMime.includes("json");
}

function buildContextIndex(rawContexts: unknown): Map<string, ContextInfo> {
  const contexts = new Map<string, ContextInfo>();

  for (const item of toArray<any>(rawContexts)) {
    const id = typeof item?.id === "string" ? item.id : "";
    if (!id) continue;

    const period = item?.period;
    const instant = typeof period?.instant === "string" ? period.instant : "";
    const endDate = typeof period?.endDate === "string" ? period.endDate : "";
    const year = normalizeYear(endDate || instant);
    if (!year) continue;

    const kind = instant ? "instant" : "duration";
    contexts.set(id, {
      id,
      kind,
      endDate: (endDate || instant).slice(0, 10),
      year,
    });
  }

  return contexts;
}

function buildFactsIndex(root: Record<string, unknown>): Map<string, FactValue[]> {
  const index = new Map<string, FactValue[]>();

  for (const [tagName, rawValue] of Object.entries(root)) {
    if (tagName === "context" || tagName === "unit" || tagName === "link:schemaRef") continue;

    const localName = stripNamespace(tagName).toLowerCase();
    for (const item of toArray<any>(rawValue)) {
      if (!item || typeof item !== "object") continue;
      const contextRef = typeof item.contextRef === "string" ? item.contextRef : "";
      const parsedValue = normalizeNumber(item["#text"]);
      if (!contextRef || parsedValue == null) continue;

      const current = index.get(localName) || [];
      current.push({ localName, contextRef, value: parsedValue });
      index.set(localName, current);
    }
  }

  return index;
}

function getContextIdsByYear(contexts: Map<string, ContextInfo>, kind: "instant" | "duration", year: string): Set<string> {
  const ids = new Set<string>();
  for (const ctx of Array.from(contexts.values())) {
    if (ctx.kind === kind && ctx.year === year) {
      ids.add(ctx.id);
    }
  }
  return ids;
}

function findFactValue(index: Map<string, FactValue[]>, candidateTags: string[], contextIds: Set<string>): number | null {
  for (const tag of candidateTags) {
    const entries = index.get(tag.toLowerCase()) || [];
    for (const entry of entries) {
      if (contextIds.has(entry.contextRef)) {
        return entry.value;
      }
    }
  }
  return null;
}

function buildPeriod(
  year: string,
  sourcePurchaseYear: string,
  sourcePeriod: SourcePeriod,
  contexts: Map<string, ContextInfo>,
  facts: Map<string, FactValue[]>,
): ParsedXbrlPeriod {
  const durationContexts = getContextIdsByYear(contexts, "duration", year);
  const instantContexts = getContextIdsByYear(contexts, "instant", year);
  const durationContext = Array.from(durationContexts.values())[0];
  const instantContext = Array.from(instantContexts.values())[0];

  const fatturato = findFactValue(facts, REVENUE_TAGS, durationContexts);
  const ebit = findFactValue(facts, EBIT_TAGS, durationContexts);
  const ammortamentiImmateriali = findFactValue(facts, AMORTIZATION_IMMATERIAL_TAGS, durationContexts);
  const ammortamentiMateriali = findFactValue(facts, AMORTIZATION_MATERIAL_TAGS, durationContexts);

  const ammortamenti =
    ammortamentiImmateriali == null && ammortamentiMateriali == null
      ? null
      : (ammortamentiImmateriali ?? 0) + (ammortamentiMateriali ?? 0);

  const ebitda = ebit != null && ammortamenti != null ? ebit + ammortamenti : null;

  return {
    year,
    data_chiusura_bilancio: durationContext
      ? contexts.get(durationContext)?.endDate || null
      : instantContext
        ? contexts.get(instantContext)?.endDate || null
        : null,
    fatturato,
    ebit,
    ammortamenti,
    ebitda,
    patrimonio_netto: findFactValue(facts, NET_WORTH_TAGS, instantContexts),
    capitale_sociale: findFactValue(facts, SHARE_CAPITAL_TAGS, instantContexts),
    costo_personale: findFactValue(facts, STAFF_COST_TAGS, durationContexts),
    totale_attivo: findFactValue(facts, TOTAL_ASSETS_TAGS, instantContexts),
    status: fatturato != null && ebitda != null ? "ok" : "missing",
    sourcePurchaseYear,
    sourcePeriod,
  };
}

function parseXbrlXml(xmlContent: string, purchaseYear: string, filename: string): ParsedBilancioOtticoXbrl | null {
  const parsed = xmlParser.parse(xmlContent);
  const root = parsed?.xbrl;
  if (!root || typeof root !== "object") return null;

  const contexts = buildContextIndex((root as Record<string, unknown>).context);
  const facts = buildFactsIndex(root as Record<string, unknown>);
  const durationYears = Array.from(
    new Set(Array.from(contexts.values()).filter((ctx) => ctx.kind === "duration").map((ctx) => ctx.year)),
  ).sort((a, b) => b.localeCompare(a));

  if (durationYears.length === 0) return null;

  const currentYear = durationYears.includes(purchaseYear) ? purchaseYear : durationYears[0];
  const comparativeYear = String(Number.parseInt(currentYear, 10) - 1);

  const periods: Record<string, ParsedXbrlPeriod> = {
    [currentYear]: buildPeriod(currentYear, purchaseYear, "current", contexts, facts),
  };

  if (durationYears.includes(comparativeYear)) {
    periods[comparativeYear] = buildPeriod(comparativeYear, purchaseYear, "comparative", contexts, facts);
  }

  return {
    source: BILANCIO_OTTICO_XBRL_SOURCE,
    parserVersion: "1",
    documentType: "bilancio-ottico",
    purchaseYear,
    parsedFrom: filename,
    coveredYears: Object.keys(periods).sort(),
    currentYear,
    comparativeYear: periods[comparativeYear] ? comparativeYear : null,
    periods,
  };
}

function parseZipDocument(buffer: Buffer, purchaseYear: string, filename: string): ParsedBilancioOtticoXbrl | any | null {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const entryName = entry.entryName || "";
    const entryBuffer = entry.getData();
    const lowerName = entryName.toLowerCase();
    if (lowerName.endsWith(".json")) {
      try {
        return JSON.parse(entryBuffer.toString("utf8"));
      } catch {
        continue;
      }
    }
    if (lowerName.endsWith(".xbrl") || lowerName.endsWith(".xml")) {
      const parsed = parseXbrlXml(entryBuffer.toString("utf8"), purchaseYear, entryName);
      if (parsed) return parsed;
    }
  }

  return null;
}

export function extractStructuredBilancioData(
  buffer: Buffer,
  mimeType: string,
  filename: string,
  purchaseYear: string,
): ParsedBilancioOtticoXbrl | any | null {
  if (looksLikeJson(filename, mimeType)) {
    try {
      return JSON.parse(buffer.toString("utf8"));
    } catch {
      return null;
    }
  }

  if (filename.toLowerCase().endsWith(".zip") || mimeType.toLowerCase() === "application/zip") {
    return parseZipDocument(buffer, purchaseYear, filename);
  }

  if (looksLikeXml(buffer, filename, mimeType)) {
    return parseXbrlXml(buffer.toString("utf8"), purchaseYear, filename);
  }

  return null;
}
