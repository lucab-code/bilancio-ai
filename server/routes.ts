import type { Express, Request, Response } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import {
  getOpenaiApiKey,
  getOpenaiChatModel,
  getAuthHeaders,
} from "./config";
import { getOrCreateUserFromSupabaseToken, isSupabaseAuthConfigured } from "./supabase-auth";

const COMPANY_BASE = "https://company.openapi.com";
const DOCUENGINE_BASE = "https://docuengine.openapi.com";

// In-memory search result cache (TTL: 10 min)
const searchCache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 10 * 60 * 1000;

/** Restituisce il nostro user id se il Bearer token è un Supabase access_token valido. */
async function getUserIdFromReq(req: Request): Promise<number | null> {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const user = await getOrCreateUserFromSupabaseToken(token);
  return user?.id ?? null;
}

// Fetch with retry
async function fetchWithRetry(url: string, opts: RequestInit, retries = 2): Promise<globalThis.Response> {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok || i === retries) return res;
    } catch (e) {
      if (i === retries) throw e;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("Fetch failed after retries");
}

export function registerRoutes(server: Server, app: Express): void {

  // ==========================================
  // AUTH — Supabase Auth (email + Google)
  // ==========================================
  app.get("/api/auth/config", (_req: Request, res: Response) => {
    return res.json({
      useSupabaseAuth: isSupabaseAuthConfigured(),
      allowRegistration: true,
      hasGoogle: true,
    });
  });

  app.get("/api/auth/me", async (req: Request, res: Response) => {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Non autenticato" });
    const user = await getOrCreateUserFromSupabaseToken(token);
    if (!user) return res.status(401).json({ error: "Token non valido" });
    return res.json({ user });
  });

  // ==========================================
  // COMPANY SEARCH — SSE streaming, improved
  // ==========================================
  app.get("/api/company/search", async (req: Request, res: Response) => {
    const query = (req.query.q as string || "").trim();
    const mode = req.query.mode as string;

    if (!query || query.length < 2) {
      if (mode === "sse") {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.write(`data: ${JSON.stringify({ done: true, results: [] })}\n\n`);
        return res.end();
      }
      return res.json({ data: [] });
    }

    const queryCacheKey = `query:${query.toLowerCase()}`;
    const queryCached = searchCache.get(queryCacheKey);
    if (queryCached && Date.now() - queryCached.ts < CACHE_TTL) {
      if (mode === "sse") {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        for (const item of queryCached.data) {
          res.write(`data: ${JSON.stringify({ company: item })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        return res.end();
      }
      return res.json({ data: queryCached.data });
    }

    try {
      // IT-search returns IDs
      const searchUrl = `${COMPANY_BASE}/IT-search?companyName=${encodeURIComponent(query)}`;
      const searchRes = await fetchWithRetry(searchUrl, {
        headers: getAuthHeaders(),
        signal: AbortSignal.timeout(12000),
      });

      if (!searchRes.ok) {
        console.error("IT-search error:", searchRes.status);
        if (mode === "sse") {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.write(`data: ${JSON.stringify({ done: true, error: "Errore nella ricerca" })}\n\n`);
          return res.end();
        }
        return res.json({ data: [], error: "Errore nella ricerca" });
      }

      const searchData = await searchRes.json();
      const ids: string[] = (searchData.data || []).slice(0, 8).map((item: any) => item.id);

      if (ids.length === 0) {
        if (mode === "sse") {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.write(`data: ${JSON.stringify({ done: true, results: [] })}\n\n`);
          return res.end();
        }
        return res.json({ data: [] });
      }

      if (mode === "sse") {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");

        const allResults: any[] = [];

        // Process each ID with a generous timeout and retry
        const promises = ids.map(async (id: string) => {
          try {
            const startRes = await fetchWithRetry(`${COMPANY_BASE}/IT-start/${id}`, {
              headers: getAuthHeaders(),
              signal: AbortSignal.timeout(10000),
            }, 1);
            if (!startRes.ok) return;
            const startData = await startRes.json();
            const company = startData.data?.[0];
            if (!company) return;

            const addr = company.address?.registeredOffice;
            const result = {
              id: company.id,
              denominazione: company.companyName || "",
              indirizzo: addr?.streetName || "",
              comune: addr?.town || "",
              provincia: addr?.province || "",
              cap: addr?.zipCode || "",
              piva: company.vatCode || "",
              cf: company.taxCode || "",
              stato_attivita: company.activityStatus || "",
            };
            allResults.push(result);
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ company: result })}\n\n`);
            }
          } catch (e: any) {
            // Skip failed — don't log abort errors
            if (e?.name !== "AbortError") {
              console.error(`IT-start failed for ${id}:`, e?.message);
            }
          }
        });

        await Promise.all(promises);

        if (allResults.length > 0) {
          const now = Date.now();
          searchCache.set(queryCacheKey, { data: allResults, ts: now });
          for (const r of allResults) {
            searchCache.set(`company:${r.id}`, { data: r, ts: now });
          }
        }

        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          res.end();
        }
      } else {
        const enriched = await Promise.all(
          ids.map(async (id: string) => {
            try {
              const startRes = await fetchWithRetry(`${COMPANY_BASE}/IT-start/${id}`, {
                headers: getAuthHeaders(),
                signal: AbortSignal.timeout(10000),
              }, 1);
              if (!startRes.ok) return null;
              const startData = await startRes.json();
              const company = startData.data?.[0];
              if (!company) return null;
              const addr = company.address?.registeredOffice;
              return {
                id: company.id,
                denominazione: company.companyName || "",
                indirizzo: addr?.streetName || "",
                comune: addr?.town || "",
                provincia: addr?.province || "",
                cap: addr?.zipCode || "",
                piva: company.vatCode || "",
                cf: company.taxCode || "",
                stato_attivita: company.activityStatus || "",
              };
            } catch {
              return null;
            }
          })
        );
        const results = enriched.filter(Boolean);
        if (results.length > 0) {
          searchCache.set(queryCacheKey, { data: results, ts: Date.now() });
        }
        return res.json({ data: results });
      }
    } catch (error: any) {
      console.error("Search error:", error);
      if (mode === "sse" && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ done: true, error: "Errore" })}\n\n`);
        return res.end();
      }
      return res.status(500).json({ error: "Errore nel servizio di ricerca" });
    }
  });

  // ==========================================
  // COMPANY DETAILS — IT-advanced/{id}
  // ==========================================
  app.get("/api/company/:id/details", async (req: Request, res: Response) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] ?? "" : req.params.id ?? "";

      const advancedRes = await fetchWithRetry(`${COMPANY_BASE}/IT-advanced/${id}`, {
        headers: getAuthHeaders(),
        signal: AbortSignal.timeout(15000),
      });
      if (!advancedRes.ok) {
        const errText = await advancedRes.text();
        console.error("IT-advanced error:", advancedRes.status, errText);
        return res.status(advancedRes.status).json({ error: "Errore nel recupero dettagli" });
      }

      const advancedData = await advancedRes.json();
      const company = advancedData.data?.[0];
      if (!company) {
        return res.status(404).json({ error: "Azienda non trovata" });
      }

      const addr = company.address?.registeredOffice;
      const ateco = company.atecoClassification;
      const balanceSheets = company.balanceSheets;

      // Build bilanci map
      const bilanci: Record<string, any> = {};
      if (balanceSheets?.all && Array.isArray(balanceSheets.all)) {
        for (const bs of balanceSheets.all) {
          if (bs.year && bs.balanceSheetDate) {
            bilanci[String(bs.year)] = {
              data_chiusura_bilancio: bs.balanceSheetDate,
              fatturato: bs.turnover,
              patrimonio_netto: bs.netWorth,
              capitale_sociale: bs.shareCapital,
              costo_personale: bs.totalStaffCost,
              totale_attivo: bs.totalAssets,
              dipendenti: bs.employees,
              stipendio_medio_lordo: bs.avgGrossSalary,
            };
          }
        }
      }

      // Cache bilancio data
      const taxCode = company.taxCode || "";
      if (Object.keys(bilanci).length > 0 && taxCode) {
        await storage.cacheBilancio(id, taxCode, bilanci);
      }

      return res.json({
        data: {
          id: company.id,
          denominazione: company.companyName,
          codice_fiscale: company.taxCode,
          partita_iva: company.vatCode,
          indirizzo: addr?.streetName || "",
          comune: addr?.town || "",
          provincia: addr?.province || "",
          cap: addr?.zipCode || "",
          stato_attivita: company.activityStatus,
          pec: company.pec || null,
          telefono: company.phoneNumber || company.phone || null,
          forma_giuridica: company.detailedLegalForm?.description || "",
          data_inizio: company.startDate || null,
          data_iscrizione: company.registrationDate || null,
          rea: company.reaCode || null,
          cciaa: company.cciaa || null,
          dettaglio: {
            descrizione_ateco: ateco?.ateco2022?.description || ateco?.ateco2007?.description || ateco?.ateco?.description || "",
            codice_ateco: ateco?.ateco2022?.code || ateco?.ateco2007?.code || ateco?.ateco?.code || "",
            bilanci,
            balanceSheets_raw: balanceSheets,
          },
          shareholders: company.shareHolders || null,
        },
      });
    } catch (error: any) {
      console.error("Details error:", error);
      return res.status(500).json({ error: "Errore nel servizio dettagli" });
    }
  });

  // ==========================================
  // AI EBITDA ESTIMATION from balance sheet data
  // ==========================================
  app.post("/api/company/estimate-ebitda", async (req: Request, res: Response) => {
    try {
      const { companyName, sector, bilanci } = req.body;
      if (!bilanci || Object.keys(bilanci).length === 0) {
        return res.status(400).json({ error: "Nessun dato di bilancio" });
      }

      const prompt = `Sei un analista finanziario esperto in bilanci italiani. Ti fornisco i dati disponibili dalla Camera di Commercio per l'azienda "${companyName}"${sector ? ` (settore: ${sector})` : ''}.

