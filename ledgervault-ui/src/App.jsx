import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Send from './pages/Send';
import Statement from './pages/Statement';
import Recurring from './pages/Recurring';
import RaceDemo from './pages/RaceDemo';
import Admin from './pages/Admin';

// Only logged-in users get past this. Everyone else goes to /login.
function RequireAuth({ children }) {
  const { user, checking } = useAuth();
  if (checking) return <div className="center muted">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function RequireAdmin({ children }) {
  const { user } = useAuth();
  return user && user.role === 'ADMIN' ? children : <Navigate to="/" replace />;
}

function LoginRoute() {
  const { user, checking } = useAuth();
  if (checking) return <div className="center muted">Loading…</div>;
  return user ? <Navigate to="/" replace /> : <Login />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginRoute />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<Dashboard />} />
            <Route path="/send" element={<Send />} />
            <Route path="/statement" element={<Statement />} />
            <Route path="/statement/:accountId" element={<Statement />} />
            <Route path="/recurring" element={<Recurring />} />
            <Route path="/race" element={<RaceDemo />} />
            <Route
              path="/admin"
              element={
                <RequireAdmin>
                  <Admin />
                </RequireAdmin>
              }
            />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}