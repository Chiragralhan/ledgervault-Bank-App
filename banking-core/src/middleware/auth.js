const { verifyAccessToken } = require('../utils/jwt');

/** Verifies the access token and attaches { id, role } to req.user. */
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired access token' });
  }
}

/**
 * ROUTE-LEVEL RBAC. Usage: router.get('/admin-only', authenticate, authorize('ADMIN'), handler)
 * This only guards the route it's attached to. It does NOT protect the
 * underlying service/business logic if that function is ever called from
 * somewhere else (another route, a script, a job) - that's what
 * method-level checks inside the service layer are for (see
 * ledgerService.js).
 */
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { authenticate, authorize };