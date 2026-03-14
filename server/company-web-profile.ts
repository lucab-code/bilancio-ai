type CompanyWebSource = {
  title: string;
  url: string;
};

export type CompanyKeyProduct = {
  name: string;
  tagline: string | null;
  imageUrl: string | null;
  pageUrl: string | null;
};

export type OfficialWebsiteProfile = {
  officialSiteUrl: string | null;
  homepageTitle: string | null;
  homepageDescription: string | null;
  homepageSummary: string | null;
  productCandidates: CompanyKeyProduct[];
};

const LEGAL_FORM_TOKENS = new Set([
  "spa",
  "srl",
  "srls",
  "sas",
  "snc",
  "sap",
  "sapa",
  "scarl",
  "coop",
  "cooperativa",
  "societa",
  "societa",
]);

const BLOCKED_HOSTS = [
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "x.com",
  "twitter.com",
  "wikipedia.org",
  "bloomberg.com",
  "reuters.com",
  "crunchbase.com",
  "glassdoor.com",
  "indeed.com",
  "kompass.com",
  "icribis.com",
  "dnb.com",
  "rocketreach.co",
  "paginebianche.it",
  "paginegialle.it",
  "visureitalia.com",
];

const PRODUCT_HINTS = [
  "product",
  "products",
  "prodotto",
  "prodotti",
  "solution",
  "solutions",
  "service",
  "services",
  "servizi",
  "industrial",
  "industriale",
  "domestic",
  "domestico",
  "plant",
  "plants",
  "impianti",
  "osmosi",
  "filtrazione",
  "filtration",
  "addolcimento",
  "softener",
  "dosaggio",
  "dosing",
  "legionella",
  "reverse",
  "uv",
];

const EXCLUDED_PATH_HINTS = [
  "contact",
  "contatti",
  "privacy",
  "cookie",
  "career",
  "lavora",
  "news",
  "blog",
  "press",
  "stampa",
  "company",
  "azienda",
  "about",
  "assistenza",
  "academy",
  "acquademy",
  "legislazioni",
];

const WEB_FETCH_TIMEOUT_MS = 8000;

