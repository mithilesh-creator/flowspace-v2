import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';

import { useAuth } from '../context/AuthContext.jsx';

export function Signup() {
  const { session, signUp } = useAuth();
  const location = useLocation();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);

  // Honour `from` so a new user who arrived via an invitation link is
  // returned to it once their account exists.
  if (session) return <Navigate to={location.state?.from ?? '/boards'} replace />;

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const { data, error: signUpError } = await signUp(
      email.trim(),
      password,
      fullName.trim()
    );

    setBusy(false);

    if (signUpError) {
      setError(signUpError.message);
      return;
    }

    // With email confirmation enabled (the Supabase default on hosted
    // projects) signUp returns a user but no session. Local dev usually
    // has it off and signs you straight in, so both paths have to work.
    if (!data.session) setNeedsConfirmation(true);
  }

  if (needsConfirmation) {
    return (
      <div className="screen-centered">
        <div className="card auth-card">
          <h1>Check your email</h1>
          <p className="muted">
            We sent a confirmation link to <strong>{email}</strong>. Open it to
            finish creating your account, then sign in.
          </p>
          <p className="muted">
            <Link to="/login" state={location.state}>
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="screen-centered">
      <form className="card auth-card" onSubmit={handleSubmit}>
        <h1>Create your account</h1>

        <label>
          Full name
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            autoComplete="name"
          />
        </label>

        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>

        <p className="muted">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
