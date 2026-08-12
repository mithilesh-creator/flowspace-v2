import { useState } from 'react';

import { useOrg } from '../context/OrgContext.jsx';

function slugify(value) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

/**
 * Shown when a signed-in user belongs to no workspace — the minimal
 * onboarding path. A user with no tenant has nothing to look at, so this
 * is a full-screen step rather than an empty state.
 */
export function CreateOrg({ email, onSignOut }) {
  const { createOrg } = useOrg();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const effectiveSlug = slugTouched ? slug : slugify(name);

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await createOrg({ name: name.trim(), slug: effectiveSlug });
    } catch (err) {
      setError(err.message);
    } finally {
      // Not skipped on success: createOrg refreshes the org list, and if
      // that refresh fails the component stays mounted. Leaving busy set
      // would strand the form with no way to retry.
      setBusy(false);
    }
  }

  return (
    <div className="screen-centered">
      <form className="card auth-card" onSubmit={handleSubmit}>
        <h1>Create your workspace</h1>
        <p className="muted">
          Signed in as {email}. Every board, member and card lives inside a
          workspace.
        </p>

        <label>
          Workspace name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Northwind Studio"
            required
          />
        </label>

        <label>
          URL slug
          <input
            type="text"
            value={effectiveSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(slugify(e.target.value));
            }}
            pattern="[a-z0-9][a-z0-9\-]{0,46}[a-z0-9]"
            placeholder="northwind-studio"
            required
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={busy || !name.trim() || !effectiveSlug}>
          {busy ? 'Creating…' : 'Create workspace'}
        </button>

        <p className="muted">
          <button type="button" className="link" onClick={onSignOut}>
            Sign out
          </button>
        </p>
      </form>
    </div>
  );
}
