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

// ✅ CORS setup for Render + Netlify
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
    secure: false, // Set to true if using HTTPS
    sameSite: 'lax'
  }
}));

// ✅ Root route
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

// ✅ Generate random code
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ✅ Send code and log
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

// ✅ Admin logs HTML (optional)
app.get('/admin/logs', isAdmin, async (req, res) => {
  try {
    const rows = await db.allAsync('SELECT * FROM logs ORDER BY timestamp DESC');
    res.send(`
      <html><body><h2>Logs</h2><pre>${JSON.stringify(rows, null, 2)}</pre></body></html>
    `);
  } catch (err) {
    res.status(500).send("Error fetching logs");
  }
});

// ✅ Start server
app.listen(PORT, '0.0.0.0', (err) => {
  if (err) {
    console.error('Failed to start server:', err);
  } else {
    console.log(`Server running on port ${PORT}`);
  }
});
