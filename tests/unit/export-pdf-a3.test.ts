/**
 * P1.2 — Audit export PDF/A-3-style + Ed25519 signature.
 *
 * Verifies:
 *  1) buildSignedPdfA3 returns a valid PDF (magic header) with embedded JSON + XMP.
 *  2) Signature over the canonical JSON verifies with the embedded public key.
 *  3) Tampered JSON fails verification.
 *  4) Missing key env -> AuditKeyNotConfiguredError.
 */
import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";
import {
  buildSignedPdfA3,
  verifySignedExport,
  AuditKeyNotConfiguredError,
} from "../../server/pdf-a3-export.js";

const SAMPLE_JSON = JSON.stringify({ room: 7, messages: [{ id: 1, text: "hello" }], exported: true });

beforeAll(() => {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  process.env.KIOKU_AUDIT_PRIVATE_KEY = Buffer.from(der).toString("base64");
});

describe("P1.2 — buildSignedPdfA3", () => {
  it("produces a valid PDF with embedded JSON attachment and XMP", async () => {
    const out = await buildSignedPdfA3(7, SAMPLE_JSON);
    const head = out.bytes.subarray(0, 5).toString("latin1");
    expect(head).toBe("%PDF-");
    const body = out.bytes.toString("latin1");
    expect(body).toContain("room-export.json");
    expect(body).toContain("EmbeddedFile");
    expect(body).toContain("kioku:signature_base64url");
    expect(body).toContain("kioku:public_key_base64url");
    expect(out.signerKeyId).toBeTruthy();
    expect(out.signatureBase64Url.length).toBeGreaterThan(0);
  });

  it("signature verifies over the canonical JSON with embedded pubkey", async () => {
    const out = await buildSignedPdfA3(7, SAMPLE_JSON);
    const ok = verifySignedExport(Buffer.from(SAMPLE_JSON, "utf-8"), out.signatureBase64Url, out.publicKeyBase64Url);
    expect(ok).toBe(true);
  });

  it("rejects tampered JSON", async () => {
    const out = await buildSignedPdfA3(7, SAMPLE_JSON);
    const tampered = Buffer.from(SAMPLE_JSON.replace("hello", "HELLO"), "utf-8");
    const ok = verifySignedExport(tampered, out.signatureBase64Url, out.publicKeyBase64Url);
    expect(ok).toBe(false);
  });

  it("throws AuditKeyNotConfiguredError when key env is missing", async () => {
    const saved = process.env.KIOKU_AUDIT_PRIVATE_KEY;
    delete process.env.KIOKU_AUDIT_PRIVATE_KEY;
    await expect(buildSignedPdfA3(7, SAMPLE_JSON)).rejects.toBeInstanceOf(AuditKeyNotConfiguredError);
    process.env.KIOKU_AUDIT_PRIVATE_KEY = saved;
  });
});
