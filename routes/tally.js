// routes/tally.js
const express = require('express');
const router = express.Router();
const tallyController = require('../controllers/tallyController');

router.get('/tallyTransactions', tallyController.getTallyTransactions);
router.post('/sendToTally', tallyController.sendToTally);
router.post('/tallyConnector', tallyController.tallyConnector);

module.exports = router;
