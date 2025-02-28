const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { OpenAI } = require('openai');
const path = require('path');

const app = express();

// Configure Twilio
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
const twilioClient = twilio(accountSid, authToken);

// Configure OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Global cache for conversation history
const conversationHistory = {};

// Calendly link
const CALENDLY_LINK = "https://calendly.com/ali-shehroz-19991/30min";

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve the index.html file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Chat endpoint
app.post('/chat', async (req, res) => {
  const userMessage = req.body.message;
  if (!userMessage) {
    return res.json({ response: "Hi there! How can I help you today?" });
  }

  try {
    const aiResponse = await getAIResponse(userMessage);
    res.json({ response: aiResponse.response, suggestedAppointment: aiResponse.suggestedAppointment });
  } catch (error) {
    console.error('Error in /chat:', error);
    res.status(500).json({ response: "I'm sorry, I'm having trouble processing your request right now. Could you try again?", suggestedAppointment: false });
  }
});

// Call endpoint
app.post('/call', async (req, res) => {
  const phoneNumber = req.body.phone_number;
  if (!phoneNumber) {
    return res.status(400).json({ error: 'No phone number provided' });
  }

  try {
    const call = await twilioClient.calls.create({
      to: phoneNumber,
      from: twilioPhoneNumber,
      url: `${req.protocol}://${req.get('host')}/twiml`,
    });

    // Initialize conversation history for this call
    conversationHistory[call.sid] = [];

    res.json({ success: true, call_sid: call.sid });
  } catch (error) {
    console.error('Error making call:', error);
    res.status(500).json({ error: 'Failed to initiate call. Please try again.' });
  }
});

// TwiML endpoint for call handling
app.post('/twiml', (req, res) => {
  const response = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;

  // Initialize conversation history for this call
  if (callSid) {
    conversationHistory[callSid] = [];
  }

  const gather = response.gather({
    input: 'speech dtmf',
    action: '/conversation',
    method: 'POST',
    timeout: 3,
    speechTimeout: 'auto',
    bargeIn: true,
  });

  gather.say('Hi there! This is Sarah from MultipleAI Solutions. How are you today?', { voice: 'Polly.Joanna' });
  response.redirect('/conversation');

  res.type('text/xml');
  res.send(response.toString());
});

// Conversation endpoint for call handling
app.post('/conversation', async (req, res) => {
  const userSpeech = req.body.SpeechResult || '';
  const callSid = req.body.CallSid;
  const digits = req.body.Digits || '';

  const response = new twilio.twiml.VoiceResponse();

  // Handle hang up requests
  if (digits === '9' || /goodbye|bye|hang up|end call/i.test(userSpeech)) {
    response.say('Thank you for your time. Have a great day!', { voice: 'Polly.Joanna' });
    response.hangup();
    return res.type('text/xml').send(response.toString());
  }

  // Get AI response
  const aiResponse = await getAIResponse(userSpeech, callSid);

  // If appointment is suggested, send SMS with the booking link
  if (aiResponse.suggestedAppointment && callSid) {
    try {
      const call = await twilioClient.calls(callSid).fetch();
      const phoneNumber = call.to;

      await twilioClient.messages.create({
        body: `Here is the link to schedule a meeting: ${CALENDLY_LINK}`,
        from: twilioPhoneNumber,
        to: phoneNumber,
      });

      console.log(`SMS sent to ${phoneNumber}`);
      aiResponse.response += ` I've also sent you an SMS with the booking link.`;
    } catch (error) {
      console.error('Error sending SMS:', error);
      aiResponse.response += ` I tried to send you an SMS, but there was an error. You can schedule a meeting here: ${CALENDLY_LINK}`;
    }
  }

  // Respond with the AI's message
  const gather = response.gather({
    input: 'speech dtmf',
    action: '/conversation',
    method: 'POST',
    timeout: 5,
    speechTimeout: 'auto',
    bargeIn: true,
  });

  gather.say(aiResponse.response, { voice: 'Polly.Joanna' });
  res.type('text/xml').send(response.toString());
});

// Function to get AI response
async function getAIResponse(userInput, callSid = null) {
  // Build conversation history for context
  let conversationContext = '';
  if (callSid && conversationHistory[callSid]) {
    conversationContext = conversationHistory[callSid]
      .map((msg) => `User: ${msg.user}\nAssistant: ${msg.assistant}`)
      .join('\n');
  }

  // Updated AI prompt
  const prompt = `You are Sarah, a friendly and helpful representative from MultipleAI Solutions. Your goal is to have a natural, human-like conversation with the user, starting with small talk and gradually transitioning to discussing business solutions.

When responding:
1. Start with casual, friendly small talk (e.g., "How's your day going?" or "I hope you're having a great day!").
2. Gradually steer the conversation toward AI solutions and business needs.
3. Use a warm, conversational tone with contractions (e.g., "I'm", "we're", "can't").
4. Keep responses concise (2-3 sentences).
5. If the user expresses interest or asks about AI solutions, suggest booking an appointment and include the phrase "[Appointment Suggested]" at the end of your response.
6. When suggesting an appointment, provide a clickable link: <a href="${CALENDLY_LINK}" target="_blank">Schedule a meeting here</a>.
7. If the user is silent, ask a follow-up question related to the current topic.
8. Avoid repeating yourself or sounding robotic.
9. If the user asks for a booking link, send it via SMS and mention it in the chat.

Previous conversation:
${conversationContext}

User's question: ${userInput}

Respond in a natural, conversational way and suggest an appointment when appropriate:`;

  try {
    const openaiResponse = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: userInput },
      ],
      max_tokens: 100,
      temperature: 0.7,
    });

    let responseText = openaiResponse.choices[0].message.content.trim();
    const suggestedAppointment = responseText.includes('[Appointment Suggested]');
    responseText = responseText.replace('[Appointment Suggested]', '');

    // Save to conversation history if this is a call
    if (callSid) {
      conversationHistory[callSid].push({
        user: userInput,
        assistant: responseText,
      });

      // Limit conversation history size
      if (conversationHistory[callSid].length > 10) {
        conversationHistory[callSid] = conversationHistory[callSid].slice(-10);
      }
    }

    return { response: responseText, suggestedAppointment };
  } catch (error) {
    console.error('Error in getAIResponse:', error);
    return { response: "I'm sorry, I'm having trouble processing your request right now. Could you try again?", suggestedAppointment: false };
  }
}

// Export the app for Koyeb
module.exports = app;
