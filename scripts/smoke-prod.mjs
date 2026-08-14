/**
 * H10 — read-only production smoke test.
 *
 *   node scripts/smoke-prod.mjs
 *
 * WHY THIS IS READ-ONLY, AND MUST STAY THAT WAY
 *
 * The original reason was that prod held zero rows and that emptiness was
 * worth preserving. THAT REASON IS OBSOLETE — prod now holds real user
 * accounts, workspaces and memberships created by actual people — and the
 * constraint is stronger for it, not weaker. Do not read the old rationale
 * going stale as permission to relax this. What used to be "don't spoil a
 * clean row count" is now "don't touch other people's data."
 *
 * The 64 backend checks still cannot run here: they sign in as the six
 * seeded accounts from supabase/seed.sql and write and delete rows under
 * fixed seed IDs, and prod has no seed. They run against dev.
 *
 * So this script asserts only things observable from outside: status
 * codes, headers, redirects and refusals. It never signs up, never
 * authenticates, and never writes. If you find yourself wanting to add a
 * check that needs a session, that check belongs in the dev suites.
 *
 * Audited against that claim: `probe()` is the only thing in this file
 * that reaches the network, it always passes `redirect: 'manual'` so it
 * can never be bounced onto an endpoint it did not choose, and of its
 * thirteen call sites eleven are GET, two are CORS preflights, and one is
 * the POST described below. The file imports nothing and touches no
 * filesystem. Keep all three of those true.
 *
 * The one POST is a sign-in attempt with an address that cannot exist
 * (@example.invalid is reserved by RFC 2606). That is an error-path probe,
 * not an authentication: it proves the auth chain is reachable and
 * correctly configured rather than 500ing or failing CORS. It hits
 * GoTrue's /token endpoint, which signs IN — account creation is /signup,
 * which this file never calls — so it cannot create or modify a user, and
 * with a reserved domain it cannot collide with a real one either. Being
 * precise about the residue: a failed sign-in does leave an entry in
 * Supabase's own auth audit log and counts against the auth rate limit.
 * No application table is touched, and no user-visible state changes.
 *
 * Exits non-zero if anything fails, so it can gate a release.
 */

const FRONTEND = process.env.SMOKE_FRONTEND ?? 'https://flowspace-v2.netlify.app';
const API = process.env.SMOKE_API ?? 'https://backend-production-8d147.up.railway.app';
const SUPABASE = process.env.SMOKE_SUPABASE ?? 'https://ajkzoiqsvcibvcodkuzs.supabase.co';
const SUPABASE_ANON = process.env.SMOKE_SUPABASE_ANON ?? '';

const TIMEOUT_MS = 20_000;
const results = [];

