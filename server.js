require('dotenv').config();

const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = 3000;

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
  const { email } = req.body;

  if (!email) return res.status(400).send('Email is required');

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
      return res.status(500).send('Failed to send email');
    }
    res.status(200).send({ message: 'Email sent successfully', code: accessCode });
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