Dati di bilancio disponibili per anno:
${JSON.stringify(bilanci, null, 2)}

I campi disponibili sono: fatturato (turnover/ricavi), patrimonio_netto, capitale_sociale, costo_personale, totale_attivo, dipendenti, stipendio_medio_lordo.

Definizione corretta di EBITDA: EBITDA = Risultato operativo (EBIT) + Ammortamenti e accantonamenti. Equivalente: Ricavi - Costi operativi (esclusi ammortamenti e accantonamenti).

Per ogni anno dove hai il fatturato (ricavi), calcola o stima l'EBITDA in modo coerente:
- Se nei dati hai un risultato operativo o margine operativo, usa quello e stima gli ammortamenti tipici del settore per ottenere EBITDA = EBIT + ammortamenti.
- Se hai solo fatturato e costo_personale: stima gli altri costi operativi (materie prime, servizi, ecc.) e gli ammortamenti in percentuale sul fatturato secondo il settore (manifatturiero di solito 3-8% ammortamenti, servizi 2-5%), poi EBITDA = Fatturato - costi operativi (incluso costo_personale) - non includere ammortamenti nei costi per l'EBITDA.
- Margini EBITDA di riferimento per settore: manifatturiero 8-15%, servizi 15-25%, tech 20-35%, retail 3-8%.
- Se i dati sono insufficienti, indica confidence "low" e method con la spiegazione.

