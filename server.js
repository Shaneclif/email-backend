// server.js - Fully updated PayFast IPN + Code Delivery (Individual Account)
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const nodemailer = require('nodemailer');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const qs = require('querystring');

const app = express();
const PORT = process.env.PORT || 10000;

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// Models
const Code = mongoose.model('Code', new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  used: { type: Boolean, default: false },
  usedBy: String,
  usedAt: Date
}));

const Log = mongoose.model('Log', new mongoose.Schema({
  email: String,
  amount: Number,
  reference: String,
  timestamp: { type: Date, default: Date.now }
}));

const User = mongoose.model('User', new mongoose.Schema({
  email: { type: String, unique: true },
  referralCode: { type: String, unique: true },
  referred: [String],
  codesEarned: Number
}));

const Visit = mongoose.model('Visit', new mongoose.Schema({
  ip: String,
  userAgent: String,
  timestamp: { type: Date, default: Date.now }
}));

// Middleware
app.set('trust proxy', 1);
app.use(cors({
  origin: ['http://localhost:5500', 'https://easystreamzy.com'],
  credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: path.join(__dirname, 'db') }),
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, sameSite: 'lax', maxAge: 7200000 }
}));

const transporter = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  auth: {
    user: process.env.BREVO_SMTP_USER,
    pass: process.env.BREVO_SMTP_PASS
  }
});

app.use(async (req, res, next) => {
  if (req.method === 'GET') {
    try {
      await Visit.create({ ip: req.ip, userAgent: req.get('User-Agent') });
    } catch {}
  }
  next();
});

function isAdmin(req, res, next) {
  if (req.session.admin) return next();
  res.status(403).json({ success: false });
}

app.post('/admin/login', (req, res) => {
  if (
    req.body.username === process.env.ADMIN_USERNAME &&
    req.body.password === process.env.ADMIN_PASSWORD
  ) {
    req.session.admin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ success: false });
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

app.post('/send-code', async (req, res) => {
  try {
    const { email, amount, reference, referralCode } = req.body;
    if (!email || !amount || !reference) return res.status(400).json({ success: false });

    let user = await User.findOne({ email });
    if (!user) {
      let newCode = Math.random().toString(36).substring(2, 10).toUpperCase();
      while (await User.findOne({ referralCode: newCode })) {
        newCode = Math.random().toString(36).substring(2, 10).toUpperCase();
      }
      user = await User.create({ email, referralCode: newCode, referred: [], codesEarned: 0 });
    }

    const codesToSend = await Code.find({ used: false }).limit(amount);
    if (codesToSend.length < amount) return res.status(400).json({ success: false });

    for (const code of codesToSend) {
      await Code.findByIdAndUpdate(code._id, { used: true, usedBy: email, usedAt: new Date() });
    }

    const message = codesToSend.map((c, i) => `${i + 1}. ${c.code}`).join('\n');
    await transporter.sendMail({
      from: `EasyStreamzy <no-reply@easystreamzy.com>`,
      to: email,
      subject: 'Your EasyStreamzy Access Codes',
      text: `Here are your codes:\n\n${message}\n\nRefer friends: https://easystreamzy.com/?ref=${user.referralCode}`
    });

    await Log.create({ email, amount, reference });

    if (referralCode && referralCode !== user.referralCode) {
      const referrer = await User.findOne({ referralCode });
      if (referrer && !referrer.referred.includes(email)) {
        referrer.referred.push(email);
        if (referrer.referred.length % 5 === 0) {
          const bonus = await Code.findOneAndUpdate(
            { used: false },
            { used: true, usedBy: referrer.email, usedAt: new Date() },
            { new: true }
          );
          if (bonus) {
            await transporter.sendMail({
              from: `EasyStreamzy <no-reply@easystreamzy.com>`,
              to: referrer.email,
              subject: 'Free Bonus Code',
              text: `Thanks for referring! Here's your bonus code: ${bonus.code}`
            });
            referrer.codesEarned += 1;
          }
        }
        await referrer.save();
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Send Code Error:', err);
    res.status(500).json({ success: false });
  }
});

// ✅ Correct IPN endpoint for "Buy Now" buttons (Individual PayFast account)
app.post('/api/payfast/ipn', async (req, res) => {
  try {
    const raw = qs.stringify(req.body);
    const verify = await axios.post('https://www.payfast.co.za/eng/query/validate', raw, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (verify.data !== 'VALID') return res.status(400).send('Invalid IPN');

    if (req.body.payment_status === 'COMPLETE') {
      const email = req.body.email_address;
      const amount = parseFloat(req.body.amount_gross);
      const reference = req.body.pf_payment_id;
      const referralCode = req.body.custom_str1 || null;
      const units = Math.floor(amount / 140); // adjust for testing if needed

      await axios.post(`${process.env.FRONTEND_BASE_URL || 'https://easystreamzy.com'}/send-code`, {
        email, amount: units, reference, referralCode
      });
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('IPN error:', err);
    res.status(500).send('Error');
  }
});

// Admin APIs
app.get('/admin/logs-data', isAdmin, async (req, res) => {
  const logs = await Log.find().sort({ timestamp: -1 });
  res.json({ success: true, logs });
});

app.get('/admin/codes', isAdmin, async (req, res) => {
  const codes = await Code.find();
  res.json({ success: true, codes });
});

app.post('/admin/upload-codes', isAdmin, async (req, res) => {
  const { codes } = req.body;
  if (!Array.isArray(codes)) return res.status(400).json({ success: false });
  await Code.insertMany(codes.map(code => ({ code })), { ordered: false });
  res.json({ success: true });
});

app.post('/admin/delete-codes', isAdmin, async (req, res) => {
  const { ids } = req.body;
  await Code.deleteMany({ _id: { $in: ids } });
  res.json({ success: true });
});

app.get('/admin/visits', isAdmin, async (req, res) => {
  const visits = await Visit.find().sort({ timestamp: -1 }).limit(100);
  res.json({ success: true, visits });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
