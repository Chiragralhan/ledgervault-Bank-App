const demoService = require('../services/demoService');
const { sendError } = require('../utils/httpErrors');

// POST /api/demo/race  { mode: "safe" | "unsafe", attempts?, amountPaise?, affordable? }
async function race(req, res) {
  try {
    res.json(await demoService.runRace(req.user, req.body));
  } catch (err) {
    sendError(err, res);
  }
}

module.exports = { race };