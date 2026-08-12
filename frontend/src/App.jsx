import { Navigate, Route, Routes } from 'react-router-dom';

import { ProtectedRoute } from './components/ProtectedRoute.jsx';
import { OrgProvider } from './context/OrgContext.jsx';
import { AcceptInvite } from './routes/AcceptInvite.jsx';
import { Board } from './routes/Board.jsx';
import { Boards } from './routes/Boards.jsx';
import { Login } from './routes/Login.jsx';
import { Signup } from './routes/Signup.jsx';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />

      {/* OrgProvider sits inside ProtectedRoute so it never fires a
          request without a session to attach. */}
      <Route
        path="/boards"
        element={
          <ProtectedRoute>
            <OrgProvider>
              <Boards />
            </OrgProvider>
          </ProtectedRoute>
        }
      />

      {/* The board detail view needs the same org context: which workspace
          is active decides the :orgId every list/card call is scoped to. */}
      <Route
        path="/boards/:boardId"
        element={
          <ProtectedRoute>
            <OrgProvider>
              <Board />
            </OrgProvider>
          </ProtectedRoute>
        }
      />

      {/* Outside OrgProvider on purpose: accepting an invitation changes
          which orgs exist for this user, so the provider should mount
          fresh on /boards afterwards rather than hold a stale list. */}
      <Route
        path="/accept-invite"
        element={
          <ProtectedRoute>
            <AcceptInvite />
          </ProtectedRoute>
        }
      />

      <Route path="*" element={<Navigate to="/boards" replace />} />
    </Routes>
  );
}
