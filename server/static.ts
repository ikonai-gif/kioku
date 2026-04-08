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

  // Serve static assets (JS, CSS, images, etc.)
  app.use(express.static(distPath));

  // Root → landing page
  app.get("/", (_req: Request, res: Response) => {
    res.sendFile(path.resolve(distPath, "landing.html"));
  });

  // /app and all SPA sub-routes → index.html
  app.get("/app", (_req: Request, res: Response) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });

  // Everything else falls through to index.html (SPA catch-all)
  app.use("/{*path}", (_req: Request, res: Response) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
