const express = require('express');
const router = express.Router();
const demoController = require('../controllers/demoController');
const { authenticate } = require('../middleware/auth');

router.post('/race', authenticate, demoController.race);

module.exports = router;