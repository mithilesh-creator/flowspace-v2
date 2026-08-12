import { Navigate, useLocation } from 'react-router-dom';

import { useAuth } from '../context/AuthContext.jsx';

export function ProtectedRoute({ children }) {
  const { session, loading } = useAuth();
  const location = useLocation();

  // Render nothing rather than redirecting while the session is still
  // being restored — otherwise a page refresh bounces a signed-in user to
  // /login for a frame before snapping back.
  if (loading) {
    return <div className="screen-centered muted">Loading…</div>;
  }

  if (!session) {
    // pathname + search, not pathname alone: an invitation link carries
    // its token in the query string, and dropping it here would send the
    // invitee to an empty /accept-invite after they sign in.
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  return children;
}
