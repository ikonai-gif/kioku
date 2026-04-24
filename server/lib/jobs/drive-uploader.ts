/**
 * KIOKU™ Internal Jobs — Google Drive Uploader
 *
 * OAuth installed-app refresh-token flow, uploads buffers to a target folder
 * owned by the user (not the service account — service accounts have no
 * Drive quota on personal Google accounts).
 *
 * ENV:
 *   GOOGLE_DRIVE_CLIENT_ID
 *   GOOGLE_DRIVE_CLIENT_SECRET
 *   GOOGLE_DRIVE_REFRESH_TOKEN
 *   GOOGLE_DRIVE_BACKUP_FOLDER_ID
 *
 * The refresh token is a long-lived credential — treat it like a password.
 * It grants access to `drive.file` scope: the uploader can only touch files
 * it created, NOT the user's other Drive contents.
 *
 * Injectable for tests: pass `driveOverride` to skip real googleapis calls.
 */

import logger from "../../logger";
import { Readable } from "node:stream";

export type DriveUploadResult = {
  id: string;
  name: string;
  size: number;
  webViewLink?: string;
};

export type DriveConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folderId: string;
};

export type DriveLike = {
  files: {
    create: (req: any) => Promise<{ data: { id?: string | null; name?: string | null; size?: string | null; webViewLink?: string | null } }>;
  };
};

export function readDriveConfig(): DriveConfig | { error: string } {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID ?? "";
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? "";
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN ?? "";
  const folderId = process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID ?? "";
  const missing: string[] = [];
  if (!clientId) missing.push("GOOGLE_DRIVE_CLIENT_ID");
  if (!clientSecret) missing.push("GOOGLE_DRIVE_CLIENT_SECRET");
  if (!refreshToken) missing.push("GOOGLE_DRIVE_REFRESH_TOKEN");
  if (!folderId) missing.push("GOOGLE_DRIVE_BACKUP_FOLDER_ID");
  if (missing.length) return { error: `missing env: ${missing.join(",")}` };
  return { clientId, clientSecret, refreshToken, folderId };
}

/**
 * Build a `google.drive('v3')` client authenticated via OAuth refresh token.
 * Exported for tests that want to assert on client behavior (we normally
 * pass a mock into uploadBufferToDrive instead).
 */
export async function buildDriveClient(cfg: DriveConfig): Promise<DriveLike> {
  // Import lazily so tests can run without pulling googleapis on every worker.
  const { google } = await import("googleapis");
  const oauth2 = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret);
  oauth2.setCredentials({ refresh_token: cfg.refreshToken });
  const drive = google.drive({ version: "v3", auth: oauth2 as any });
  return drive as unknown as DriveLike;
}

/**
 * Upload a Buffer to Drive under the configured folder.
 * mimeType defaults to application/json for KIOKU backups.
 */
export async function uploadBufferToDrive(
  filename: string,
  buf: Buffer,
  opts: { mimeType?: string; config?: DriveConfig; driveOverride?: DriveLike } = {},
): Promise<DriveUploadResult> {
  const mimeType = opts.mimeType ?? "application/json";
  const cfgOrErr = opts.config ?? readDriveConfig();
  if ("error" in cfgOrErr) throw new Error(`drive-uploader: ${cfgOrErr.error}`);
  const cfg = cfgOrErr as DriveConfig;

  const drive = opts.driveOverride ?? (await buildDriveClient(cfg));

  const resp = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [cfg.folderId],
      mimeType,
    },
    media: {
      mimeType,
      body: Readable.from(buf),
    },
    fields: "id,name,size,webViewLink",
  });

  const data = resp.data;
  if (!data.id) throw new Error("drive-uploader: create returned no id");

  const size = Number(data.size ?? buf.length);
  logger.info(
    { component: "jobs", event: "drive_upload_ok", filename, id: data.id, size },
    "[jobs] drive upload complete",
  );
  return {
    id: data.id,
    name: data.name ?? filename,
    size,
    webViewLink: data.webViewLink ?? undefined,
  };
}
