const ledgerService = require('../services/ledgerService');

// Maps the service-layer error classes to HTTP status codes, so every
// controller answers errors the same way.
function sendError(err, res) {
  if (err instanceof ledgerService.ValidationError) {
    return res.status(400).json({ error: err.message });
  }
  if (err instanceof ledgerService.ForbiddenError) {
    return res.status(403).json({ error: err.message });
  }
  if (err instanceof ledgerService.AccountNotFoundError) {
    return res.status(404).json({ error: err.message });
  }
  console.error(err);
  return res.status(500).json({ error: 'Request failed' });
}

module.exports = { sendError };