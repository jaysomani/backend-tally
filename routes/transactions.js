// routes/transactions.js
const express = require('express');
const router = express.Router();
const transactionsController = require('../controllers/transactionsController');

router.post('/uploadExcel', transactionsController.uploadExcel);
router.post('/deleteTransaction', transactionsController.deleteTransaction);
router.get('/getAllTempTables', transactionsController.getAllTempTables);
router.get('/getTempTable', transactionsController.getTempTable);
router.post('/updateTempExcel', transactionsController.updateTempExcel);
router.get('/tempLedgers', transactionsController.getTempLedgers);

module.exports = router;
