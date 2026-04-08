// Session token stored in React state / passed via context
// No localStorage/sessionStorage per project rules

let _sessionToken: string | null = null;
let _onUnauth: (() => void) | null = null;

export function setSessionToken(token: string | null) {
  _sessionToken = token;
}

export function getSessionToken(): string | null {
  return _sessionToken;
}

export function setUnauthHandler(fn: () => void) {
  _onUnauth = fn;
}

export function handleUnauth() {
  _sessionToken = null;
  _onUnauth?.();
}
