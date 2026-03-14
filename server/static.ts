import express, { type Express } from "express";
import fs from "fs";
import path from "path";

function buildRuntimeConfigScript() {
  const payload = {
    supabaseUrl: process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.VITE_SUPABASE_ANON_KEY || "",
  };

  const serialized = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<script>window.__BILANCIO_RUNTIME_CONFIG__=${serialized};</script>`;
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  const indexPath = path.resolve(distPath, "index.html");

  app.use(express.static(distPath, { index: false }));

  const serveIndex = (_req: express.Request, res: express.Response) => {
    const html = fs.readFileSync(indexPath, "utf-8");
    const injectedHtml = html.replace("</head>", `${buildRuntimeConfigScript()}</head>`);
    res.type("html").send(injectedHtml);
  };

  app.get("/", serveIndex);

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (req, res) => {
    if (req.path.startsWith("/api")) {
      return res.status(404).end();
    }
    return serveIndex(req, res);
  });
}
