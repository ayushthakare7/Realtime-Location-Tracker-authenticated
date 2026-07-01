require('dotenv').config();
const nodemailer = require('nodemailer');

// FIX: Added explicit host and toggled security settings to bypass Render's firewall blocks
const transporter = nodemailer.createTransport({
  host: '://gmail.com',
  port: 465,
  secure: true, // Upgrades the connection to TLS immediately
  service: 'gmail',
  auth: {
    type: 'OAuth2',
    user: process.env.EMAIL_USER,
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    refreshToken: process.env.REFRESH_TOKEN,
  },
  tls: {
    rejectUnauthorized: false // Prevents cloud firewalls from abruptly terminating the handshake
  }
});

// Verify connection configuration
transporter.verify((error, success) => {
  if (error) {
    console.error('Error connecting to email server:', error);
  } else {
    console.log('Email server is ready to send messages');
  }
});

const sendEmail = async (to, subject, text, html) => {
  try {
    const info = await transporter.sendMail({
      from: `Real-Time Location Tracker <${process.env.EMAIL_USER}>`, 
      to, 
      subject, 
      text, 
      html, 
    });

    console.log('Message sent: %s', info.messageId);
    } catch(error) {
    console.error('Detailed Error inside sendEmail function:', error);
  }
};

async function sendRegistrationEmail(userEmail, name){
  const subject = 'Welcome to Real-Time Location Tracker !';
  const text = `Hello ${name}, \n\n Thank you for registering at Real-Time Location Tracker, We are excited to have you on board!\n\n Best regards, \n\n RT Location Tracker Team`;
  const html = `<p>Hello ${name}, </p><p>Thank you for registering at Real-Time Location Tracker, We are excited to have you on board!</p><p>Best regards,</p><p>RT Location Tracker Team</p>`;

  await sendEmail(userEmail, subject, text, html);
}


module.exports = {
  transporter,
  sendRegistrationEmail
};