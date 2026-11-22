const express = require('express');
const router = express.Router();
const recurringController = require('../controllers/recurringController');
const { requireIdempotencyKey, idempotencyGuard } = require('../middleware/idempotency');
const { authenticate, authorize } = require('../middleware/auth');

router.post('/', authenticate, requireIdempotencyKey, idempotencyGuard, recurringController.create);
router.get('/', authenticate, recurringController.list);
router.get('/:id/runs', authenticate, recurringController.runs);
router.delete('/:id', authenticate, recurringController.cancel);
router.post('/admin/run-due', authenticate, authorize('ADMIN'), recurringController.runDueNow);

module.exports = router;