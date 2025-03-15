require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg'); // Using pg for PostgreSQL
const axios = require('axios'); // Communicate with Tally Connector

const app = express();
app.use(cors());
app.use(express.json());

// Create a PostgreSQL connection pool
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: {
    rejectUnauthorized: false
  }
});

// Helper: Convert email to a safe string
const emailToSafeString = (email) => {
  return email.toLowerCase().replace(/[@.]/g, '_');
};

// Helper: Convert DD/MM/YYYY -> YYYY-MM-DD
const convertDate = (dateStr) => {
  if (!dateStr) return null;
  const parts = dateStr.split('/');
  if (parts.length !== 3) return dateStr; // if unexpected format
  return `${parts[2]}-${parts[1]}-${parts[0]}`;
};

// Add this helper function
function formatCompanyName(companyName) {
  return companyName
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/* 
  GET /api/getUserCompanies
  Return companies for this user.
*/
app.get('/api/getUserCompanies', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    const query = 
      `SELECT c.company_id, c.company_name 
       FROM user_companies uc
       JOIN companies c ON uc.company_id = c.company_id
       WHERE uc.user_email = $1`;
    const result = await pool.query(query, [email]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching companies:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/* 
  GET /api/getUserData
  Return ledger data for the selected company. (Used to populate ledgerOptions.)
*/
app.get('/api/getUserData', async (req, res) => {
  try {
    const company = req.query.company;
    if (!company) {
      return res.status(400).json({ error: 'Company is required' });
    }
    const sql = 'SELECT * FROM ledgers WHERE company_id = $1';
    const result = await pool.query(sql, [company]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching ledger data:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/* 
  GET /api/getBankNames
  Return distinct bank names for the selected company.
*/
app.get('/api/getBankNames', async (req, res) => {
  try {
    const company = req.query.company;
    if (!company) {
      return res.status(400).json({ error: 'Company is required' });
    }
    const sql = 
      `SELECT DISTINCT l.description AS bank_name
       FROM ledgers l
       WHERE l.company_id = $1
         AND l.extra_data->>'PARENT' = 'Bank Accounts'`;
    const result = await pool.query(sql, [company]);
    res.json({ bank_names: result.rows.map((row) => row.bank_name) });
  } catch (err) {
    console.error('Error fetching bank names:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/* 
  POST /api/uploadExcel
  Create (if needed) a single deterministic temp table for (user + company).
  Then insert new Excel rows WITHOUT deleting the old ones.
*/
app.post('/api/uploadExcel', async (req, res) => {
  try {
    const { email, company, bankAccount, data, fileName } = req.body;
    if (!email || !company || !bankAccount || !data) {
      return res.status(400).json({ error: 'Missing email, company, bankAccount, or data' });
    }

    // Create a unique table name using email, company, bank account, and file name.
    const safeEmail = emailToSafeString(email);
    const safeCompany = company.toLowerCase().replace(/\s+/g, '_');
    const safeBank = bankAccount.toLowerCase().replace(/\s+/g, '_');
    const safeFileName = fileName ? fileName.toLowerCase().replace(/[^a-z0-9]/g, '_') : 'uploaded_file';
    const tempTableName = `temporary_transactions_${safeEmail}_${safeCompany}_${safeBank}_${safeFileName}`;

    // Create the new temp table if it doesn't already exist
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${tempTableName} (
          id SERIAL PRIMARY KEY,
          email TEXT NOT NULL,
          company TEXT NOT NULL,
          bank_account TEXT NOT NULL,
          transaction_date DATE,
          transaction_type TEXT CHECK (transaction_type IN ('payment', 'receipt', 'contra withdraw', 'contra deposit')),
          description TEXT NOT NULL,
          amount NUMERIC,
          assigned_ledger TEXT NOT NULL,
          status TEXT DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
       )`
    );

    // Insert each row from the uploaded Excel file into the temp table
    for (const row of data) {
      const convertedDateStr = convertDate(row.transaction_date);
      const jsDate = convertedDateStr ? new Date(convertedDateStr) : null;

      await pool.query(
        `INSERT INTO ${tempTableName}
         (email, company, bank_account, transaction_date, transaction_type, description, amount, assigned_ledger)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          email,
          company,
          bankAccount,
          jsDate,
          row.transaction_type || null,
          row.description,
          row.amount,
          row.assignedLedger || ''
        ]
      );
    }

    // Upsert mapping into user_temp_tables (parameters passed correctly as a separate argument)
    await pool.query(
      `INSERT INTO user_temp_tables (email, company, temp_table, uploaded_file)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email, company) DO UPDATE
          SET temp_table = EXCLUDED.temp_table,
              uploaded_file = EXCLUDED.uploaded_file,
              created_at = CURRENT_TIMESTAMP`,
      [email, company, tempTableName, fileName]
    );

    const rowsInserted = await pool.query(`SELECT * FROM ${tempTableName}`);
    console.log(`Now have ${rowsInserted.rowCount} total rows in ${tempTableName}`);

    res.json({
      message: 'Excel data stored/updated in temp table',
      table: tempTableName,
    });
  } catch (err) {
    console.error('Error in /api/uploadExcel:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/deleteTransaction', async (req, res) => {
  try {
    const { tempTable, transactionId } = req.body;
    if (!tempTable || !transactionId) {
      return res.status(400).json({ error: 'Missing tempTable or transactionId' });
    }
    // Delete the transaction from the specified temp table
    await pool.query(`DELETE FROM ${tempTable} WHERE id = $1`, [transactionId]);
    res.json({ message: 'Transaction deleted successfully' });
  } catch (err) {
    console.error('Error in /api/deleteTransaction:', err);
    res.status(500).json({ error: 'Database error' });
  }
});





app.get('/api/getTempTable', async (req, res) => {
  try {
    const { email, company } = req.query;
    if (!email || !company) {
      return res.status(400).json({ error: 'Missing email or company' });
    }
    const result = await pool.query(
      `SELECT temp_table, uploaded_file FROM user_temp_tables WHERE email = $1 AND company = $2`,
      [email, company]
    );
    if (result.rows.length === 0) {
      return res.json({});
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching temp table info:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/*
  POST /api/updateTempExcel
  Called from handleSaveUpdates in the React code.
  We replace the existing table rows with the new data the user just edited.
*/
app.post('/api/updateTempExcel', async (req, res) => {
  try {
    const { email, company, bankAccount, data } = req.body;
    if (!email || !company || !bankAccount || !data) {
      return res
        .status(400)
        .json({ error: 'Missing email, company, bankAccount, or data' });
    }

    const tempTableName = `temporary_transactions_${emailToSafeString(email)}_${company}`;

    // Make sure table exists
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${tempTableName} (
          id SERIAL PRIMARY KEY,
          email TEXT NOT NULL,
          company TEXT NOT NULL,
          bank_account TEXT NOT NULL,
          transaction_date DATE,
          transaction_type TEXT CHECK (transaction_type IN ('payment', 'receipt', 'contra withdraw', 'contra deposit')),
          description TEXT NOT NULL,
          amount NUMERIC,
          assigned_ledger TEXT NOT NULL,
          status TEXT DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
       )`
    );

    // Remove all existing rows so we can replace them
    await pool.query(`DELETE FROM ${tempTableName}`);

    // Insert the updated data
    for (const row of data) {
      const convertedDateStr = convertDate(row.transaction_date);
      const jsDate = convertedDateStr ? new Date(convertedDateStr) : null;

      await pool.query(
        `INSERT INTO ${tempTableName}
         (email, company, bank_account, transaction_date, transaction_type, description, amount, assigned_ledger)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          email,
          company,
          bankAccount,
          jsDate,
          row.transaction_type || null,
          row.description,
          row.amount,
          row.assignedLedger || ''
        ]
      );
    }

    res.json({ message: 'Updated rows in temp table', table: tempTableName });
  } catch (err) {
    console.error('Error in /api/updateTempExcel:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/* 
  GET /api/tempLedgers
  Return all rows from the user's temp table.
*/
app.get('/api/tempLedgers', async (req, res) => {
  try {
    const { tempTable } = req.query;
    if (!tempTable) {
      return res.status(400).json({ error: 'tempTable is required' });
    }
    const result = await pool.query(`SELECT * FROM ${tempTable}`);
    res.json(result.rows);
  } catch (err) {
    console.error('Error in /api/tempLedgers:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/*
  POST /api/sendToTally
  Send data from temp table to Tally through tally_connector
*/
app.post('/api/sendToTally', async (req, res) => {
  try {
    const { company, tempTable, selectedTransactions } = req.body;
    if (!company || !tempTable) {
      return res.status(400).json({ error: 'Missing company or tempTable' });
    }

    // Format company name properly before sending
    const formattedCompany = formatCompanyName(company);
    let result;
    if (selectedTransactions && selectedTransactions.length > 0) {
      result = await pool.query(
        `SELECT * FROM ${tempTable} 
         WHERE assigned_ledger IS NOT NULL 
           AND assigned_ledger != ''
           AND id = ANY($1)
         ORDER BY transaction_date`,
        [selectedTransactions]
      );
    } else {
      result = await pool.query(
        `SELECT * FROM ${tempTable} 
         WHERE assigned_ledger IS NOT NULL 
           AND assigned_ledger != ''
         ORDER BY transaction_date`
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No transactions found with assigned ledgers' });
    }

    // Transform data for Tally
    const transformedData = result.rows.map(row => ({
      id: row.id,
      transaction_date: row.transaction_date ? row.transaction_date.toISOString().split('T')[0] : null,
      transaction_type: row.transaction_type?.toLowerCase() || '',
      description: row.description?.trim() || '',
      amount: Math.abs(parseFloat(row.amount || 0)),
      bank_account: row.bank_account?.trim(),
      assigned_ledger: row.assigned_ledger?.trim()
    }));

    // Validate transformed data
    const invalidTransactions = transformedData.filter(
      trans => !trans.transaction_date || !trans.bank_account || !trans.assigned_ledger || !trans.amount
    );

    if (invalidTransactions.length > 0) {
      return res.status(400).json({
        error: 'Some transactions have invalid data',
        invalidTransactions
      });
    }

    console.log('Sending to tally_connector:', {
      company: formattedCompany,
      transactionCount: transformedData.length,
      sampleTransaction: transformedData[0]
    });

    // Send data to Tally connector
    try {
      const response = await axios.post('http://localhost:5000/api/tallyConnector', {
        company: formattedCompany,
        data: transformedData
      });

      // After sending successfully, update the status of the sent transactions to "sent"
      if (selectedTransactions && selectedTransactions.length > 0) {
        await pool.query(
          `UPDATE ${tempTable} SET status = 'sent' WHERE id = ANY($1)`,
          [selectedTransactions]
        );
      } else {
        await pool.query(
          `UPDATE ${tempTable} SET status = 'sent' WHERE assigned_ledger IS NOT NULL AND assigned_ledger != ''`
        );
      }

      return res.json({
        message: 'Data sent to Tally successfully',
        transactionsSent: transformedData.length,
        tallyResponse: response.data
      });
    } catch (axiosError) {
      console.error('Tally connector error:', axiosError.response?.data || axiosError.message);
      return res.status(500).json({
        error: 'Failed to send data to Tally connector',
        details: axiosError.response?.data || axiosError.message
      });
    }
  } catch (err) {
    console.error('Error in /api/sendToTally:', err);
    res.status(500).json({ 
      error: 'Server error',
      details: err.message 
    });
  }
});

/*
  (Optional) Tally Connector endpoint
*/
app.post('/api/tallyConnector', async (req, res) => {
  try {
    const { company, data } = req.body;
    if (!company || !data) {
      return res.status(400).json({ error: 'Missing data' });
    }
    console.log('Processing data for Tally:', { company, data });
    res.json({ message: 'Tally Connector received the data successfully' });
  } catch (err) {
    console.error('Error processing Tally data:', err);
    res.status(500).json({ error: 'Tally processing error' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
