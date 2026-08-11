import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { redirectToMicrosoftLogin, checkBackendSession } from '../services/backendAuth';
import { isDemoModeEnabled } from '../utils/demoMode';

// Maps the backend's ?error= query values (see server.ts) to readable text.
const SSO_ERROR_MESSAGES: Record<string, string> = {
  ms_not_configured: 'Microsoft sign-in is not configured on the server yet.',
  invalid_state: 'Your sign-in session expired. Please try again.',
  unauthorized_domain: 'Access is restricted to verified @mgenesis.com accounts.',
  token_exchange_failed: 'Microsoft sign-in failed. Please try again.',
};

// Passed up to App so it can establish the Supabase session (RLS) from the
// Microsoft ID token. `auth` is optional only so non-Microsoft/dev callers
// still type-check; the real sign-in path always provides it.
export interface MicrosoftAuth {
  idToken: string;
  nonce: string;
}

interface LoginPageProps {
  onLogin: (email: string, auth?: MicrosoftAuth) => void;
}

// Ambient dot texture for the hero panel — kept extremely faint (2–5% via the
// text-white/[x] utility on the parent) so it reads as depth, not pattern.
function DotGrid({ id, className }: { id: string; className?: string }) {
  return (
    <svg className={className} aria-hidden="true">
      <defs>
        <pattern id={id} width="26" height="26" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1.5" fill="currentColor" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}

// Oversized concentric rings echoing the orbital swoosh in the Microgenesis
// mark — bled off the panel edge and kept near-invisible, so it only adds a
// sense of scale/depth behind the hero content, never a focal point.
function OrbitalRings({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 600 600" className={className} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="480" cy="120" r="260" stroke="currentColor" strokeWidth="1" />
      <circle cx="480" cy="120" r="195" stroke="currentColor" strokeWidth="1" transform="rotate(-16 480 120)" />
      <ellipse cx="480" cy="120" rx="260" ry="150" stroke="currentColor" strokeWidth="1" transform="rotate(22 480 120)" />
    </svg>
  );
}

// Minimal line-art scene standing in for the product: an analytics dashboard
// (bars + trend), a KPI gauge, and a small supplier network with one
// checkmark node for surveys. No text/numbers — purely pictogram-level, so it
// reads as texture rather than a mock dashboard.
function HeroIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 460 200" className={className} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M55 55 L160 60" stroke="#8fb9dd" strokeOpacity="0.25" strokeWidth="1" />
      <path d="M45 145 L160 130" stroke="#8fb9dd" strokeOpacity="0.25" strokeWidth="1" />
      <path d="M405 135 L340 110" stroke="#8fb9dd" strokeOpacity="0.25" strokeWidth="1" />
      <path d="M245 182 L245 150" stroke="#8fb9dd" strokeOpacity="0.25" strokeWidth="1" />

      <rect x="160" y="35" width="180" height="115" rx="12" fill="#ffffff" fillOpacity="0.03" stroke="#8fc0ea" strokeOpacity="0.3" strokeWidth="1.2" />
      <line x1="178" y1="56" x2="226" y2="56" stroke="#8fc0ea" strokeOpacity="0.4" strokeWidth="2" strokeLinecap="round" />

      <rect x="178" y="100" width="13" height="28" rx="2" fill="#6fa8dd" fillOpacity="0.45" />
      <rect x="200" y="86" width="13" height="42" rx="2" fill="#6fa8dd" fillOpacity="0.6" />
      <rect x="222" y="106" width="13" height="22" rx="2" fill="#6fa8dd" fillOpacity="0.35" />
      <rect x="244" y="76" width="13" height="52" rx="2" fill="#8fc0ea" fillOpacity="0.85" />

      <polyline
        points="178,70 200,64 222,68 244,52 262,46"
        fill="none"
        stroke="#bcdcf7"
        strokeOpacity="0.55"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="262" cy="46" r="2.5" fill="#bcdcf7" fillOpacity="0.9" />

      <circle cx="350" cy="45" r="18" fill="#0a1730" stroke="#ffffff" strokeOpacity="0.1" strokeWidth="2" />
      <circle
        cx="350"
        cy="45"
        r="18"
        stroke="#6fa8dd"
        strokeOpacity="0.85"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="79 200"
        transform="rotate(-90 350 45)"
      />

      <circle cx="55" cy="55" r="7" stroke="#6fa8dd" strokeOpacity="0.5" strokeWidth="1.2" />
      <circle cx="55" cy="55" r="3" fill="#6fa8dd" fillOpacity="0.8" />

      <circle cx="45" cy="145" r="7" stroke="#6fa8dd" strokeOpacity="0.5" strokeWidth="1.2" />
      <circle cx="45" cy="145" r="3" fill="#6fa8dd" fillOpacity="0.8" />

      <circle cx="405" cy="135" r="7" stroke="#6fa8dd" strokeOpacity="0.5" strokeWidth="1.2" />
      <circle cx="405" cy="135" r="3" fill="#6fa8dd" fillOpacity="0.8" />

      <circle cx="245" cy="182" r="11" fill="#0a1730" stroke="#8fc0ea" strokeOpacity="0.5" strokeWidth="1.3" />
      <path
        d="M239 182 L243 186 L251 177"
        stroke="#bcdcf7"
        strokeOpacity="0.9"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const demoModeEnabled = isDemoModeEnabled();
  const [isMsSigningIn, setIsMsSigningIn] = useState(false);
  const [msError, setMsError] = useState('');
  const [demoEmail, setDemoEmail] = useState('');
  const [demoError, setDemoError] = useState('');
  const [showDemoFallback, setShowDemoFallback] = useState(false);

  // Runs once on mount to pick up where the backend's Microsoft redirect
  // (server.ts /auth/microsoft/callback) left off: either ?sso=success,
  // meaning a session cookie now exists and we just need to read who it is,
  // or ?error=... from a failed attempt.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ssoSuccess = params.get('sso') === 'success';
    const errorCode = params.get('error');

    if (errorCode) {
      setMsError(SSO_ERROR_MESSAGES[errorCode] || 'Microsoft sign-in failed. Please try again.');
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }

    if (ssoSuccess) {
      setIsMsSigningIn(true);
      checkBackendSession().then((user) => {
        setIsMsSigningIn(false);
        window.history.replaceState({}, '', window.location.pathname);
        if (user) {
          onLogin(user.email);
        } else {
          setMsError('Sign-in succeeded but no session was found. Please try again.');
        }
      });
    }
  }, [onLogin]);

  function handleDemoLogin(e: React.FormEvent) {
    e.preventDefault();
    setDemoError('');
    const normalized = demoEmail.trim().toLowerCase();
    if (!normalized.endsWith('@mgenesis.com')) {
      setDemoError('Access is restricted to verified @mgenesis.com accounts.');
      return;
    }
    onLogin(normalized);
  }

  function handleMicrosoftSignIn() {
    setMsError('');
    setIsMsSigningIn(true);
    // Full-page redirect to the backend, which redirects to Microsoft. See
    // server.ts for the rest of the flow - this page picks back up in the
    // useEffect above once Microsoft sends the browser back here.
    redirectToMicrosoftLogin();
  }

  return (
    <div className="relative min-h-screen w-full overflow-x-hidden bg-white">
      {/* Mobile hero — compact brand band, distinct from the desktop split layout */}
      <div className="relative overflow-hidden bg-[linear-gradient(160deg,#060c18_0%,#0a1f38_45%,#123a5e_100%)] px-6 pb-16 pt-12 text-white md:hidden">
        <DotGrid id="dots-mobile" className="pointer-events-none absolute inset-0 h-full w-full text-white/[0.035]" />
        <OrbitalRings className="pointer-events-none absolute -right-32 -top-40 h-[420px] w-[420px] text-white/[0.07]" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_90%_60%_at_50%_0%,rgba(94,169,230,0.18),transparent_65%)]" />

        <div className="relative z-10 flex flex-col items-center text-center">
          <img src="/microgenesis_logo.png" alt="Microgenesis" className="h-11 object-contain brightness-0 invert" />

          <div className="mt-8 flex max-w-xs items-center gap-3 text-left">
            <img src="/smpesa_icon.png" alt="" className="h-9 w-9 shrink-0 object-contain" />
            <h1 className="min-w-0 text-xl font-medium leading-snug tracking-tight text-white">
              Supplier Management Performance Evaluation Survey Analytics
            </h1>
          </div>
          <p className="mt-4 max-w-xs text-xs font-light leading-relaxed text-[#93aec9]">
            Surveys, scoring, and reporting for every Microgenesis supplier — in one place.
          </p>
        </div>
      </div>

      <div className="md:flex md:min-h-screen">
        {/* Desktop / tablet brand panel — 2/3 width, marketing-style */}
        <div className="relative hidden overflow-hidden bg-[linear-gradient(160deg,#060c18_0%,#0a1f38_45%,#123a5e_100%)] px-10 py-12 text-white md:flex md:flex-1 md:flex-col lg:px-16">
          <DotGrid id="dots-desktop" className="pointer-events-none absolute inset-0 h-full w-full text-white/[0.035]" />
          <OrbitalRings className="pointer-events-none absolute -right-24 -top-32 h-[560px] w-[560px] text-white/[0.07]" />
          <HeroIllustration className="pointer-events-none absolute -right-16 bottom-0 h-auto w-[620px] max-w-none opacity-[0.14]" />
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_85%_0%,rgba(94,169,230,0.16),transparent_60%)]" />

          <div className="relative z-10 mb-12 flex items-center lg:mb-16">
            <img
              src="/microgenesis_logo.png"
              alt="Microgenesis"
              className="h-12 object-contain brightness-0 invert lg:h-14"
            />
          </div>

          <div className="relative z-10 flex flex-1 flex-col justify-center pb-16 lg:pb-20">
            <div className="max-w-xl lg:max-w-2xl">
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
              >
                <div className="flex items-center gap-5">
                  <img src="/smpesa_icon.png" alt="" className="h-16 w-16 shrink-0 object-contain lg:h-20 lg:w-20" />
                  <h2 className="min-w-0 text-4xl font-medium leading-snug tracking-tight text-white lg:text-5xl">
                    Supplier Management Performance Evaluation Survey Analytics
                  </h2>
                </div>
              </motion.div>

              <p className="mt-6 text-base font-light leading-relaxed text-[#93aec9] lg:text-lg">
                Centralizing stakeholder surveys, scoring, and reporting for every Microgenesis supplier and
                subcontractor — in one dashboard.
              </p>
            </div>
          </div>

          <div className="relative z-10 text-[10px] font-light uppercase tracking-wider text-[#7590ae]">
            © {new Date().getFullYear()} Microgenesis. All rights reserved.
          </div>
        </div>

        {/* Sign-in panel — Microsoft SSO only */}
        <div className="relative z-10 -mt-8 flex flex-col justify-center rounded-t-3xl bg-white px-6 py-10 shadow-[0_-12px_40px_rgba(15,23,42,0.12)] sm:px-10 md:mt-0 md:w-[380px] md:shrink-0 md:rounded-none md:px-10 md:py-12 md:shadow-none lg:w-1/3 lg:min-w-[380px] lg:px-14">
          <div className="mx-auto w-full max-w-sm">
            <img
              src="/microgenesis_logo.png"
              alt="Microgenesis"
              className="mb-8 h-8 object-contain object-left md:mb-10 md:h-9"
            />

            <div className="mb-7">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-[#0063a9]">SMPESA</p>
              <h1 className="mt-1.5 text-2xl font-medium text-slate-900">Welcome back</h1>
              <p className="mt-1.5 text-sm font-light text-slate-500">
                Sign in with your Microgenesis Microsoft account to continue.
              </p>
            </div>

            {msError && (
              <p className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose">
                {msError}
              </p>
            )}

            <button
              type="button"
              onClick={handleMicrosoftSignIn}
              disabled={isMsSigningIn}
              className="flex w-full cursor-pointer items-center justify-center gap-2.5 rounded-lg border border-slate-300 bg-white py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-70"
            >
              <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
                <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
              </svg>
              {isMsSigningIn ? 'Signing in…' : 'Sign in with Microsoft'}
            </button>

            {demoModeEnabled && (
              <div className="mt-4">
                {!showDemoFallback ? (
                  <button
                    type="button"
                    onClick={() => setShowDemoFallback(true)}
                    className="w-full cursor-pointer text-center text-[11px] font-medium text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline"
                  >
                    Azure not set up yet? Use local demo login
                  </button>
                ) : (
                  <form onSubmit={handleDemoLogin} className="mt-3 space-y-3">
                    <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-700">
                      Demo login bypasses Microsoft SSO — for local development only.
                    </p>
                    {demoError && (
                      <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-600">
                        {demoError}
                      </p>
                    )}
                    <input
                      type="email"
                      required
                      placeholder="you@mgenesis.com"
                      value={demoEmail}
                      onChange={(e) => setDemoEmail(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-[#0063a9]"
                    />
                    <button
                      type="submit"
                      className="w-full cursor-pointer rounded-lg bg-[#0063a9] py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#00528c]"
                    >
                      Continue with demo login
                    </button>
                  </form>
                )}
              </div>
            )}

            <p className="mt-8 text-center text-[11px] leading-relaxed text-slate-400">
              Access restricted to verified <span className="font-semibold text-slate-500">@mgenesis.com</span>{' '}
              accounts.
              <br />© {new Date().getFullYear()} Microgenesis. All rights reserved.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}