import { defineConfig } from "drizzle-kit";

const dbUrl = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/kioku";
const sslConfig = dbUrl.includes('neon.tech')
  ? { rejectUnauthorized: true }
  : (process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: true }
    : (dbUrl.includes('sslmode=require') ? { rejectUnauthorized: true } : false));

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: dbUrl,
    ssl: sslConfig,
  },
});
