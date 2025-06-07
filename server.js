require('dotenv').config();

const express = require('express');
const session = require('express-session');
const nodemailer = require('nodemailer');
const cors = require('cors');
const bodyParser = require('body-parser');
const db = require('./db');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// ✅ CORS setup
app.use(cors({
  origin: ['http://localhost:5500', 'https://nimble-pudding-0824c3.netlify.app'],
  credentials: true
}));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Credentials", "true");
  next();
});

app.use(bodyParser.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'supersecretkey',
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: false, // true if using HTTPS
    sameSite: 'lax'
  }
}));

// ✅ Root test
app.get('/', (req, res) => {
  res.send('WakaTV backend is running');
});

// ✅ Admin login
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;

  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    req.session.admin = true;
    res.json({ success: true, message: 'Logged in' });
  } else {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
});

// ✅ Middleware to protect admin routes
function isAdmin(req, res, next) {
  if (req.session && req.session.admin) {
    return next();
  } else {
    res.status(403).json({ message: 'Unauthorized' });
  }
}

// ✅ Admin logout
app.get('/admin/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ message: 'Logout failed' });
    res.json({ message: 'Logged out successfully' });
  });
});

// ✅ Nodemailer config
const transporter = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.BREVO_SMTP_USER,
    pass: process.env.BREVO_SMTP_PASS
  }
});

// ✅ Random code generator
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ✅ Send access code and log transaction
app.post('/send-code', (req, res) => {
  const { email, amount, reference } = req.body;

  if (!email || !amount || !reference) {
    return res.status(400).json({ error: 'Missing required fields' });
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
      <p>Enjoy your service. Contact support@wakatv.co.za if you need help.</p>
    `
  };

  transporter.sendMail(mailOptions, (err) => {
    if (err) {
      console.error('Email error:', err);
      return res.status(500).json({ error: 'Failed to send email' });
    }

    db.run(
      `INSERT INTO logs (email, amount, reference) VALUES (?, ?, ?)`,
      [email, amount, reference],
      (err) => {
        if (err) console.error('DB log error:', err);
      }
    );

    res.status(200).json({ message: 'Email sent', code: accessCode });
  });
});

// ✅ Admin get logs
app.get('/admin/logs-data', isAdmin, (req, res) => {
  db.all('SELECT * FROM logs ORDER BY id DESC', (err, rows) => {
    if (err) {
      console.error('Error getting logs:', err);
      return res.status(500).json({ error: 'Failed to load logs' });
    }
    res.json(rows);
  });
});

// ✅ Admin get available codes
app.get('/admin/codes', isAdmin, (req, res) => {
  db.all('SELECT * FROM codes WHERE used = 0', (err, rows) => {
    if (err) {
      console.error('Error getting codes:', err);
      return res.status(500).json({ error: 'Failed to load codes' });
    }
    res.json(rows);
  });
});

// ✅ Admin upload codes
app.post('/admin/upload-codes', isAdmin, (req, res) => {
  const { codes } = req.body;

  if (!codes || !Array.isArray(codes)) {
    return res.status(400).json({ error: 'Invalid codes format' });
  }

  const stmt = db.prepare('INSERT INTO codes (code, used) VALUES (?, 0)');
  codes.forEach(code => {
    if (code.trim()) {
      stmt.run(code.trim());
    }
  });
  stmt.finalize();

  res.json({ success: true, message: 'Codes uploaded successfully' });
});

// ✅ Optional debug: show logs in raw HTML
app.get('/admin/logs', isAdmin, (req, res) => {
  db.all('SELECT * FROM logs ORDER BY timestamp DESC', (err, rows) => {
    if (err) {
      res.status(500).send("Error fetching logs");
    } else {
      res.send(`<html><body><h2>Logs</h2><pre>${JSON.stringify(rows, null, 2)}</pre></body></html>`);
    }
  });
});

// ✅ Start server
app.listen(PORT, '0.0.0.0', (err) => {
  if (err) {
    console.error('Failed to start server:', err);
  } else {
    console.log(`Server running on port ${PORT}`);
  }
});
