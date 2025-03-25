// app.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Import routes
const companiesRoutes = require('./routes/companies');
const ledgerRoutes = require('./routes/ledger');
const transactionsRoutes = require('./routes/transactions');
const tallyRoutes = require('./routes/tally');

// Mount routes under the /api path
app.use('/api', companiesRoutes);
app.use('/api', ledgerRoutes);
app.use('/api', transactionsRoutes);
app.use('/api', tallyRoutes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
