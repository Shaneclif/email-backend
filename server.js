require('dotenv').config();

const mongoose = require('mongoose');
const express = require('express');
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
const isProd = process.env.NODE_ENV === 'production';

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('✅ MongoDB Connected!'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

const ORIGINS = [
  'http://localhost:5500',
  'https://easystreamzy.com'
];

// MongoDB Schemas
const codeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  used: { type: Boolean, default: false },
  usedBy: { type: String, default: null },
  usedAt: { type: Date, default: null }
});
const logSchema = new mongoose.Schema({
  email: String,
  amount: Number,
  reference: String,
  timestamp: { type: Date, default: Date.now }
});
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  referralCode: { type: String, unique: true },
  referred: [String],
  codesEarned: { type: Number, default: 0 }
});
const visitSchema = new mongoose.Schema({
  ip: String,
  userAgent: String,
  timestamp: { type: Date, default: Date.now }
});

const Code = mongoose.model('Code', codeSchema);
const Log = mongoose.model('Log', logSchema);
const User = mongoose.model('User', userSchema);
const Visit = mongoose.model('Visit', visitSchema);

const SENDER_ADDRESS = 'no-reply@easystreamzy.com';

app.set('trust proxy', 1);
app.use(cors({ origin: ORIGINS, credentials: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
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

app.use(async (req, res, next) => {
  if (req.method === 'GET') {
    try {
      await Visit.create({ ip: req.ip, userAgent: req.get('User-Agent') });
    } catch (e) { console.error('Visit log failed:', e); }
  }
  next();
});

function isAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(403).json({ success: false, message: 'Unauthorized' });
}

const transporter = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.BREVO_SMTP_USER,
    pass: process.env.BREVO_SMTP_PASS
  }
});

app.get('/', (req, res) => {
  res.send('🎉 EasyStreamzy backend is running');
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.admin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ success: false });
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ success: false });
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

app.post('/send-code', async (req, res) => {
  try {
    const { email, amount, reference, referralCode } = req.body;
    if (!email || !amount || !reference) return res.status(400).json({ success: false });

    const codesToSend = parseInt(amount, 10);
    let user = await User.findOne({ email });
    if (!user) {
      const makeCode = () => Math.random().toString(36).substring(2, 10).toUpperCase();
      let newCode = makeCode();
      while (await User.findOne({ referralCode: newCode })) newCode = makeCode();
      user = await User.create({ email, referralCode: newCode });
    }

    const codeDocs = await Code.find({ used: false }).limit(codesToSend);
    if (codeDocs.length < codesToSend) {
      return res.status(400).json({ success: false, message: `Only ${codeDocs.length} codes available.` });
    }

    for (const doc of codeDocs) {
      await Code.findByIdAndUpdate(doc._id, { used: true, usedBy: email, usedAt: new Date() });
    }

    const codeList = codeDocs.map((c, i) => `${i + 1}. ${c.code}`).join('\n');
    const frontendBase = process.env.FRONTEND_BASE_URL || 'https://easystreamzy.com';

    await transporter.sendMail({
      from: `"EasyStreamzy" <${SENDER_ADDRESS}>`,
      to: email,
      subject: 'Your EasyStreamzy Access Codes',
      text: `Here are your access codes:\n\n${codeList}\n\nRefer others: ${frontendBase}/?ref=${user.referralCode}`
    });

    await Log.create({ email, amount, reference });

    if (referralCode && referralCode !== user.referralCode) {
      const referrer = await User.findOne({ referralCode });
      if (referrer && !referrer.referred.includes(email)) {
        referrer.referred.push(email);
        if (referrer.referred.length % 5 === 0) {
          const bonusCode = await Code.findOneAndUpdate(
            { used: false },
            { used: true, usedBy: referrer.email, usedAt: new Date() },
            { new: true }
          );
          if (bonusCode) {
            await transporter.sendMail({
              from: `"EasyStreamzy" <${SENDER_ADDRESS}>`,
              to: referrer.email,
              subject: 'Your Free Code!',
              text: `Here is your free code: ${bonusCode.code}`
            });
            referrer.codesEarned = (referrer.codesEarned || 0) + 1;
          }
        }
        await referrer.save();
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.toString() });
  }
});

app.post('/payfast-ipn', async (req, res) => {
  try {
    const rawBody = qs.stringify(req.body);
    const verify = await axios.post('https://www.payfast.co.za/eng/query/validate', rawBody, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (verify.data !== 'VALID') return res.status(400).send('Invalid IPN');

    if (req.body.payment_status === 'COMPLETE') {
      const email = req.body.email_address;
      const amount = parseFloat(req.body.amount_gross);
      const reference = req.body.pf_payment_id;
      const referralCode = req.body.custom_str1 || null;
      const units = Math.floor(amount / 140);

      await axios.post(`${process.env.FRONTEND_BASE_URL || 'https://easystreamzy.com'}/send-code`, {
        email,
        amount: units,
        reference,
        referralCode
      }, {
        headers: { 'Content-Type': 'application/json' }
      });

      return res.status(200).send('OK');
    }

    res.status(200).send('Ignored');
  } catch (err) {
    console.error('PayFast IPN Error:', err);
    res.status(500).send('IPN Server Error');
  }
});

app.get('/admin/logs-data', isAdmin, async (req, res) => {
  try {
    const logs = await Log.find().sort({ timestamp: -1 });
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.get('/admin/codes', isAdmin, async (req, res) => {
  try {
    const codes = await Code.find().sort({ _id: 1 });
    res.json({ success: true, codes });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.post('/admin/upload-codes', isAdmin, async (req, res) => {
  try {
    const { codes } = req.body;
    if (!Array.isArray(codes) || !codes.length) {
      return res.status(400).json({ success: false });
    }
    const bulkOps = codes.map(code => ({
      updateOne: {
        filter: { code },
        update: { $setOnInsert: { code } },
        upsert: true
      }
    }));
    await Code.bulkWrite(bulkOps);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.post('/admin/delete-codes', isAdmin, async (req, res) => {
  try {
    const { ids } = req.body;
    await Code.deleteMany({ _id: { $in: ids } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.get('/admin/visits', isAdmin, async (req, res) => {
  try {
    const visits = await Visit.find().sort({ timestamp: -1 }).limit(100);
    res.json({ success: true, visits });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.get('/api/my-referrals', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ success: false });
  const user = await User.findOne({ email });
  if (!user) return res.status(404).json({ success: false });
  const nextRewardIn = 5 - (user.referred.length % 5 || 5);
  res.json({
    success: true,
    referralCode: user.referralCode,
    referred: user.referred,
    numReferred: user.referred.length,
    codesEarned: user.codesEarned || 0,
    nextRewardIn
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
