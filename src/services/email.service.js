require('dotenv').config();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    type: 'OAuth2',
    user: process.env.EMAIL_USER,
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    refreshToken: process.env.REFRESH_TOKEN,
  },
});


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
      from: `"Real-Time Location Tracker" <${process.env.EMAIL_USER}>`, 
      to, 
      subject, 
      text, 
      html, 
    });

    console.log('Message sent: %s', info.messageId);
    console.log('Preview URL: %s', nodemailer.getTestMessageUrl(info));
  } catch (error) {
    console.error('Error sending email:', error);
  }
};


async function sendRegistrationEmail(userEmail, name){
  const subject = 'Welcome to Real-Time Location Tracker !';

  const text = `Hello ${name}, \n\n Thank you for registering at Real-Time Location Tracker, We are excited to have you on board!\n\n Best regards, \n\n RT Location Tracker Team`;

  const html = `<p>Hello ${name}, </p><p> \n\n Thank you for registering at Real-Time Location Tracker, We are excited to have you on board!</p><p>\n\n Best regards,</p><p> \n RT Location Tracker Team </p>`;


  await sendEmail(userEmail, subject, text, html)
}
module.exports = {transporter, sendRegistrationEmail};