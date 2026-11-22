import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';

// The frame around every logged-in page: top bar + navigation.
export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const links = [
    { to: '/', label: 'Dashboard' },
    { to: '/send', label: 'Send money' },
    { to: '/statement', label: 'Statement' },
    { to: '/recurring', label: 'Recurring' },
    { to: '/race', label: 'Race demo' },
  ];
  if (user && user.role === 'ADMIN') links.push({ to: '/admin', label: 'Admin' });

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◆</span> LedgerVault
        </div>
        <nav>
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === '/' || l.to === '/send'}
              className={({ isActive }) => (isActive ? 'active' : '')}
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="who">
          <span>
            {user.name} <span className="pill">{user.role}</span>
          </span>
          <button className="btn ghost" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}