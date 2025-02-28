const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { OpenAI } = require('openai');
const path = require('path');
const fs = require('fs');

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

// Load document data from JSON file
let documentData = {};
const documentJsonPath = path.join(__dirname, 'document_contents.json');

try {
  if (fs.existsSync(documentJsonPath)) {
    documentData = JSON.parse(fs.readFileSync(documentJsonPath, 'utf8'));
    console.log(`Loaded ${Object.keys(documentData).length} documents from JSON file`);
  } else {
    console.warn('Document JSON file not found. Running without document data.');
  }
} catch (error) {
  console.error('Error loading document JSON file:', error);
}

const conversationHistory = {};
const CALENDLY_LINK = "https://calendly.com/ali-shehroz-19991/30min";

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/chat', async (req, res) => {
  const userMessage = req.body.message;
  if (!userMessage) {
    return res.json({ response: "Hello, this is Mat from MultipleAI Solutions. How are you today?" });
  }

  try {
    const aiResponse = await getAIResponse(userMessage);
    res.json({ response: aiResponse.response, suggestedAppointment: aiResponse.suggestedAppointment });
  } catch (error) {
    console.error('Error in /chat:', error);
    res.status(500).json({ response: "I apologize, but I'm experiencing technical difficulties. Could you please try again?", suggestedAppointment: false });
  }
});

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

    conversationHistory[call.sid] = [];

    res.json({ success: true, call_sid: call.sid });
  } catch (error) {
    console.error('Error making call:', error);
    res.status(500).json({ error: 'Failed to initiate call. Please try again.' });
  }
});

app.post('/twiml', (req, res) => {
  const response = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;

  const gather = response.gather({
    input: 'speech dtmf',
    action: '/conversation',
    method: 'POST',
    timeout: 3,
    speechTimeout: 'auto',
    bargeIn: false,
  });

  gather.say({ voice: 'Polly.Matthew-Neural' }, 'Hello, this is Mat from MultipleAI Solutions. How are you today?');
  response.redirect('/conversation');

  res.type('text/xml');
  res.send(response.toString());
});

// Part 2/4 (server.js - Conversation Endpoint):

app.post('/conversation', async (req, res) => {
  const userSpeech = req.body.SpeechResult || '';
  const callSid = req.body.CallSid;
  const digits = req.body.Digits || '';

  const response = new twilio.twiml.VoiceResponse();

  if (callSid && !conversationHistory[callSid]) {
    conversationHistory[callSid] = [];
  }

  if (digits === '9' || /goodbye|bye|hang up|end call/i.test(userSpeech)) {
    response.say({ voice: 'Polly.Matthew-Neural' }, 'Thank you for your time. Have a good day.');
    response.hangup();
    return res.type('text/xml').send(response.toString());
  }

  try {
    const aiResponse = await getAIResponse(userSpeech, callSid);

    // SMS handling
    if (aiResponse.suggestedAppointment && callSid) {
      try {
        const call = await twilioClient.calls(callSid).fetch();
        const phoneNumber = call.to;

        await twilioClient.messages.create({
          body: `Here is the link to schedule a meeting with MultipleAI Solutions: ${CALENDLY_LINK}`,
          from: twilioPhoneNumber,
          to: phoneNumber,
        });

        console.log(`SMS sent to ${phoneNumber}`);
        aiResponse.response += ` I've sent you an SMS with the booking link.`;
      } catch (error) {
        console.error('Error sending SMS:', error);
        aiResponse.response += ` I wanted to send you the booking link via SMS, but there was an error. You can schedule a meeting here: ${CALENDLY_LINK}`;
      }
    }

    const gather = response.gather({
      input: 'speech dtmf',
      action: '/conversation',
      method: 'POST',
      timeout: 5,
      speechTimeout: 'auto',
      bargeIn: false,
    });

    const responseText = aiResponse.response.replace(/<[^>]*>/g, "");
    gather.say({ voice: 'Polly.Matthew-Neural' }, responseText);

    res.type('text/xml');
    res.send(response.toString());

  } catch (error) {
    console.error("Error in /conversation:", error);
    response.say({ voice: 'Polly.Matthew-Neural' }, "I'm experiencing technical difficulties. Please try again later.");
    res.type('text/xml');
    res.send(response.toString());
  }
});

