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
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return children;
}
