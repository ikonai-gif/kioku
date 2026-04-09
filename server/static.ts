import express, { type Express, type Request, type Response } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  // In CJS bundle __dirname = dist/, so public = dist/public
  // Fallback: process.cwd()/dist/public for Railway
  let distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    distPath = path.resolve(process.cwd(), "dist", "public");
  }
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // Root → landing page (MUST be before express.static so index.html doesn't win)
  app.get("/", (_req: Request, res: Response) => {
    res.sendFile(path.resolve(distPath, "landing.html"));
  });

  // /app → SPA index.html
  app.get("/app", (_req: Request, res: Response) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });

  // /docs → developer docs page
  app.get("/docs", (_req: Request, res: Response) => {
    res.sendFile(path.resolve(distPath, "docs.html"));
  });

  // /privacy → standalone crawlable page
  app.get("/privacy", (_req: Request, res: Response) => {
    res.sendFile(path.resolve(distPath, "privacy.html"));
  });

  // /terms → standalone crawlable page (includes refund policy)
  app.get("/terms", (_req: Request, res: Response) => {
    res.sendFile(path.resolve(distPath, "terms.html"));
  });

  // Serve static assets (JS, CSS, images, fonts, etc.)
  app.use(express.static(distPath));

  // Everything else falls through to index.html (SPA catch-all)
  app.use("/{*path}", (_req: Request, res: Response) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
