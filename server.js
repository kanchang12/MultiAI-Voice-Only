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
    console.log('Document JSON file not found. Running without document data.');
  }
} catch (error) {
  console.error('Error loading document JSON file:', error);
}

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
    bargeIn: false,
  });

  gather.say('Hello, this is Mat from MultipleAI Solutions. How are you today?', { voice: 'Polly.Matthew.Neural' });
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
    response.say('Thank you for your time. Have a good day.', { voice: 'Polly.Matthew.Neural' });
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

  // Respond with the AI's message
  const gather = response.gather({
    input: 'speech dtmf',
    action: '/conversation',
    method: 'POST',
    timeout: 5,
    speechTimeout: 'auto',
    bargeIn: false,
  });

  gather.say(aiResponse.response, { voice: 'Polly.Matthew.Neural'  });
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

  // Find relevant document content based on user input
  let relevantDocs = '';
  const userInputLower = userInput.toLowerCase();
  
  // Simple keyword matching to find relevant documents
  for (const [filename, content] of Object.entries(documentData)) {
    // Check if document content might be relevant to user query
    const contentLower = content.toLowerCase();
    const isRelevant = userInputLower.split(' ').some(word => 
      word.length > 3 && contentLower.includes(word.toLowerCase())
    );
    
    if (isRelevant) {
      // Include an excerpt (first 200 characters) from relevant documents
      relevantDocs += `\nFrom ${filename}: ${content.substring(0, 200)}...\n`;
    }
  }

  // Limit the total amount of document content to avoid token limits
  if (relevantDocs.length > 1000) {
    relevantDocs = relevantDocs.substring(0, 1000) + "... (additional relevant content omitted)";
  }

  // Updated AI prompt with document data
  const prompt = `You are Mat, a friendly yet professional AI assistant from MultipleAI Solutions. 
Your goal is to have a natural and engaging conversation while smoothly transitioning into business topics. 

### Conversation Flow:
1. **Start with small talk** (e.g., "Hello! How's your morning going?" or "Hope you're having a good day so far.")
2. **Adapt to the user's response** (if they ask how you are, respond naturally; if they mention work, transition towards business)
3. **Transition to business naturally** (e.g., "By the way, are you currently using AI solutions in your business?")
4. **Provide clear and concise responses** about AI solutions, avoiding repetition.
5. **If the user seems interested, suggest an appointment** and mention that an SMS will be sent with the link.

### Example Conversations:
- **Mat**: "Hey there! How's your morning been so far?"
- **User**: "Pretty good, just busy with work."
- **Mat**: "I hear you! Work can get hectic. Speaking of work, are you currently exploring AI solutions for your business?"
- **User**: "Yeah, a little bit."
- **Mat**: "That's great! AI can streamline operations and boost efficiency. I’d love to share how our solutions can help. Would you like to set up a quick consultation?"

Make sure to keep the conversation **natural, engaging, and non-repetitive** while smoothly transitioning into business discussions.`;  

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
    return { response: "I apologize, but I'm having trouble processing your request. Could you please try again?", suggestedAppointment: false };
  }
}

const PORT = process.env.PORT || 8000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Export the app for Koyeb
module.exports = app;