Rispondi SOLO con JSON valido in questa struttura:
{
  "ebitda": {
    "ANNO": {"value": NUMERO, "margin_pct": PERCENTUALE, "confidence": "high|medium|low", "method": "breve spiegazione del calcolo"}
  },
  "revenue": {
    "ANNO": NUMERO
  }
}

Dove ANNO è l'anno (es. "2024"), value è l'EBITDA in euro, margin_pct è il margine EBITDA in percentuale.`;

      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getOpenaiApiKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: getOpenaiChatModel(),
          messages: [
            { role: "system", content: "Sei un analista finanziario. Usa la definizione corretta di EBITDA (EBIT + ammortamenti). Rispondi SOLO con JSON valido, nessun testo aggiuntivo." },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 2000,
          response_format: { type: "json_object" },
        }),
      });

      if (!openaiRes.ok) {
        const errText = await openaiRes.text();
        console.error("OpenAI EBITDA error:", openaiRes.status, errText);
        return res.status(500).json({ error: "Errore nella stima EBITDA" });
      }

      const openaiData = await openaiRes.json();
      const content = openaiData.choices?.[0]?.message?.content;
      if (!content) {
        return res.status(500).json({ error: "Risposta AI vuota" });
      }

      const result = JSON.parse(content);
      return res.json({ data: result });
    } catch (error: any) {
      console.error("EBITDA estimation error:", error);
      return res.status(500).json({ error: "Errore nella stima EBITDA" });
    }
  });

  // ==========================================
  // BILANCIO RICLASSIFICATO - Request via DocuEngine
  // ==========================================
  app.post("/api/bilancio/request", async (req: Request, res: Response) => {
    try {
      const { taxCode, year } = req.body;
      if (!taxCode) {
        return res.status(400).json({ error: "Codice fiscale richiesto" });
      }

      // Check cache first
      const cached = await storage.getCachedBilancioByTaxCode(taxCode);
      if (cached) {
        return res.json({ data: { cached: true, bilanci: cached } });
      }

      const searchPayload: any = {
        documentId: "669533fe6d4f51cbde8da353",
        search: { field0: taxCode },
      };
      if (year) {
        searchPayload.state = "NEW";
      }

      const searchRes = await fetch(`${DOCUENGINE_BASE}/requests`, {
        method: "POST",
        headers: {
          ...getAuthHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(searchPayload),
      });

      if (!searchRes.ok) {
        const errText = await searchRes.text();
        console.error("DocuEngine request error:", searchRes.status, errText);
        return res.status(searchRes.status).json({ error: "Errore nella richiesta bilancio" });
      }

      const searchData = await searchRes.json();
      return res.json(searchData);
    } catch (error: any) {
      console.error("Bilancio request error:", error);
      return res.status(500).json({ error: "Errore nel servizio bilancio" });
    }
  });

  // ==========================================
  // BILANCIO - Select year and process
  // ==========================================
  app.patch("/api/bilancio/:requestId", async (req: Request, res: Response) => {
    try {
      const { requestId } = req.params;
      const { resultId } = req.body;

      const patchRes = await fetch(`${DOCUENGINE_BASE}/requests/${requestId}`, {
        method: "PATCH",
        headers: {
          ...getAuthHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ resultId }),
      });

      if (!patchRes.ok) {
        return res.status(patchRes.status).json({ error: "Errore nella selezione anno bilancio" });
      }

      const data = await patchRes.json();
      return res.json(data);
    } catch (error: any) {
      return res.status(500).json({ error: "Errore nel servizio bilancio" });
    }
  });

  // ==========================================
  // BILANCIO - Check status
  // ==========================================
  app.get("/api/bilancio/:requestId/status", async (req: Request, res: Response) => {
    try {
      const { requestId } = req.params;

      const statusRes = await fetch(`${DOCUENGINE_BASE}/requests/${requestId}`, {
        headers: getAuthHeaders(),
      });

      if (!statusRes.ok) {
        return res.status(statusRes.status).json({ error: "Errore nel controllo stato" });
      }

      const data = await statusRes.json();
      return res.json(data);
    } catch (error: any) {
      return res.status(500).json({ error: "Errore nel controllo stato" });
    }
  });

  // ==========================================
  // BILANCIO - Download documents
  // Scarichiamo 1 solo bilancio riclassificato (anno più recente scelto dal client).
  // I dati sintetici multi-anno (fatturato, patrimonio_netto, ecc.) arrivano da IT-advanced, non da download.
  // ==========================================
  app.get("/api/bilancio/:requestId/documents", async (req: Request, res: Response) => {
    try {
      const { requestId } = req.params;

      const docRes = await fetch(`${DOCUENGINE_BASE}/requests/${requestId}/documents`, {
        headers: getAuthHeaders(),
      });

      if (!docRes.ok) {
        return res.status(docRes.status).json({ error: "Errore nel download documenti" });
      }

      const data = await docRes.json();
      return res.json(data);
    } catch (error: any) {
      return res.status(500).json({ error: "Errore nel download" });
    }
  });

  // ==========================================
  // AI ANALYSIS
  // ==========================================
  app.post("/api/analyze", async (req: Request, res: Response) => {
    try {
      const { companyName, companyDetails, financialData, mode, competitors } = req.body;

      const systemPrompt = `Sei un analista finanziario senior esperto in bilanci italiani e analisi bancaria. 
