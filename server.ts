import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import session from 'express-session';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Extend express-session's types with the fields we actually store, so
// req.session.user / req.session.state are typed instead of `any`.
declare module 'express-session' {
  interface SessionData {
    state?: string;
    user?: {
      msId: string;
      displayName?: string;
      email: string;
      jobTitle?: string;
      department?: string;
    };
  }
}

// Reads MS_CLIENT_ID first, falling back to the same alternate names the
// original DigiCash implementation accepted (AZURE_AD_CLIENT_ID / AZURE_CLIENT_ID),
// so existing .env values from either naming convention keep working.
function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(
    session({
      secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 8 * 60 * 60 * 1000, // 8 hours
      },
    })
  );

  // Simple API route example / health-check
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      message: 'Survey Analytics Prototype Express API is running'
    });
  });

  // ---------------------------------------------------------------------
  // Microsoft SSO (backend authorization-code flow)
  // ---------------------------------------------------------------------

  // Step 1: redirect the browser to Microsoft's login page.
  app.get('/auth/microsoft/login', (req, res) => {
    const tenantId = firstEnv('MS_TENANT_ID', 'AZURE_TENANT_ID') || 'organizations';
    const clientId = firstEnv('MS_CLIENT_ID', 'AZURE_AD_CLIENT_ID', 'AZURE_CLIENT_ID');
    const redirectUri = firstEnv('MS_REDIRECT_URI', 'AZURE_AD_REDIRECT_URI', 'AZURE_REDIRECT_URI');
    const scopes = 'openid profile email User.Read';
    const state = `sso-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    if (!clientId || !redirectUri) {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      return res.redirect(`${frontendUrl}/?error=ms_not_configured`);
    }

    req.session.state = state;

    const authorizeUrl = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('response_mode', 'query');
    authorizeUrl.searchParams.set('scope', scopes);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('prompt', 'select_account');

    res.redirect(authorizeUrl.toString());
  });

  // Step 2: Microsoft redirects back here with a `code`. Exchange it for a
  // token, fetch the user's profile, and store it in the session.
  app.get('/auth/microsoft/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    if (error) {
      return res.redirect(`${frontendUrl}/?error=${encodeURIComponent(String(error))}`);
    }
    if (!code || state !== req.session.state) {
      return res.redirect(`${frontendUrl}/?error=invalid_state`);
    }

    try {
      const tenantId = firstEnv('MS_TENANT_ID', 'AZURE_TENANT_ID') || 'organizations';
      const clientId = firstEnv('MS_CLIENT_ID', 'AZURE_AD_CLIENT_ID', 'AZURE_CLIENT_ID') || '';
      const clientSecret = firstEnv('MS_CLIENT_SECRET', 'AZURE_AD_CLIENT_SECRET', 'AZURE_CLIENT_SECRET') || '';
      const redirectUri = firstEnv('MS_REDIRECT_URI', 'AZURE_AD_REDIRECT_URI', 'AZURE_REDIRECT_URI') || '';

      const tokenResponse = await axios.post(
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: redirectUri,
          scope: 'openid profile email User.Read',
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      const accessToken = tokenResponse.data.access_token;

      const profileResponse = await axios.get(
        'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName,jobTitle,department',
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      const profile = profileResponse.data;
      const email = (profile.mail || profile.userPrincipalName || '').toLowerCase();

      // Restrict to the organization's own accounts, matching the existing
      // app-wide @mgenesis.com rule (see App.tsx handleLogin).
      if (!email.endsWith('@mgenesis.com')) {
        return res.redirect(`${frontendUrl}/?error=unauthorized_domain`);
      }

      req.session.user = {
        msId: profile.id,
        displayName: profile.displayName,
        email,
        jobTitle: profile.jobTitle,
        department: profile.department,
      };

      res.redirect(`${frontendUrl}/?sso=success`);
    } catch (err) {
      console.error('[auth] Microsoft token exchange failed:', err);
      res.redirect(`${frontendUrl}/?error=token_exchange_failed`);
    }
  });

  // Step 3: frontend calls this after redirect to find out who's signed in.
  app.get('/auth/session', (req, res) => {
    if (!req.session.user) {
      return res.json({ authenticated: false });
    }
    res.json({ authenticated: true, user: req.session.user });
  });

  app.post('/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  // Check if we are running in production
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    // Serve static assets from dist
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    
    // Fallback to index.html for React SPA client-side routing
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    // Integrate Vite dev server middleware
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running in ${isProduction ? 'production' : 'development'} mode`);
    console.log(`Access the application at http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});