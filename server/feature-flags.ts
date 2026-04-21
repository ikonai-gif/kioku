/**
 * Feature flags — disable domains without redeploy.
 * Default: all enabled. Set env var to 'false' to disable.
 * Checked in route middleware, not storage layer (Bro2 guidance).
 */
export const flags = {
  MEETING_ROOM_ENABLED: process.env.MEETING_ROOM_ENABLED !== 'false',
  LUCA_ENABLED: process.env.LUCA_ENABLED !== 'false',
  GMAIL_SEND_ENABLED: process.env.GMAIL_SEND_ENABLED !== 'false',
  EMBEDDINGS_ENABLED: process.env.EMBEDDINGS_ENABLED !== 'false',
  PUSH_ENABLED: process.env.PUSH_ENABLED !== 'false',
} as const;

export type FeatureFlag = keyof typeof flags;

import type { Request, Response, NextFunction } from 'express';

/**
 * Middleware factory. Returns 503 if flag is disabled.
 * Usage: app.use('/api/meetings', requireFlag('MEETING_ROOM_ENABLED'))
 */
export function requireFlag(flag: FeatureFlag) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!flags[flag]) {
      return res.status(503).json({ 
        error: 'feature_disabled',
        feature: flag,
        message: `Feature ${flag} is temporarily disabled`,
      });
    }
    next();
  };
}

/** Log current flag state at startup */
export function logFlags(logger: { info: Function }) {
  logger.info({ flags }, '[feature-flags] initial state');
}