Analizza i dati finanziari forniti e produci un'analisi dettagliata in italiano.
Rispondi ESCLUSIVAMENTE in formato JSON valido, senza testo aggiuntivo.

Il tuo output deve seguire esattamente questa struttura JSON:
{
  "summary": "Riepilogo esecutivo dell'azienda in 3-4 frasi",
  "keyMetrics": [
    {"label": "Nome KPI", "value": "Valore", "trend": "up|down|stable", "description": "Breve spiegazione"}
  ],
  "incomeStatementAnalysis": "Analisi dettagliata del conto economico con focus su ricavi, margini, EBITDA, utile netto. Minimo 4-5 paragrafi.",
  "balanceSheetAnalysis": "Analisi dello stato patrimoniale: solidità, liquidità, indebitamento. Minimo 4-5 paragrafi.",
  "cashFlowAnalysis": "Analisi dei flussi di cassa operativi, investimento, finanziamento. Minimo 4-5 paragrafi.",
  "marketComparison": "Confronto con benchmark di settore e mercato italiano. Minimo 3-4 paragrafi.",
  "strengths": ["Punto di forza 1", "Punto di forza 2", "Punto di forza 3"],
  "weaknesses": ["Debolezza 1", "Debolezza 2", "Debolezza 3"],
  "opportunities": ["Opportunità 1", "Opportunità 2", "Opportunità 3"],
  "threats": ["Minaccia 1", "Minaccia 2", "Minaccia 3"],
  "recommendations": ["Raccomandazione strategica 1", "Raccomandazione 2", "Raccomandazione 3", "Raccomandazione 4", "Raccomandazione 5"]
}`;

      let userPrompt = `Analizza la seguente azienda italiana:\n\nAzienda: ${companyName}\n`;

      if (companyDetails) {
        userPrompt += `\nDettagli azienda:\n${JSON.stringify(companyDetails, null, 2)}\n`;
      }

      if (financialData) {
        userPrompt += `\nDati finanziari (bilancio riclassificato):\n${JSON.stringify(financialData, null, 2)}\n`;
      }

      if (mode === "competitor" && competitors) {
        userPrompt += `\nModalità: Analisi competitiva\nConcorrenti: ${JSON.stringify(competitors)}\n`;
        userPrompt += `\nConfronta l'azienda con i suoi competitor nel contesto del mercato italiano.\n`;
      }

      userPrompt += `\nFornisci un'analisi completa come farebbe un analista bancario, includendo:
1. Riclassificazione bancaria del bilancio
2. Almeno 6-8 KPI finanziari (ROE, ROI, ROS, Current Ratio, Debt/Equity, EBITDA margin, ecc.)
3. Confronto con medie di settore
4. Analisi SWOT approfondita
5. Raccomandazioni strategiche operative concrete

Rispondi SOLO con il JSON, senza markdown o testo aggiuntivo.`;

      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getOpenaiApiKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: getOpenaiChatModel(),
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.3,
          max_tokens: 4000,
          response_format: { type: "json_object" },
        }),
      });

      if (!openaiRes.ok) {
        const errText = await openaiRes.text();
        console.error("OpenAI error:", openaiRes.status, errText);
        return res.status(500).json({ error: "Errore nell'analisi AI" });
      }

      const openaiData = await openaiRes.json();
      const content = openaiData.choices?.[0]?.message?.content;

      if (!content) {
        return res.status(500).json({ error: "Risposta AI vuota" });
      }

      const analysis = JSON.parse(content);

      // Save analysis if user is logged in
      const userId = await getUserIdFromReq(req);
      if (userId) {
        await storage.createAnalysis({
          userId,
          mode: mode || "business",
          companyName,
          companyId: companyDetails?.id || null,
          taxCode: companyDetails?.codice_fiscale || null,
          address: companyDetails?.indirizzo || null,
          status: "complete",
          companyDetails,
          financialData,
          aiAnalysis: analysis,
          competitors: competitors || null,
          createdAt: new Date().toISOString(),
        });
      }

      return res.json({ analysis });
    } catch (error: any) {
      console.error("AI analysis error:", error);
      return res.status(500).json({ error: "Errore nell'analisi AI" });
    }
  });

  // ==========================================
  // AI - Find competitors
  // ==========================================
  app.post("/api/find-competitors", async (req: Request, res: Response) => {
    try {
      const { companyName, companyDetails } = req.body;

      const prompt = `Data l'azienda italiana "${companyName}"${companyDetails?.dettaglio?.descrizione_ateco ? ` (settore: ${companyDetails.dettaglio.descrizione_ateco})` : ''}, 
identifica i 3-5 principali concorrenti italiani.

Rispondi SOLO in JSON con questa struttura:
{
  "competitors": [
    {"name": "Nome Azienda Concorrente", "reason": "Motivo per cui è un concorrente"}
  ]
}`;

      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getOpenaiApiKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: getOpenaiChatModel(),
          messages: [
            { role: "system", content: "Sei un esperto di mercato italiano. Rispondi solo in JSON valido." },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 1000,
          response_format: { type: "json_object" },
        }),
      });

      if (!openaiRes.ok) {
        const errText = await openaiRes.text();
        console.error("OpenAI competitors error:", openaiRes.status, errText);
        return res.status(500).json({ error: "Errore nella ricerca competitor" });
      }

      const openaiData = await openaiRes.json();
      const content = openaiData.choices?.[0]?.message?.content;
      const result = JSON.parse(content || "{}");
      return res.json(result);
    } catch (error: any) {
      console.error("Find competitors error:", error);
      return res.status(500).json({ error: "Errore nella ricerca competitor" });
    }
  });

  // ==========================================
  // USER ANALYSES - history
  // ==========================================
  app.get("/api/analyses", async (req: Request, res: Response) => {
    const userId = await getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: "Non autenticato" });
    const analyses = await storage.listAnalysesByUser(userId);
    return res.json({ data: analyses.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")) });
  });

  app.get("/api/analyses/:id", async (req: Request, res: Response) => {
    try {
      const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const id = parseInt(idParam ?? "", 10);
      const analysis = await storage.getAnalysis(id);
      if (!analysis) return res.status(404).json({ error: "Analisi non trovata" });
      return res.json(analysis);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/analyses", async (req: Request, res: Response) => {
    try {
      const analysis = await storage.createAnalysis(req.body);
      return res.status(201).json(analysis);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/analyses/:id", async (req: Request, res: Response) => {
    try {
      const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const id = parseInt(idParam ?? "", 10);
      const updated = await storage.updateAnalysis(id, req.body);
      if (!updated) return res.status(404).json({ error: "Analisi non trovata" });
      return res.json(updated);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  });
}
