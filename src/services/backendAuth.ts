// Frontend helper for the backend-driven Microsoft SSO flow implemented in
// server.ts (/auth/microsoft/login, /auth/microsoft/callback, /auth/session).
// This replaces the old client-only @azure/msal-browser flow in msalAuth.ts.

export interface BackendSessionUser {
  msId: string;
  displayName?: string;
  email: string;
  jobTitle?: string;
  department?: string;
}

// Same-origin: server.ts serves both the API routes and the Vite app on the
// same port, so no base URL / CORS setup is needed, in dev or production.
export function redirectToMicrosoftLogin() {
  window.location.href = '/auth/microsoft/login';
}

export async function checkBackendSession(): Promise<BackendSessionUser | null> {
  try {
    const res = await fetch('/auth/session', { credentials: 'include' });
    const data = await res.json();
    return data.authenticated ? (data.user as BackendSessionUser) : null;
  } catch {
    return null;
  }
}

export async function backendLogout(): Promise<void> {
  try {
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
  } catch {
    // Best-effort - client-side logout (App.tsx handleLogout) still runs.
  }
}