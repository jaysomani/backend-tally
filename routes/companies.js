// routes/companies.js
const express = require('express');
const router = express.Router();
const companiesController = require('../controllers/companiesController');

router.get('/getUserCompanies', companiesController.getUserCompanies);

module.exports = router;