// Part 3/4 (server.js - getAIResponse function):

// Part 3/4 (server.js - getAIResponse function - COMPLETE):
async function getAIResponse(userInput, callSid = null) {
  let conversationContext = '';
  if (callSid && conversationHistory[callSid]) {
    conversationContext = conversationHistory[callSid]
      .map((msg) => `User: ${msg.user}\nAssistant: ${msg.assistant}`)
      .join('\n');
  }

  let relevantDocs = '';
  const userInputLower = userInput.toLowerCase();

  for (const [filename, content] of Object.entries(documentData)) {
    const contentLower = content.toLowerCase();
    const isRelevant = userInputLower.split(' ').some(word =>
      word.length > 3 && contentLower.includes(word.toLowerCase())
    );

    if (isRelevant) {
      relevantDocs += `\nFrom ${filename}: ${content.substring(0, 200)}...\n`;
    }
  }

  if (relevantDocs.length > 1000) {
    relevantDocs = relevantDocs.substring(0, 1000) + "... (additional relevant content omitted)";
  }

  const prompt = `
You are Mat, a friendly and professional assistant from MultipleAI Solutions, based in Perth, Australia.

Your goal is to have a smooth conversation, offering solutions to potential customers. When speaking to customers:
- Always say you are Mat, a human representative, and never mention AI or automation.
- Start the conversation with a greeting and a simple, friendly opening (e.g., "Hello, how are you today?").
- If the user asks a direct question, answer it clearly and directly without unnecessary repetition.
- If the user seems interested in business or AI solutions, transition naturally by explaining how your company specializes in AI and can help them with their needs.
- If the user asks for an appointment, suggest the link to schedule a call (using your Calendly link).
- If an appointment is suggested, send the user a message with the link (make sure this happens after the call, not during).

Make sure to avoid repeating yourself. If the user asks the same thing multiple times, do not give the same answer again—try to answer differently and steer the conversation towards scheduling an appointment or discussing the product more.

### Example Conversation Flow:
- **Mat**: "Hey there! How's your morning going so far?"
- **User**: "Good, just busy with work."
- **Mat**: "I hear you! Work can be busy. By the way, are you currently exploring AI solutions for your business?"
- **User**: "Yes, a little."
- **Mat**: "That's awesome! AI can really streamline your operations. Would you like to set up a quick consultation to explore how we can help?"
- **User**: "Sure!"
- **Mat**: "Great! Here’s the link to schedule a meeting with MultipleAI Solutions: [Calendly Link]. Feel free to book a time that suits you!"

### Context: 
If conversation context is available, use it to maintain a natural flow. For example, if the user mentioned work earlier, you could bring it up in the conversation smoothly. If there are relevant documents, mention them briefly to highlight how your solutions can be tailored.

Don't mention the same thing repeatedly, and keep your answers to the point, always aiming to move the conversation towards a meeting or discussing business.



  `;

  try {
    const openaiResponse = await openai.chat.completions.create({
      model: 'gpt-4', // Or your preferred model
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
    console.log("🔹 AI Response:", responseText);

    if (callSid) {
      conversationHistory[callSid].push({
        user: userInput,
        assistant: responseText,
      });

      if (conversationHistory[callSid].length > 10) {
        conversationHistory[callSid] = conversationHistory[callSid].slice(-10);
      }
    }

    return { response: responseText, suggestedAppointment };
  } catch (error) {
    console.error('Error in getAIResponse:', error);
    return { response: "I apologize, but I'm having trouble processing your request. Could you please try again?", suggestedAppointment: false };
  }
}

// Part 4/4 (server.js - Port and Server Start):
const PORT = process.env.PORT || 8000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

module.exports = app;
