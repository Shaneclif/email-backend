// server.js

/**
 * WakaTV Email Backend
 * --------------------
 * - Uses absolute paths for SQLite files (avoids SQLITE_CANTOPEN on Render)
 * - Initializes 'logs' & 'codes' tables if they don't exist
 * - Stores Express sessions in SQLite via connect-sqlite3
 * - Remembers that Render's filesystem is ephemeral: DB resets on each deploy unless you mount a disk
 */

require('dotenv').config();

const express       = require('express');
const session       = require('express-session');
const SQLiteStore   = require('connect-sqlite3')(session);
const nodemailer    = require('nodemailer');
const cors          = require('cors');
const bodyParser    = require('body-parser');
const sqlite3       = require('sqlite3').verbose();
const fs            = require('fs');
const path          = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// ----------------------------------------------------------------------------
// 1. Ensure 'db' directory exists for both main DB and session store
// ----------------------------------------------------------------------------
const DB_DIR = path.join(__dirname, 'db');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR);
}

// ----------------------------------------------------------------------------
// 2. Open (or create) the main SQLite database at an absolute path
// ----------------------------------------------------------------------------
const DB_PATH = path.join(DB_DIR, 'wakatv.sqlite');
const db = new sqlite3.Database(DB_PATH, err => {
  if (err) {
    console.error(' Error opening SQLite database:', err);
    process.exit(1);
  }
  console.log(' Connected to SQLite database at', DB_PATH);

  // 2a. Initialize tables if they don't exist
  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      amount INTEGER,
      reference TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE,
      used INTEGER DEFAULT 0,
      usedBy TEXT,
      usedAt DATETIME
    )
  `);
});

// ----------------------------------------------------------------------------
// 3. Middleware
// ----------------------------------------------------------------------------
app.use(cors({
  origin: [
    'http://localhost:5500',
    'https://nimble-pudding-0824c3.netlify.app'
  ],
  credentials: true
}));

// Required to allow cross-site cookies
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});

app.use(bodyParser.json());

// ----------------------------------------------------------------------------
// 4. Session store (connect-sqlite3) configuration
//    - Sessions stored in db/sessions.sqlite
//    - Note: Render’s disk is ephemeral; sessions reset on each deploy
// ----------------------------------------------------------------------------
app.use(session({
  store: new SQLiteStore({
    dir: DB_DIR,
    db: 'sessions.sqlite',
    // you can also set table: 'sessions', // default
  }),
  secret: process.env.SESSION_SECRET || 'supersecretkey',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,    // set true if you serve over HTTPS
    sameSite: 'lax'   // 'none' if you need cross-site in some cases
  }
}));

// ----------------------------------------------------------------------------
// 5. Root health check
// ----------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.send('WakaTV backend is running');
});

// ----------------------------------------------------------------------------
// 6. Admin Authentication
// ----------------------------------------------------------------------------
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    req.session.admin = true;
    return res.json({ success: true, message: 'Logged in' });
  }
  res.status(401).json({ success: false, message: 'Invalid credentials' });
});

function isAdmin(req, res, next) {
  if (req.session?.admin) return next();
  res.status(403).json({ success: false, message: 'Unauthorized' });
}

app.get('/admin/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ success: false, message: 'Logout failed' });
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

// ----------------------------------------------------------------------------
// 7. Nodemailer setup
// ----------------------------------------------------------------------------
const transporter = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.BREVO_SMTP_USER,
    pass: process.env.BREVO_SMTP_PASS
  }
});

// ----------------------------------------------------------------------------
// 8. Helper: generate random 6-char code
// ----------------------------------------------------------------------------
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ----------------------------------------------------------------------------
// 9. Send code & log transaction endpoint
// ----------------------------------------------------------------------------
app.post('/send-code', (req, res) => {
  const { email, amount, reference } = req.body;
  if (!email || !amount || !reference) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  const accessCode = generateCode();
  const mailOptions = {
    from: 'WakaTV <easywakatv@gmail.com>',
    to: email,
    subject: 'Your WakaTV Access Code',
    html: `
      <h2>Thanks for your purchase!</h2>
      <p><strong>Amount Paid:</strong> R${amount}</p>
      <p><strong>Your Access Code:</strong> <code>${accessCode}</code></p>
      <p>Contact support@wakatv.co.za if you need help.</p>
    `
  };

  transporter.sendMail(mailOptions, err => {
    if (err) {
      console.error(' Error sending email:', err);
      return res.status(500).json({ success: false, error: 'Failed to send email' });
    }
    // Log to DB
    db.run(
      'INSERT INTO logs (email, amount, reference) VALUES (?, ?, ?)',
      [email, amount, reference],
      err => { if (err) console.error(' DB log error:', err); }
    );
    res.json({ success: true, message: 'Email sent', code: accessCode });
  });
});

// ----------------------------------------------------------------------------
// 10. Admin API: load logs & codes, upload codes
// ----------------------------------------------------------------------------
// Returns JSON array of logs
app.get('/admin/logs-data', isAdmin, (req, res) => {
  db.all('SELECT * FROM logs ORDER BY id DESC', (err, rows) => {
    if (err) {
      console.error(' Error getting logs:', err);
      return res.status(500).json({ success: false, error: 'Failed to load logs' });
    }
    res.json({ success: true, logs: rows });
  });
});

// Returns JSON array of available codes
app.get('/admin/codes', isAdmin, (req, res) => {
  db.all('SELECT * FROM codes ORDER BY id DESC', (err, rows) => {
    if (err) {
      console.error(' Error getting codes:', err);
      return res.status(500).json({ success: false, error: 'Failed to load codes' });
    }
    res.json({ success: true, codes: rows });
  });
});

// Accepts an array of codes to insert
app.post('/admin/upload-codes', isAdmin, (req, res) => {
  const { codes } = req.body;
  if (!Array.isArray(codes)) {
    return res.status(400).json({ success: false, error: 'Invalid codes format' });
  }
  const stmt = db.prepare('INSERT OR IGNORE INTO codes (code, used) VALUES (?, 0)');
  codes.forEach(c => {
    const code = c.trim();
    if (code) stmt.run(code);
  });
  stmt.finalize();
  res.json({ success: true, message: 'Codes uploaded successfully' });
});

// Optional raw-HTML view of logs for quick debug
app.get('/admin/logs', isAdmin, (req, res) => {
  db.all('SELECT * FROM logs ORDER BY timestamp DESC', (err, rows) => {
    if (err) return res.status(500).send('Error fetching logs');
    res.send(`<html><body><h2>Logs</h2><pre>${JSON.stringify(rows, null, 2)}</pre></body></html>`);
  });
});

// ----------------------------------------------------------------------------
// 11. Start the server
// ----------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', err => {
  if (err) {
    console.error(' Failed to start server:', err);
  } else {
    console.log(` Server running on port ${PORT}`);
  }
});
