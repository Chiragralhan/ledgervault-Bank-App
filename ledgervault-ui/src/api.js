// All communication with the LedgerVault backend goes through this file.
//
// Why it exists:
//  1. Attaches the access token to every request.
//  2. The access token lives only 15 minutes. When the server answers 401,
//     we silently use the refresh token to get a new pair and retry once.
//     (Many requests can fail at the same moment, so only ONE refresh call
//     is made and everyone waits for it: "single-flight".)
//  3. Creates Idempotency-Keys for POSTs so a double-click or a retry can
//     never move money twice.

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// ---------- token storage ----------
// localStorage keeps it simple for a demo. (A production app would prefer
// httpOnly cookies, because JavaScript on the page can read localStorage.)
const KEY = 'ledgervault.session';

export function getSession() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || null;
  } catch {
    return null;
  }
}

function saveSession(session) {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    /* storage unavailable: the app still works until reload */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

// The app listens to this so it can send the user back to the login page
// when the refresh token is rejected (expired or revoked).
const listeners = new Set();
export function onSessionEnded(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function endSession() {
  clearSession();
  listeners.forEach((fn) => fn());
}

// ---------- helpers ----------
export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function newIdempotencyKey() {
  return crypto.randomUUID();
}

/** Reads the expiry time (ms since epoch) out of a JWT, without verifying it. */
export function tokenExpiryMs(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

async function rawFetch(method, path, { token, body, idempotencyKey } = {}) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { res, data };
}

// ---------- refresh (single-flight) ----------
let refreshPromise = null;

export function refreshTokens() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const session = getSession();
    if (!session || !session.refreshToken) throw new ApiError(401, 'Not logged in');

    const { res, data } = await rawFetch('POST', '/api/auth/refresh', {
      body: { refreshToken: session.refreshToken },
    });
    if (!res.ok) {
      endSession();
      throw new ApiError(res.status, (data && data.error) || 'Session expired');
    }
    // The server ROTATES refresh tokens: the old one is now dead, so we must
    // store the new one.
    saveSession({ ...session, accessToken: data.accessToken, refreshToken: data.refreshToken });
    return data;
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

// ---------- the main request function ----------
async function request(method, path, { body, idempotencyKey, auth = true } = {}) {
  const session = getSession();
  let attempt = await rawFetch(method, path, {
    token: auth && session ? session.accessToken : undefined,
    body,
    idempotencyKey,
  });

  // Access token expired -> refresh once, then retry the SAME request
  // (with the SAME idempotency key, so a retry can't double-charge).
  if (attempt.res.status === 401 && auth && session) {
    await refreshTokens();
    const fresh = getSession();
    attempt = await rawFetch(method, path, { token: fresh.accessToken, body, idempotencyKey });
  }

  if (!attempt.res.ok) {
    const message = (attempt.data && attempt.data.error) || `Request failed (${attempt.res.status})`;
    throw new ApiError(attempt.res.status, message, attempt.data);
  }
  return attempt.data;
}

export const api = {
  get: (path) => request('GET', path),
  del: (path) => request('DELETE', path),
  // Pass the SAME key when retrying the same user action.
  post: (path, body, idempotencyKey) => request('POST', path, { body, idempotencyKey }),
};

// ---------- auth calls ----------
export async function login(email, password) {
  const data = await request('POST', '/api/auth/login', { body: { email, password }, auth: false });
  saveSession({ user: data.user, accessToken: data.accessToken, refreshToken: data.refreshToken });
  return data.user;
}

export async function register(name, email, password) {
  await request('POST', '/api/auth/register', { body: { name, email, password }, auth: false });
  return login(email, password);
}

export async function logout() {
  const session = getSession();
  clearSession();
  if (session && session.refreshToken) {
    try {
      // Tells the server to delete the refresh token from Redis (revocation).
      await rawFetch('POST', '/api/auth/logout', { body: { refreshToken: session.refreshToken } });
    } catch {
      /* offline: the local session is gone anyway */
    }
  }
}

export function fetchMe() {
  return request('GET', '/api/auth/me');
}

// ---------- money formatting ----------
// The backend stores integer PAISE. Convert only when displaying.
export function formatRupees(paise) {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}₹${(abs / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}