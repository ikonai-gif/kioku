/**
 * P1.2 — Audit export: PDF/A-3-style container with embedded canonical JSON,
 * XMP metadata, and an Ed25519 signature.
 *
 * Ref: [BRO2-A58] hook context, [BRO4-002] spec.
 *
 * DESIGN NOTES (deviations from BRO4 spec, intentional):
 *  1. Signature covers the EMBEDDED JSON bytes, not the final PDF bytes.
 *     The signature is stored inside the PDF's XMP, so signing the final
 *     PDF would be self-referential and unverifiable. The JSON attachment
 *     is the canonical audit record; verifySignedExport() checks it.
 *  2. Ed25519 uses the one-shot crypto.sign(null, ...) API. Node's streaming
 *     createSign() does NOT support Ed25519 and throws.
 *  3. Private key is read from env KIOKU_AUDIT_PRIVATE_KEY (base64 of a DER
 *     PKCS8 key). It is NEVER generated or persisted here — BOSS provisions it.
 *  4. "PDF/A-3" here means PDF/A-3-style: embedded file + XMP + valid PDF.
 *     Full PDF/A conformance (OutputIntent, veraPDF) is out of scope (BRO4 spec).
 */
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import crypto, { KeyObject } from "crypto";

export class AuditKeyNotConfiguredError extends Error {
  constructor() {
    super("KIOKU_AUDIT_PRIVATE_KEY is not configured");
    this.name = "AuditKeyNotConfiguredError";
  }
}

const SIGNER_KEY_ID = process.env.KIOKU_AUDIT_KEY_ID || "kioku-audit-1";

function loadKeys(): { privateKey: KeyObject; publicKey: KeyObject } {
  const b64 = process.env.KIOKU_AUDIT_PRIVATE_KEY;
  if (!b64) throw new AuditKeyNotConfiguredError();
  const der = Buffer.from(b64, "base64");
  const privateKey = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const publicKey = crypto.createPublicKey(privateKey);
  return { privateKey, publicKey };
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildXmp(args: {
  roomId: number;
  exportedAt: string;
  keyId: string;
  sigB64: string;
  pubB64: string;
}): string {
  const room = xmlEscape(String(args.roomId));
  const ts = xmlEscape(args.exportedAt);
  const keyId = xmlEscape(args.keyId);
  const sig = xmlEscape(args.sigB64);
  const pub = xmlEscape(args.pubB64);
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:kioku="https://kioku.ikonbai.com/xmp/1.0/"
    kioku:room_id="${room}"
    kioku:export_timestamp="${ts}"
    kioku:signer_key_id="${keyId}"
    kioku:signature_alg="Ed25519"
    kioku:signature_target="embedded:room-export.json"
    kioku:signature_base64url="${sig}"
    kioku:public_key_base64url="${pub}"
    kioku:pdf_a_level="3b-style"
    kioku:embedded_attachment="application/json:room-export.json"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

export interface SignedPdfA3 {
  bytes: Buffer;
  signerKeyId: string;
  signatureBase64Url: string;
  publicKeyBase64Url: string;
}

/**
 * Build a signed PDF/A-3-style audit container around the canonical JSON export.
 * `jsonPayload` is the exact string returned by serializeRoomExport() — the
 * signature covers these bytes.
 */
export async function buildSignedPdfA3(roomId: number, jsonPayload: string): Promise<SignedPdfA3> {
  const { privateKey, publicKey } = loadKeys();
  const jsonBytes = Buffer.from(jsonPayload, "utf-8");

  const signature = crypto.sign(null, jsonBytes, privateKey);
  const sigB64 = signature.toString("base64url");
  const pubDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const pubB64 = pubDer.toString("base64url");

  const exportedAt = new Date().toISOString();

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 842]); // A4
  let y = 800;
  const line = (t: string, size = 10) => { page.drawText(t, { x: 50, y, size, font }); y -= size + 6; };
  line(`KIOKU Room Audit Export`, 16);
  y -= 4;
  line(`Room ID: ${roomId}`);
  line(`Exported: ${exportedAt}`);
  line(`Signer key: ${SIGNER_KEY_ID} (Ed25519)`);
  y -= 6;
  line(`The canonical audit record is the embedded JSON attachment`);
  line(`("room-export.json"). The Ed25519 signature in the XMP metadata`);
  line(`covers exactly those JSON bytes. Verify with the embedded public key.`);

  await pdf.attach(jsonBytes, "room-export.json", {
    mimeType: "application/json",
    description: "Canonical signed room audit export (signature covers these bytes).",
    creationDate: new Date(exportedAt),
    modificationDate: new Date(exportedAt),
  });

  const xmp = buildXmp({ roomId, exportedAt, keyId: SIGNER_KEY_ID, sigB64, pubB64 });
  const metaStream = pdf.context.stream(xmp, { Type: "Metadata", Subtype: "XML" });
  const metaRef = pdf.context.register(metaStream);
  pdf.catalog.set(PDFName.of("Metadata"), metaRef);

  const bytes = Buffer.from(await pdf.save());
  return { bytes, signerKeyId: SIGNER_KEY_ID, signatureBase64Url: sigB64, publicKeyBase64Url: pubB64 };
}

/** Verify a signature produced by buildSignedPdfA3 over the canonical JSON bytes. */
export function verifySignedExport(jsonBytes: Buffer, signatureBase64Url: string, publicKeyBase64Url: string): boolean {
  const pubDer = Buffer.from(publicKeyBase64Url, "base64url");
  const publicKey = crypto.createPublicKey({ key: pubDer, format: "der", type: "spki" });
  return crypto.verify(null, jsonBytes, publicKey, Buffer.from(signatureBase64Url, "base64url"));
}
