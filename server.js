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
    user: 'clashofclansmordor@gmail.com',
    pass: 'lixz mgjt ewht wjjm'
  }
});

app.post('/send-code', (req, res) => {
  const { email } = req.body;

  if (!email) return res.status(400).json({ error: 'Email is required' });

  const accessCode = Math.floor(100000 + Math.random() * 900000).toString();

  const mailOptions = {
    from: 'clashofclansmordor@gmail.com',
    to: email,
    subject: 'Your Access Code',
    text: `Thank you! Your access code is: ${accessCode}`
  };

  transporter.sendMail(mailOptions, (err, info) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to send email' });
    }
    res.status(200).json({ message: 'Email sent successfully', code: accessCode });
  });
});


app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
