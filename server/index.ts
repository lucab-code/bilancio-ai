import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

function previewBasicAuthEnabled(): boolean {
  return Boolean(process.env.PREVIEW_BASIC_AUTH_USER?.trim() && process.env.PREVIEW_BASIC_AUTH_PASS?.trim());
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function getPreviewCookieValue(): string {
  const expectedUser = process.env.PREVIEW_BASIC_AUTH_USER?.trim() || "";
  const expectedPass = process.env.PREVIEW_BASIC_AUTH_PASS?.trim() || "";
  return createHash("sha256").update(`${expectedUser}:${expectedPass}`).digest("hex");
}

function readCookieValue(cookieHeader: string, key: string): string {
  const cookies = cookieHeader.split(";").map((item) => item.trim());
  for (const cookie of cookies) {
    if (!cookie.startsWith(`${key}=`)) continue;
    return cookie.slice(key.length + 1);
  }
  return "";
}

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");

  if (!previewBasicAuthEnabled()) {
    return next();
  }

  if (req.path === "/api/billing/stripe/webhook") {
    return next();
  }

  const previewCookie = readCookieValue(typeof req.headers.cookie === "string" ? req.headers.cookie : "", "bilancio_preview_auth");
  if (previewCookie && safeEqual(previewCookie, getPreviewCookieValue())) {
    (req as any).previewAuthorized = true;
    return next();
  }

  const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  if (!authHeader.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="BilancioAI Preview"');
    return res.status(401).send("Authentication required");
  }

  const encoded = authHeader.slice("Basic ".length).trim();
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separatorIndex = decoded.indexOf(":");
  const username = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : "";
  const password = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : "";

  const expectedUser = process.env.PREVIEW_BASIC_AUTH_USER?.trim() || "";
  const expectedPass = process.env.PREVIEW_BASIC_AUTH_PASS?.trim() || "";

  if (!safeEqual(username, expectedUser) || !safeEqual(password, expectedPass)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="BilancioAI Preview"');
    return res.status(401).send("Invalid credentials");
  }

  const secureCookie = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `bilancio_preview_auth=${getPreviewCookieValue()}; Path=/; HttpOnly; SameSite=Lax${secureCookie}`,
  );
  (req as any).previewAuthorized = true;

  return next();
});

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      log(`${req.method} ${path} ${res.statusCode} in ${duration}ms`);
    }
  });

  next();
});

(async () => {
  const { loadConfig } = await import("./config");
  await loadConfig();

  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "3000", 10);
  // In production/platform environments (e.g. Railway) the server must bind to 0.0.0.0.
  const host = process.env.HOST || "0.0.0.0";
  httpServer.listen(
    {
      port,
      host,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
