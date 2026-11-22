import { useEffect, useState } from 'react';
import { getSession, refreshTokens, tokenExpiryMs } from '../api';

function formatCountdown(ms) {
  if (ms <= 0) return 'expired';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

// Small card showing the access-token countdown and a manual refresh.
export default function SessionPanel() {
  const [now, setNow] = useState(() => Date.now());
  const [message, setMessage] = useState('');
  const [, force] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const session = getSession();
  const expiry = session ? tokenExpiryMs(session.accessToken) : null;
  const left = expiry ? expiry - now : null;

  async function handleRefresh() {
    setMessage('');
    try {
      await refreshTokens();
      setMessage('New access token AND new refresh token issued (the old refresh token is now dead).');
    } catch (err) {
      setMessage(`Refresh failed: ${err.message}`);
    }
    force((n) => n + 1);
  }

  return (
    <section className="card">
      <div className="stat-row">
        <div>
          <div className="muted small">Your login session: access token expires in</div>
          <div className={`mid ${left !== null && left < 60000 ? 'warn' : ''}`}>
            {left === null ? '—' : formatCountdown(left)}
          </div>
        </div>
        <button className="btn" onClick={handleRefresh}>
          Refresh tokens now
        </button>
      </div>
      {message && <div className="note">{message}</div>}
    </section>
  );
}