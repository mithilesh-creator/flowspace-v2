import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';

import { useAuth } from '../context/AuthContext.jsx';

export function Login() {
  const { session, signIn } = useAuth();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (session) {
    return <Navigate to={location.state?.from ?? '/boards'} replace />;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const { error: signInError } = await signIn(email.trim(), password);

    if (signInError) setError(signInError.message);
    setBusy(false);
  }

  return (
    <div className="screen-centered">
      <form className="card auth-card" onSubmit={handleSubmit}>
        <h1>Sign in to Flowspace</h1>

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
            autoComplete="current-password"
            required
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="muted">
          No account? <Link to="/signup">Create one</Link>
        </p>
      </form>
    </div>
  );
}
