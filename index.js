require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg'); // Using pg for PostgreSQL
const axios = require('axios'); // To communicate with Tally Connector

const app = express();
app.use(cors());
app.use(express.json());

// Create a PostgreSQL connection pool using environment variables
const pool = new Pool({
  host: process.env.DB_HOST, // e.g., your RDS endpoint
  port: process.env.DB_PORT, // typically 5432 for PostgreSQL
  user: process.env.DB_USER,      
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Helper function: Convert email to a safe string for constructing identifiers
const emailToSafeString = (email) => {
  return email.toLowerCase().replace(/[@.]/g, '_');
};

/* 
  ✅ GET /api/getUserCompanies
  Fetch companies associated with the user.
*/
app.get('/api/getUserCompanies', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email query parameter is required' });

    const query = `
      SELECT c.company_id, c.company_name 
      FROM user_companies uc
      JOIN companies c ON uc.company_id = c.company_id
      WHERE uc.user_email = $1
    `;
    const result = await pool.query(query, [email]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching companies:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/* 
  ✅ GET /api/getUserData
  Fetch ledger data for the selected company.
*/
app.get('/api/getUserData', async (req, res) => {
  try {
    const company = req.query.company;
    if (!company) return res.status(400).json({ error: 'Company query parameter is required' });

    const sql = 'SELECT * FROM ledgers WHERE company_id = $1';
    const result = await pool.query(sql, [company]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching ledger data from RDS:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/* 
  ✅ POST /api/uploadExcel
  Upload Excel data and store it in a temporary table.
*/
app.post('/api/uploadExcel', async (req, res) => {
  try {
    const { email, company, data } = req.body;
    if (!email || !company || !data) return res.status(400).json({ error: 'Missing data' });

    const tempTableName = `temporary_ledgers_${emailToSafeString(email)}_${Date.now()}`;

    await pool.query(`CREATE TABLE ${tempTableName} (
      id SERIAL PRIMARY KEY,
      description TEXT,
      closing_balance NUMERIC,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`);

    for (const row of data) {
      await pool.query(`INSERT INTO ${tempTableName} (description, closing_balance) VALUES ($1, $2)`, 
      [row.description, row.closing_balance]);
    }

    res.json({ message: "Excel data stored temporarily", table: tempTableName });
  } catch (err) {
    console.error('Error uploading Excel data:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/* 
  ✅ GET /api/tempLedgers
  Fetch temporary ledger data for review.
*/
app.get('/api/tempLedgers', async (req, res) => {
  try {
    const { tempTable } = req.query;
    if (!tempTable) return res.status(400).json({ error: 'Temp table name required' });

    const result = await pool.query(`SELECT * FROM ${tempTable}`);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching temporary data:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/* 
  ✅ GET /api/getBankDetails
  Fetch distinct bank details (bank names) from the ledger table,
  extracting the "BankAccounts" key from the extra_data JSON column.
*/
app.get('/api/getBankNames', async (req, res) => {
  try {
    const company = req.query.company;
    if (!company) return res.status(400).json({ error: 'Company query parameter is required' });
    
    const sql = `
      SELECT DISTINCT l.description AS bank_name
      FROM ledgers l
      WHERE l.company_id = $1
      AND l.extra_data->>'PARENT' = 'Bank Accounts'
    `;
    
    const result = await pool.query(sql, [company]);
    res.json({ bank_names: result.rows.map(row => row.bank_name) });
  } catch (err) {
    console.error('Error fetching bank names:', err.message);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});




/* 
  ✅ POST /api/saveData
  Save reviewed ledger data from the temporary table to the actual ledgers table.
*/
app.post('/api/saveData', async (req, res) => {
  try {
    const { company, tempTable } = req.body;
    if (!company || !tempTable) return res.status(400).json({ error: 'Missing data' });

    await pool.query(`INSERT INTO ledgers (company_id, description, closing_balance, timestamp)
      SELECT $1, description, closing_balance, timestamp FROM ${tempTable}`, [company]);

    await pool.query(`DROP TABLE ${tempTable}`);
    res.json({ message: "Data saved successfully" });
  } catch (err) {
    console.error('Error saving data:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/* 
  ✅ POST /api/sendToTally
  Send ledger data to the Tally Connector.
*/
app.post('/api/sendToTally', async (req, res) => {
  try {
    const { company } = req.body;
    if (!company) return res.status(400).json({ error: 'Company required' });

    const result = await pool.query(`SELECT description, closing_balance FROM ledgers WHERE company_id = $1`, [company]);
    if (result.rows.length === 0) return res.status(404).json({ error: "No data found" });

    const response = await axios.post('http://127.0.0.1:5000/api/tallyConnector', {
      company,
      ledgers: result.rows
    });

    res.json({ message: "Data sent to Tally successfully", tallyResponse: response.data });
  } catch (err) {
    console.error('Error sending data to Tally:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* 
  ✅ POST /api/tallyConnector
  Endpoint where Tally Connector receives the data and processes it for Tally ERP.
*/
app.post('/api/tallyConnector', async (req, res) => {
  try {
    const { company, ledgers } = req.body;
    if (!company || !ledgers) return res.status(400).json({ error: 'Missing data' });

    // Logic to process and send data to Tally ERP via XML (Implementation in Tally Connector)
    console.log("Processing data for Tally:", { company, ledgers });

    res.json({ message: "Tally Connector received the data successfully" });
  } catch (err) {
    console.error('Error processing Tally data:', err);
    res.status(500).json({ error: 'Tally processing error' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
