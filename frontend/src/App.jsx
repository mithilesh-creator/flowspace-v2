import { Navigate, Route, Routes } from 'react-router-dom';

import { ProtectedRoute } from './components/ProtectedRoute.jsx';
import { OrgProvider } from './context/OrgContext.jsx';
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

      <Route path="*" element={<Navigate to="/boards" replace />} />
    </Routes>
  );
}
