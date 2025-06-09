// server.js

require('dotenv').config();

const mongoose = require('mongoose');
mongoose.connect(process.env.MONGO_URI, {
  // useNewUrlParser and useUnifiedTopology are now default, but can remain for compatibility
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB Connected!'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// ENV DEBUG LOGGING (optional)
console.log('BREVO_SMTP_USER:', process.env.BREVO_SMTP_USER);
console.log('BREVO_SMTP_PASS:', process.env.BREVO_SMTP_PASS ? '[HIDDEN]' : '[MISSING]');

const express       = require('express');
const session       = require('express-session');
const SQLiteStore   = require('connect-sqlite3')(session);
const nodemailer    = require('nodemailer');
const cors          = require('cors');
const bodyParser    = require('body-parser');
const path          = require('path');

const app    = express();
const PORT   = process.env.PORT || 10000;
const isProd = process.env.NODE_ENV === 'production';

const ORIGINS = [
  'http://localhost:5500',
  'https://easystreamzy.com'
];

// --- MongoDB Models ---
// Codes and Logs stay the same
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
const Code = mongoose.model('Code', codeSchema);
const Log = mongoose.model('Log', logSchema);

// --- NEW: User model for referrals ---
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  referralCode: { type: String, unique: true },
  referred: [String], // emails of people referred
  codesEarned: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

// Use your authenticated sender domain here
const SENDER_ADDRESS = 'no-reply@easystreamzy.com';

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

// --- USE UPLOADED CODES, MARK AS USED, SEND TO CUSTOMER ---
// --- REFERRAL LOGIC: create or update User, track referral, reward every 5 referrals ---
app.post('/send-code', async (req, res) => {
  try {
    const { email, amount, reference, referralCode } = req.body;
    if (!email || !amount || !reference) {
      return res.status(400).json({ success: false, message: 'Missing parameters' });
    }

    // 0. If this user is new, create a User with a unique referral code
    let user = await User.findOne({ email });
    if (!user) {
      // create unique code (could use MongoDB _id, here using random for clarity)
      const makeCode = () => Math.random().toString(36).substring(2, 10).toUpperCase();
      let newCode = makeCode();
      // Ensure code is unique
      while (await User.findOne({ referralCode: newCode })) newCode = makeCode();
      user = await User.create({ email, referralCode: newCode, referred: [], codesEarned: 0 });
    }

    // 1. Get the first unused code and mark as used
    const codeDoc = await Code.findOneAndUpdate(
      { used: false },
      { used: true, usedBy: email, usedAt: new Date() },
      { new: true }
    );

    if (!codeDoc) {
      return res.status(400).json({ success: false, message: 'No codes available. Please contact support.' });
    }
    const code = codeDoc.code;

    // 2. Send mail using your custom sender address!
    try {
      await transporter.sendMail({
        from: `"EasyStreamzy" <${SENDER_ADDRESS}>`,   // Branded sender
        to: email,
        subject: 'Your WakaTV Access Code',
        text: `Here is your code: ${code}`
      });
    } catch (mailErr) {
      // If sending fails, make the code available again
      await Code.findByIdAndUpdate(codeDoc._id, { used: false, usedBy: null, usedAt: null });
      return res.status(500).json({ success: false, message: 'Email sending failed', error: mailErr.toString() });
    }

    // 3. Log the transaction
    await Log.create({ email, amount, reference });

    // 4. --- Referral Logic ---
    // If this purchase was with a referral code, record referral and auto-reward every 5
    if (referralCode) {
      // Don't let users refer themselves
      if (user.referralCode !== referralCode) {
        const referrer = await User.findOne({ referralCode });
        if (referrer && !referrer.referred.includes(email)) {
          referrer.referred.push(email);

          // Every 5 new referrals, reward with a free code!
          if (referrer.referred.length % 5 === 0) {
            // Find a free code for the referrer
            const bonusCodeDoc = await Code.findOneAndUpdate(
              { used: false },
              { used: true, usedBy: referrer.email, usedAt: new Date() },
              { new: true }
            );
            if (bonusCodeDoc) {
              await transporter.sendMail({
                from: `"EasyStreamzy" <${SENDER_ADDRESS}>`,
                to: referrer.email,
                subject: 'Your Free WakaTV Access Code!',
                text: `Thanks for referring 5 people! Here is your free access code: ${bonusCodeDoc.code}`
              });
              referrer.codesEarned = (referrer.codesEarned || 0) + 1;
            }
          }
          await referrer.save();
        }
      }
    }

    res.json({ success: true, message: 'Code sent', referralCode: user.referralCode });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error', error: err.toString() });
  }
});

// --- ADMIN ROUTES ---
app.get('/admin/logs-data', isAdmin, async (req, res) => {
  try {
    const logs = await Log.find().sort({ timestamp: -1 });
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/admin/codes', isAdmin, async (req, res) => {
  try {
    const codes = await Code.find().sort({ _id: 1 });
    res.json({ success: true, codes });
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

    const bulkOps = codes
      .map(code => code.trim())
      .filter(Boolean)
      .map(code => ({
        updateOne: {
          filter: { code },
          update: { $setOnInsert: { code } },
          upsert: true
        }
      }));
    if (bulkOps.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid codes' });
    }

    await Code.bulkWrite(bulkOps);
    res.json({ success: true, message: 'Codes uploaded' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// --- NEW: Referral progress API endpoint ---
app.get('/api/my-referrals', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ success: false, message: "Email required" });

  const user = await User.findOne({ email });
  if (!user) return res.status(404).json({ success: false, message: "Not found" });

  res.json({
    success: true,
    referralCode: user.referralCode,
    referred: user.referred,
    numReferred: user.referred.length,
    codesEarned: user.codesEarned || 0,
    nextRewardIn: 5 - (user.referred.length % 5 === 0 ? 5 : user.referred.length % 5)
  });
});

app.listen(PORT, () => {
  console.log(` Server listening on port ${PORT}`);
});
