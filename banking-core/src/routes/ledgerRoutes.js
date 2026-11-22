const express = require('express');
const router = express.Router();
const ledgerController = require('../controllers/ledgerController');
const accountController = require('../controllers/accountController');
const adminController = require('../controllers/adminController');
const { requireIdempotencyKey, idempotencyGuard } = require('../middleware/idempotency');
const { authenticate, authorize } = require('../middleware/auth');

// Order matters: authenticate (sets req.user) -> idempotency key check ->
// Redis claim -> the actual handler.
router.post('/transfer', authenticate, requireIdempotencyKey, idempotencyGuard, ledgerController.transferFunds);

// Accounts
router.get('/accounts', authenticate, accountController.list);
router.post('/accounts', authenticate, requireIdempotencyKey, idempotencyGuard, accountController.create);
router.post('/accounts/:accountId/deposit', authenticate, requireIdempotencyKey, idempotencyGuard, accountController.deposit);

// Owner-or-admin is enforced inside the services (method-level RBAC).
router.get('/accounts/:accountId/balance', authenticate, ledgerController.getAccountBalance);
router.get('/accounts/:accountId/transactions', authenticate, accountController.history);

// Helpers for the transfer form
router.get('/directory', authenticate, accountController.lookup);
router.get('/fee-quote', authenticate, accountController.feeQuote);

// Route-level RBAC: only ADMIN tokens get past authorize('ADMIN').
router.get('/admin/fees-balance', authenticate, authorize('ADMIN'), ledgerController.getFeesBalance);
router.get('/admin/integrity', authenticate, authorize('ADMIN'), adminController.integrity);
router.get('/admin/transactions', authenticate, authorize('ADMIN'), adminController.transactions);

module.exports = router;