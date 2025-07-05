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

// MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
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
  origin: 'https://easystreamzy.com',
  credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: path.join(__dirname, 'db') }),
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    httpOnly: true,
    sameSite: 'none',
    maxAge: 2 * 60 * 60 * 1000
  }
}));

// Mailer
const transporter = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  auth: {
    user: process.env.BREVO_SMTP_USER,
    pass: process.env.BREVO_SMTP_PASS
  }
});

// Visitor tracking
app.use(async (req, res, next) => {
  if (req.method === 'GET') {
    try {
      await Visit.create({ ip: req.ip, userAgent: req.get('User-Agent') });
    } catch {}
  }
  next();
});

// Admin Auth Middleware
function isAdmin(req, res, next) {
  if (req.session.admin) return next();
  res.status(403).json({ success: false });
}

// Admin Login
app.post('/admin/login', (req, res) => {
  if (req.body.username === process.env.ADMIN_USERNAME && req.body.password === process.env.ADMIN_PASSWORD) {
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

// Send Code + Referral Logic
app.post('/send-code', async (req, res) => {
  try {
    const { email, amount, reference, referralCode } = req.body;
    if (!email || !amount || isNaN(amount) || !reference) return res.status(400).json({ success: false });

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

// IPN Listener
app.post('/api/payfast/ipn', async (req, res) => {
  try {
    console.log('📩 Incoming IPN:', req.body);

    const isTestMode = process.env.TEST_MODE === 'true';
    let valid = false;

    if (isTestMode) {
      console.log('🧪 Test mode enabled – skipping IPN validation');
      valid = true;
    } else {
      const raw = qs.stringify(req.body);
      const verify = await axios.post('https://www.payfast.co.za/eng/query/validate', raw, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });

      valid = verify.data === 'VALID';
      console.log('✅ IPN validation result:', verify.data);
    }

    if (!valid) {
      console.log('❌ Invalid IPN received.');
      return res.status(400).send('Invalid IPN');
    }

    if (req.body.payment_status === 'COMPLETE') {
      const raw = {};
      for (const key in req.body) {
        raw[key.trim()] = req.body[key]?.trim?.() || req.body[key];
      }

      const email = raw.email_address || raw.email || 'undefined@fallback.com';
      const amount = parseFloat(raw.amount_gross);
      const reference = raw.pf_payment_id;
      const referralCode = raw.custom_str1 || null;
      const units = isNaN(amount) ? 1 : Math.floor(amount / 140);

      console.log('💳 Payment Details:');
      console.log('  Email:', email);
      console.log('  Amount:', amount);
      console.log('  Reference:', reference);
      console.log('  ReferralCode:', referralCode);
      console.log('  Units to send:', units);

      const response = await axios.post('https://email-backend-vr8z.onrender.com/send-code', {
        email,
        amount: units,
        reference,
        referralCode
      });

      console.log('📬 /send-code response:', response.data);

      if (!response.data.success) {
        console.error('❌ Failed to send codes:', response.data);
      }
    } else {
      console.log('⏳ Payment status not COMPLETE:', req.body.payment_status);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('🔥 IPN error:', err?.response?.data || err);
    res.status(500).send('Error');
  }
});

// ✅ Referral Tracker Endpoint
app.get('/api/referrals/status', async (req, res) => {
  const { email } = req.query;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'Invalid email' });
  }

  try {
    const user = await User.findOne({ email });

    if (!user) {
      return res.json({ success: true, email, totalReferrals: 0, codesEarned: 0 });
    }

    res.json({
      success: true,
      email,
      totalReferrals: user.referred?.length || 0,
      referralCode: user.referralCode,
      codesEarned: user.codesEarned || 0
    });
  } catch (err) {
    console.error('❌ Referral tracker error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Admin Routes
app.get('/admin/logs-data', isAdmin, async (req, res) => {
  const logs = await Log.find().sort({ timestamp: -1 });
  res.json({ success: true, logs });
});

app.get('/admin/codes', isAdmin, async (req, res) => {
  const codes = await Code.find();
  res.json({ success: true, codes });
});

app.get('/admin/visits', isAdmin, async (req, res) => {
  const visits = await Visit.find().sort({ timestamp: -1 }).limit(100);
  res.json({ success: true, visits });
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

// ✅ AI Chatbot Route
app.post('/api/chatbot', async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are EasyBot, a friendly AI receptionist for EasyStreamzy. Help users with vouchers, payments, and support.' },
        ...history,
        { role: 'user', content: message }
      ]
    }, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const reply = response.data.choices[0].message.content;
    res.json({ success: true, reply });
  } catch (err) {
    console.error('❌ Chatbot error:', err?.response?.data || err);
    res.status(500).json({ success: false, message: 'Chatbot failed' });
  }
});

// Start Server
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
