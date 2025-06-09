// server.js
require('dotenv').config();

// ENV DEBUG LOGGING
console.log('BREVO_SMTP_USER:', process.env.BREVO_SMTP_USER);
console.log('BREVO_SMTP_PASS:', process.env.BREVO_SMTP_PASS ? '[HIDDEN]' : '[MISSING]');

const express       = require('express');
const session       = require('express-session');
const SQLiteStore   = require('connect-sqlite3')(session);
const nodemailer    = require('nodemailer');
const cors          = require('cors');
const bodyParser    = require('body-parser');
const path          = require('path');
const db            = require('./db');

const app    = express();
const PORT   = process.env.PORT || 10000;
const isProd = process.env.NODE_ENV === 'production';

const ORIGINS = [
  'http://localhost:5500',
  'https://nimble-pudding-0824c3.netlify.app'
];

app.set('trust proxy', 1);
app.use(cors({
  origin: ORIGINS,
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.options('*', cors());
app.use(bodyParser.json());
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: path.join(__dirname, 'db') }),
  secret: process.env.SESSION_SECRET || 'supersecretkey',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 2
  }
}));

function isAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(403).json({ success: false, message: 'Unauthorized' });
}

app.get('/', (req, res) => {
  res.send('🎉 WakaTV backend is running');
});

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

app.get('/admin/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Logout failed' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true, message: 'Logged out' });
  });
});

const transporter = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.BREVO_SMTP_USER,
    pass: process.env.BREVO_SMTP_PASS
  }
});

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// --- UPDATED /send-code ENDPOINT WITH LOGGING AND ERRORS ---
app.post('/send-code', async (req, res) => {
  try {
    const { email, amount, reference } = req.body;
    console.log('[SEND-CODE] Payload:', req.body);

    if (!email || !amount || !reference) {
      console.log('[SEND-CODE] Missing parameters');
      return res.status(400).json({ success: false, message: 'Missing parameters' });
    }

    const code = generateCode();
    console.log('[SEND-CODE] Sending to:', email, '| Code:', code);

    // Send mail with error diagnostics
    try {
      const info = await transporter.sendMail({
        from: `"WakaTV" <${process.env.BREVO_SMTP_USER}>`,
        to: email,
        subject: 'Your WakaTV Access Code',
        text: `Here is your code: ${code}`
      });
      console.log('[SEND-CODE] Email sent:', info.messageId || info.response || info);
    } catch (mailErr) {
      console.error('[SEND-CODE] Email error:', mailErr);
      return res.status(500).json({ success: false, message: 'Email sending failed', error: mailErr.toString() });
    }

    await db.runAsync(
      `INSERT INTO logs (email, amount, reference) VALUES (?, ?, ?)`,
      [email, amount, reference]
    );
    console.log('[SEND-CODE] Log entry created for:', email);

    res.json({ success: true, message: 'Code sent' });
  } catch (err) {
    console.error('[SEND-CODE] Fatal error:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.toString() });
  }
});

app.get('/admin/logs-data', isAdmin, async (req, res) => {
  try {
    const rows = await db.allAsync(`SELECT * FROM logs ORDER BY timestamp DESC`);
    res.json({ success: true, logs: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/admin/codes', isAdmin, async (req, res) => {
  try {
    const rows = await db.allAsync(`SELECT * FROM codes ORDER BY id`);
    res.json({ success: true, codes: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/admin/upload-codes', isAdmin, async (req, res) => {
  try {
    const { codes } = req.body;
    if (!Array.isArray(codes) || !codes.length) {
      return res.status(400).json({ success: false, message: 'No codes provided' });
    }

    await db.runAsync('BEGIN TRANSACTION');
    for (let code of codes) {
      code = code.trim();
      if (code) {
        await db.runAsync(
          `INSERT OR IGNORE INTO codes (code) VALUES (?)`,
          [code]
        );
      }
    }
    await db.runAsync('COMMIT');

    res.json({ success: true, message: 'Codes uploaded' });
  } catch (err) {
    await db.runAsync('ROLLBACK').catch(() => {});
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
