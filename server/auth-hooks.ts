/**
 * Auth hooks — shared between index.ts and routes.ts
 * Avoids circular dependency
 */
export { recordAuthFailure, recordAuthSuccess } from "./security";
