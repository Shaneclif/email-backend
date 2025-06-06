require('dotenv').config();

const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const bodyParser = require('body-parser');
const db = require('./db');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(bodyParser.json());

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

app.post('/send-code', (req, res) => {
  const { email, amount, reference } = req.body;

  if (!email || !amount || !reference) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const accessCode = Math.floor(100000 + Math.random() * 900000).toString();

  const mailOptions = {
    from: process.env.GMAIL_USER,
    to: email,
    subject: 'Your Access Code',
    text: `Thank you! Your access code is: ${accessCode}`
  };

  transporter.sendMail(mailOptions, (err, info) => {
    if (err) {
      console.error('Error sending email:', err);
      return res.status(500).json({ error: 'Failed to send email' });
    }

    db.run(
      `INSERT INTO logs (email, amount, reference) VALUES (?, ?, ?)`,
      [email, amount, reference],
      (err) => {
        if (err) {
          console.error('Error saving log to DB:', err);
        } else {
          console.log('Logged transaction:', email, amount, reference);
        }
      }
    );

    res.status(200).json({ message: 'Email sent successfully', code: accessCode });
  });
});

// Admin logs view
app.get('/admin/logs', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM logs ORDER BY timestamp DESC');
    res.send(`
      <html>
        <head>
          <title>WakaTV Admin Logs</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; background: #111; color: #fff; }
            table { border-collapse: collapse; width: 100%; background: #222; }
            th, td { border: 1px solid #444; padding: 8px; text-align: left; }
            th { background-color: #FE6A0A; color: white; }
            tr:nth-child(even) { background-color: #333; }
          </style>
        </head>
        <body>
          <h2>WakaTV Payment Logs</h2>
          <table>
            <thead>
              <tr><th>ID</th><th>Email</th><th>Amount (ZAR)</th><th>Reference</th><th>Time</th></tr>
            </thead>
            <tbody>
              ${rows.map(row => `
                <tr>
                  <td>${row.id}</td>
                  <td>${row.email}</td>
                  <td>R${(row.amount / 100).toFixed(2)}</td>
                  <td>${row.reference}</td>
                  <td>${row.timestamp}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("Error fetching logs:", err);
    res.status(500).send("Error fetching logs");
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