function normalizeCompanyText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;|&#8211;/gi, "-")
    .replace(/&mdash;|&#8212;/gi, "-")
    .replace(/&rsquo;|&#8217;/gi, "'")
    .replace(/&lsquo;|&#8216;/gi, "'")
    .replace(/&ldquo;|&#8220;/gi, "\"")
    .replace(/&rdquo;|&#8221;/gi, "\"")
    .replace(/&hellip;|&#8230;/gi, "...")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/p>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTitle(value: string | null): string | null {
  if (!value) return null;
  const cleaned = stripHtml(value)
    .replace(/\s+\|\s+.+$/g, "")
    .replace(/\s+-\s+[^-]{2,40}$/g, "")
    .trim();
  return cleaned || null;
}

function shortenTagline(value: string | null): string | null {
  if (!value) return null;
  const words = stripHtml(value)
    .split(" ")
    .filter(Boolean)
    .slice(0, 9);
  if (words.length === 0) return null;
  return words.join(" ");
}

function hostWithoutWww(hostname: string): string {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

function isBlockedHost(hostname: string): boolean {
  const host = hostWithoutWww(hostname);
  return BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

function toAbsoluteUrl(url: string, baseUrl?: string): string | null {
  try {
    const resolved = baseUrl ? new URL(url, baseUrl) : new URL(url);
    if (!/^https?:$/i.test(resolved.protocol)) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

function normalizeComparableUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

function getCompanyTokens(companyName: string): string[] {
  return normalizeCompanyText(companyName)
    .split(" ")
    .filter((token) => token.length >= 3 && !LEGAL_FORM_TOKENS.has(token));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMetaContent(html: string, key: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=(["'])${escapeRegExp(key)}\\1[^>]+content=(["'])([\\s\\S]*?)\\2[^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=(["'])([\\s\\S]*?)\\1[^>]+(?:property|name)=(["'])${escapeRegExp(key)}\\3[^>]*>`, "i"),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    const value = match?.[3] || match?.[2];
    if (value) {
      const cleaned = stripHtml(value);
      if (cleaned) return cleaned;
    }
  }

  return null;
}

function extractCanonicalUrl(html: string, pageUrl: string): string {
  const match = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["'][^>]*>/i);
  const candidate = match?.[1] ? toAbsoluteUrl(match[1], pageUrl) : null;
  return candidate || pageUrl;
}

function extractTitle(html: string): string | null {
  const ogTitle = extractMetaContent(html, "og:title") || extractMetaContent(html, "twitter:title");
  if (ogTitle) return cleanTitle(ogTitle);

  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return cleanTitle(match?.[1] ? stripHtml(match[1]) : null);
}

function extractFirstParagraph(html: string): string | null {
  const matches = Array.from(html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi));
  for (const match of matches) {
    const text = stripHtml(match[1] || "");
    if (text.length >= 45) return text;
  }
  return null;
}

function isMeaningfulImageUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (!/\.(jpg|jpeg|png|webp|avif)(\?|$)/i.test(lower)) return false;
  if (lower.includes("logo") || lower.includes("icon") || lower.includes("favicon") || lower.includes("sprite")) {
    return false;
  }
  return true;
}

function extractImageCandidates(html: string, pageUrl: string): string[] {
  const urls = new Set<string>();
  const metaImageKeys = ["og:image", "twitter:image"];

  for (const key of metaImageKeys) {
    const value = extractMetaContent(html, key);
    if (!value) continue;
    const absolute = toAbsoluteUrl(value, pageUrl);
    if (absolute) urls.add(absolute);
  }

  for (const match of Array.from(html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi))) {
    const absolute = toAbsoluteUrl(match[1], pageUrl);
    if (absolute) urls.add(absolute);
  }

  return Array.from(urls).filter(isMeaningfulImageUrl);
}

function scoreProductLink(url: string, label: string): number {
  const lowerUrl = url.toLowerCase();
  const lowerLabel = label.toLowerCase();
  let score = 0;

  for (const hint of PRODUCT_HINTS) {
    if (lowerUrl.includes(hint)) score += 3;
    if (lowerLabel.includes(hint)) score += 2;
  }

  for (const hint of EXCLUDED_PATH_HINTS) {
    if (lowerUrl.includes(hint)) score -= 4;
  }

  if (/[?&]categoria=/.test(lowerUrl)) score += 3;
  if (lowerUrl.includes("/prodotti/") || lowerUrl.includes("/products/")) score += 4;
  if (lowerUrl.includes("/industrial/") || lowerUrl.includes("/domestic/") || lowerUrl.includes("/domestico/")) score += 2;
  if (label.length >= 4 && label.length <= 50) score += 1;

  return score;
}

function extractProductLinks(html: string, homepageUrl: string): Array<{ url: string; label: string }> {
  const homepage = new URL(homepageUrl);
  const candidates = new Map<string, { url: string; label: string; score: number }>();

  for (const match of Array.from(html.matchAll(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi))) {
    const rawHref = match[2];
    const rawLabel = stripHtml(match[3] || "");
    if (!rawHref || !rawLabel) continue;

    const absoluteUrl = toAbsoluteUrl(rawHref, homepageUrl);
    if (!absoluteUrl) continue;

    try {
      const parsed = new URL(absoluteUrl);
      if (hostWithoutWww(parsed.hostname) !== hostWithoutWww(homepage.hostname)) continue;
      if (parsed.hash) parsed.hash = "";
      if (!/^https?:$/i.test(parsed.protocol)) continue;
    } catch {
      continue;
    }

    const normalized = normalizeComparableUrl(absoluteUrl);
    if (normalized === normalizeComparableUrl(homepageUrl)) continue;

    const score = scoreProductLink(normalized, rawLabel);
    if (score <= 0) continue;

    const existing = candidates.get(normalized);
    if (!existing || score > existing.score) {
      candidates.set(normalized, {
        url: normalized,
        label: rawLabel,
        score,
      });
    }
  }

  return Array.from(candidates.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ url, label }) => ({ url, label }));
}

async function fetchHtmlDocument(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; BilancioAI/1.0; +https://bilancio.ai)",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    if (contentType && !contentType.includes("html") && !contentType.includes("xml")) {
      return null;
    }

    const text = await res.text();
    return text.trim() ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonDocument<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; BilancioAI/1.0; +https://bilancio.ai)",
        accept: "application/json,text/plain,*/*",
      },
    });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWordPressAttachmentImage(pageUrl: string): Promise<string | null> {
  try {
    const parsedUrl = new URL(pageUrl);
    const slug = parsedUrl.pathname.split("/").filter(Boolean).pop();
    if (!slug) return null;

    const pagesBySlugUrl = `${parsedUrl.origin}/wp-json/wp/v2/pages?slug=${encodeURIComponent(slug)}&per_page=20`;
    const pagesBySearchUrl = `${parsedUrl.origin}/wp-json/wp/v2/pages?search=${encodeURIComponent(slug)}&per_page=20`;
    const pages = await fetchJsonDocument<any[]>(pagesBySlugUrl)
      || await fetchJsonDocument<any[]>(pagesBySearchUrl);
    if (!Array.isArray(pages) || pages.length === 0) return null;

    const normalizedTarget = normalizeComparableUrl(pageUrl);
    const matchedPage = pages.find((page) => {
      const link = typeof page?.link === "string" ? normalizeComparableUrl(page.link) : "";
      return link === normalizedTarget;
    }) || pages[0];

    const attachmentHref = Array.isArray(matchedPage?._links?.["wp:attachment"])
      ? matchedPage._links["wp:attachment"][0]?.href
      : null;
    if (typeof attachmentHref !== "string" || !attachmentHref.trim()) return null;

    const media = await fetchJsonDocument<any[]>(attachmentHref);
    if (!Array.isArray(media) || media.length === 0) return null;

    for (const item of media) {
      if (item?.media_type !== "image") continue;
      const urls = [
        item?.media_details?.sizes?.large?.source_url,
        item?.media_details?.sizes?.medium_large?.source_url,
        item?.media_details?.sizes?.medium?.source_url,
        item?.source_url,
      ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));

      const selected = urls.find(isMeaningfulImageUrl);
      if (selected) return selected;
    }
  } catch {
    return null;
  }

  return null;
}

async function buildProductCandidate(pageUrl: string, label: string): Promise<CompanyKeyProduct | null> {
  const html = await fetchHtmlDocument(pageUrl);
  if (!html) return null;

  const canonicalUrl = extractCanonicalUrl(html, pageUrl);
  const title = cleanTitle(extractTitle(html) || label) || label;
  const description = extractMetaContent(html, "description")
    || extractMetaContent(html, "og:description")
    || extractFirstParagraph(html);

  const wpImage = await fetchWordPressAttachmentImage(canonicalUrl);
  const imageCandidates = extractImageCandidates(html, canonicalUrl);
  const imageUrl = wpImage || imageCandidates[0] || null;

  return {
    name: title,
    tagline: shortenTagline(description),
    imageUrl,
    pageUrl: canonicalUrl,
  };
}

function dedupeSources(sources: CompanyWebSource[]): CompanyWebSource[] {
  const deduped = new Map<string, CompanyWebSource>();

  for (const source of sources) {
    const url = typeof source?.url === "string" ? source.url.trim() : "";
    if (!url) continue;

    deduped.set(url, {
      title: typeof source?.title === "string" && source.title.trim() ? source.title.trim() : url,
      url,
    });
  }

  return Array.from(deduped.values());
}

export function pickOfficialWebsiteUrl(
  sources: CompanyWebSource[],
  companyName: string,
): string | null {
  const companyTokens = getCompanyTokens(companyName);
  const scored = dedupeSources(sources)
    .map((source) => {
      try {
        const parsed = new URL(source.url);
        const host = hostWithoutWww(parsed.hostname);
        if (isBlockedHost(host)) return null;

        let score = 0;
        if (host.endsWith(".it")) score += 2;
        if (parsed.pathname === "/" || /^\/[a-z]{2}\/?$/.test(parsed.pathname)) score += 2;
        if (parsed.pathname.includes("/products/") || parsed.pathname.includes("/prodotti/")) score += 1;

        for (const token of companyTokens) {
          if (host.includes(token)) score += 4;
          if (normalizeCompanyText(source.title).includes(token)) score += 1;
        }

        return { url: `${parsed.origin}${parsed.pathname}`, score };
      } catch {
        return null;
      }
    })
    .filter((item): item is { url: string; score: number } => Boolean(item))
    .sort((a, b) => b.score - a.score);

  return scored[0]?.url || null;
}

export async function buildOfficialWebsiteProfile(officialSiteUrl: string): Promise<OfficialWebsiteProfile> {
  const html = await fetchHtmlDocument(officialSiteUrl);
  if (!html) {
    return {
      officialSiteUrl,
      homepageTitle: null,
      homepageDescription: null,
      homepageSummary: null,
      productCandidates: [],
    };
  }

  const canonicalUrl = extractCanonicalUrl(html, officialSiteUrl);
  const homepageTitle = extractTitle(html);
  const homepageDescription = extractMetaContent(html, "description") || extractMetaContent(html, "og:description");
  const homepageSummary = extractFirstParagraph(html) || homepageDescription;
  const productLinks = extractProductLinks(html, canonicalUrl);

  const productCandidates = (await Promise.all(productLinks.map((link) => buildProductCandidate(link.url, link.label))))
    .filter((item): item is CompanyKeyProduct => Boolean(item))
    .reduce((acc, item) => {
      const key = normalizeComparableUrl(item.pageUrl || item.name);
      if (!acc.has(key)) acc.set(key, item);
      return acc;
    }, new Map<string, CompanyKeyProduct>());

  return {
    officialSiteUrl: canonicalUrl,
    homepageTitle,
    homepageDescription,
    homepageSummary,
    productCandidates: Array.from(productCandidates.values())
      .sort((a, b) => Number(Boolean(b.imageUrl)) - Number(Boolean(a.imageUrl)))
      .slice(0, 6),
  };
}

export async function inferOfficialWebsiteUrl(companyName: string): Promise<string | null> {
  const tokens = getCompanyTokens(companyName).slice(0, 3);
  const primaryToken = tokens[0];
  if (!primaryToken) return null;

  const candidateUrls = [
    `https://www.${primaryToken}.it/`,
    `https://${primaryToken}.it/`,
    `https://www.${primaryToken}.com/`,
    `https://${primaryToken}.com/`,
  ];

  for (const candidateUrl of candidateUrls) {
    const html = await fetchHtmlDocument(candidateUrl);
    if (!html) continue;

    const title = normalizeCompanyText(extractTitle(html) || "");
    const description = normalizeCompanyText(extractMetaContent(html, "description") || extractMetaContent(html, "og:description") || "");
    const matchesToken = tokens.some((token) => title.includes(token) || description.includes(token));
    if (!matchesToken) continue;

    return extractCanonicalUrl(html, candidateUrl);
  }

  return null;
}
