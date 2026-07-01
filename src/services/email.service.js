require('dotenv').config();
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendRegistrationEmail(userEmail, name) {
  try {
    const data = await resend.emails.send({
      from: '"Real-Time Location Tracker"<onboarding@resend.dev>', 
      to: userEmail,
      subject: 'Welcome to Real-Time Location Tracker!',
      html: `<p>Hello <strong>${name}</strong>,</p>
             <p>Thank you for registering at Real-Time Location Tracker. We are excited to have you on board!</p>
             <p>Best regards,<br>RT Location Tracker Team</p>`,
    });

    console.log('EMAIL SUCCESS:', data);
  } catch (error) {
    console.error('CRITICAL RESEND EMAIL ERROR:', error);
  }
}

// Export the object for the controller to read
module.exports = {
  sendRegistrationEmail
};