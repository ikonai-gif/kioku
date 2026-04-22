/**
 * Singleton holder for the process-wide MeetingEventBus (W9 Item 3-4).
 *
 * Why a registry and not a module-level export? The actual `WsMeetingEventBus`
 * instance lives in `server/ws.ts` and needs to be constructed AFTER the
 * HTTP server is created (so `setupWebSocket` can bind). But `routes.ts`
 * registers handlers BEFORE the HTTP server starts listening. The registry
 * lets `server/index.ts` install the real bus during boot; until then
 * callers get a Noop, and the reaper + route handlers resolve the bus
 * lazily on first emission.
 *
 * In tests: pass a custom bus directly to `registerMeetingRoutes` and
 * `startMeetingReaper` — do NOT touch the registry. Keeps test isolation.
 */
import { NoopMeetingEventBus, type MeetingEventBus } from "./meeting-event-bus";

let _bus: MeetingEventBus = new NoopMeetingEventBus();

export function setMeetingEventBus(bus: MeetingEventBus): void {
  _bus = bus;
}

export function getMeetingEventBus(): MeetingEventBus {
  return _bus;
}

/** Test helper — resets registry back to the Noop default. */
export function _resetMeetingEventBusForTests(): void {
  _bus = new NoopMeetingEventBus();
}
