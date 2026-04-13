import { defineConfig } from "drizzle-kit";

const dbUrl = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/kioku";
const isSSL = dbUrl.includes('sslmode=require');

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: dbUrl,
    ssl: isSSL ? { rejectUnauthorized: false } : false,
  },
});
