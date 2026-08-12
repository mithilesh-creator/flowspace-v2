import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';

/**
 * Redeems an invitation link.
 *
 * Reached only through ProtectedRoute, so the invitee has already signed
 * up or signed in and we have a session to attach the membership to.
 * That ordering matters: the invitation is bound to an email address,
 * and the server compares it against the *session's* profile — so the
 * person clicking a forwarded link cannot redeem someone else's invite.
 */
export function AcceptInvite() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { accessToken, user } = useAuth();

  const token = params.get('token');
  const [status, setStatus] = useState('working');
  const [error, setError] = useState(null);

  // React 18 StrictMode double-invokes effects in dev. Redeeming twice
  // would fail the second time ("already been used") and show an error
  // for an invitation that in fact just succeeded.
  const attempted = useRef(false);

  useEffect(() => {
    if (!accessToken || attempted.current) return;

    if (!token) {
      setStatus('error');
      setError('This invitation link is missing its token.');
      return;
    }

    attempted.current = true;

    api
      .acceptInvitation(accessToken, token)
      .then(() => {
        setStatus('done');
        setTimeout(() => navigate('/boards', { replace: true }), 1200);
      })
      .catch((err) => {
        setStatus('error');
        setError(err.message);
      });
  }, [accessToken, token, navigate]);

  return (
    <div className="screen-centered">
      <div className="card auth-card">
        {status === 'working' && (
          <>
            <h1>Joining workspace…</h1>
            <p className="muted">Redeeming your invitation as {user?.email}.</p>
          </>
        )}

        {status === 'done' && (
          <>
            <h1>You're in</h1>
            <p className="muted">Taking you to the workspace…</p>
          </>
        )}

        {status === 'error' && (
          <>
            <h1>Could not join</h1>
            <p className="error">{error}</p>
            <p className="muted">
              Invitations are tied to the email they were sent to, and expire
              after 7 days. You are signed in as <strong>{user?.email}</strong> —
              if the invitation went to a different address, sign out and sign
              in with that one.
            </p>
            <p className="muted">
              <Link to="/boards">Go to your workspaces</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
