const adminService = require('../services/adminService');
const { sendError } = require('../utils/httpErrors');

// GET /api/ledger/admin/integrity - are the books balanced?
async function integrity(req, res) {
  try {
    res.json(await adminService.getIntegrityReport());
  } catch (err) {
    sendError(err, res);
  }
}

// GET /api/ledger/admin/transactions - bank-wide activity with all legs
async function transactions(req, res) {
  try {
    res.json(
      await adminService.getRecentTransactions({ limit: req.query.limit, offset: req.query.offset })
    );
  } catch (err) {
    sendError(err, res);
  }
}

module.exports = { integrity, transactions };