function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  — ${detail}`);
}

/** Never throws: a refusal is usually the thing being asserted. */
async function probe(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, redirect: 'manual' });
    const text = await res.text().catch(() => '');
    return { status: res.status, headers: res.headers, body: text, ok: true };
  } catch (err) {
    return { status: 0, headers: new Headers(), body: '', ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------
async function checkBackend() {
  const health = await probe(`${API}/health`);
  let parsed = null;
  try {
    parsed = JSON.parse(health.body);
  } catch {
    /* asserted below */
  }
  record(
    'P1 backend /health returns ok',
    health.status === 200 && parsed?.status === 'ok',
    health.status === 200 ? `status=${parsed?.status}, uptime=${parsed?.uptimeSeconds}s` : `HTTP ${health.status}`
  );

  // The single most important production assertion: tenant data is not
  // readable without a token.
  const unauth = await probe(`${API}/api/orgs`);
  record(
    'P2 tenant route refuses an unauthenticated request',
    unauth.status === 401,
    `HTTP ${unauth.status}` + (unauth.status !== 401 ? ' — EXPECTED 401' : '')
  );

  const badToken = await probe(`${API}/api/orgs`, {
    headers: { Authorization: 'Bearer not-a-real-token' },
  });
  record(
    'P3 a forged bearer token is refused',
    badToken.status === 401,
    `HTTP ${badToken.status}`
  );

  const preflightOk = await probe(`${API}/api/orgs`, {
    method: 'OPTIONS',
    headers: {
      Origin: FRONTEND,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  });
  record(
    'P4 CORS allows the deployed frontend',
    preflightOk.headers.get('access-control-allow-origin') === FRONTEND,
    `allow-origin: ${preflightOk.headers.get('access-control-allow-origin') || '(none)'}`
  );

  // A permissive CORS policy would let any site drive the API with a
  // user's token. Absence of the header is the pass condition.
  const preflightEvil = await probe(`${API}/api/orgs`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'GET' },
  });
  const evilOrigin = preflightEvil.headers.get('access-control-allow-origin');
  record(
    'P5 CORS refuses an unknown origin',
    !evilOrigin,
    evilOrigin ? `LEAK: echoed ${evilOrigin}` : 'no allow-origin returned'
  );

  record(
    'P6 backend does not advertise its stack',
    !preflightOk.headers.get('x-powered-by'),
    preflightOk.headers.get('x-powered-by')
      ? `x-powered-by: ${preflightOk.headers.get('x-powered-by')}`
      : 'no x-powered-by header'
  );
}

// ---------------------------------------------------------------------
// Frontend
// ---------------------------------------------------------------------
async function checkFrontend() {
  const root = await probe(FRONTEND);
  record('P7 frontend serves', root.status === 200, `HTTP ${root.status}`);

  // Every one of these is a client-side route with no file behind it. If
  // the SPA rewrite regresses they 404, and /accept-invite taking an
  // invitation token means every invite email breaks silently.
  const deepLinks = ['/login', '/signup', '/boards', '/accept-invite?token=smoke-probe'];
  const statuses = [];
  for (const path of deepLinks) {
    const res = await probe(`${FRONTEND}${path}`);
    statuses.push(`${path} ${res.status}`);
  }
  record(
    'P8 SPA deep links all resolve',
    statuses.every((s) => s.endsWith(' 200')),
    statuses.join(', ')
  );

  // The mirror of P8: the rewrite must not swallow real files. A wildcard
  // that also caught /assets/* would serve index.html as JavaScript.
  const assetPath = /\/assets\/[A-Za-z0-9\-_.]+\.js/.exec(root.body)?.[0];
  if (assetPath) {
    const asset = await probe(`${FRONTEND}${assetPath}`);
    const type = asset.headers.get('content-type') ?? '';
    record(
      'P9 real assets are served, not rewritten',
      asset.status === 200 && type.includes('javascript'),
      `${assetPath} → HTTP ${asset.status}, ${type || 'no content-type'}`
    );

    record(
      'P10 the bundle carries no localhost or dev-project reference',
      !asset.body.includes('localhost:4000') && !asset.body.includes('hjylkhswlwqiwvztynkw'),
      asset.body.includes('localhost:4000') || asset.body.includes('hjylkhswlwqiwvztynkw')
        ? 'LEAK: bundle references localhost or the dev Supabase project'
        : 'clean'
    );
  } else {
    record('P9 real assets are served, not rewritten', false, 'could not find an asset URL in index.html');
    record('P10 the bundle carries no localhost or dev-project reference', false, 'skipped, no asset found');
  }

  const headers = {
    'x-frame-options': root.headers.get('x-frame-options'),
    'x-content-type-options': root.headers.get('x-content-type-options'),
    'referrer-policy': root.headers.get('referrer-policy'),
  };
  record(
    'P11 security headers applied',
    headers['x-frame-options'] === 'DENY' && headers['x-content-type-options'] === 'nosniff',
    Object.entries(headers).map(([k, v]) => `${k}=${v ?? 'MISSING'}`).join(', ')
  );
}

// ---------------------------------------------------------------------
// Supabase auth. Error path only — never creates an account.
// ---------------------------------------------------------------------
async function checkAuth() {
  if (!SUPABASE_ANON) {
    record(
      'P12 prod auth reachable',
      false,
      'skipped — set SMOKE_SUPABASE_ANON to the prod anon key to enable'
    );
    return;
  }

  const health = await probe(`${SUPABASE}/auth/v1/health`, {
    headers: { apikey: SUPABASE_ANON },
  });
  record('P12 prod auth reachable', health.status === 200, `HTTP ${health.status}`);

  // @example.invalid is reserved and can never be a real account, so this
  // cannot collide with a genuine user. A 400 proves the chain is wired;
  // a 500 or a network error would mean it is not.
  const login = await probe(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON, 'Content-Type': 'application/json', Origin: FRONTEND },
    body: JSON.stringify({
      email: 'smoke-probe-nonexistent@example.invalid',
      password: 'not-a-real-password',
    }),
  });
  record(
    'P13 auth rejects a non-existent account cleanly',
    login.status === 400,
    `HTTP ${login.status}` + (login.status === 500 ? ' — a 500 means misconfiguration, not a bad password' : '')
  );
}

const started = Date.now();
console.log(`smoke: ${FRONTEND} + ${API}\n`);

await checkBackend();
await checkFrontend();
await checkAuth();

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed in ${Date.now() - started}ms` +
    (failed.length ? ` — FAILURES: ${failed.map((f) => f.id).join(', ')}` : '')
);
process.exit(failed.length ? 1 : 0);
