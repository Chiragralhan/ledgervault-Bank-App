// Minimal CORS so the React front end (running on another port) can call
// this API from the browser. Browsers send a "preflight" OPTIONS request
// first for any request with a custom header like Authorization or
// Idempotency-Key, so we answer that too.
//
// Allowed origins come from CORS_ORIGINS (comma separated); the defaults are
// the usual Vite / Create-React-App dev servers.
const allowed = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3001,http://localhost:3002')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function cors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
}

module.exports = cors;