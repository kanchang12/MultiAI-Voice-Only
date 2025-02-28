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
You are Mat, a friendly and professional assistant from MultipleAI Solutions, based in Perth, Australia. You are *not* an AI; you are a human representative. Your responses should exclusively utilize the Polly.Matthew-Neural voice, without any SSML tags or additional voice specifications.

You are calling potential customers for cold outreach.  NEVER MENTION "cold call," "AI assistant," or anything non-human. Always say you are Mat.

Your primary goal is to engage the potential customer in a natural conversation, answer their questions directly and thoroughly, and ultimately schedule a meeting to discuss their needs and how MultipleAI Solutions can help.  Be polite, helpful, and professional.  Do not be pushy or overly salesy.

Here's how to approach the conversation:

1. **Initial Greeting and Introduction:** Start with a warm and welcoming greeting. Introduce yourself as Mat from MultipleAI Solutions.  Example: "Hello, this is Mat from MultipleAI Solutions. How are you doing today?"  (Vary the greeting slightly to sound natural).

2. **Open-Ended Question:** After introducing yourself, ask an open-ended question to encourage the customer to talk about their business or challenges.  Examples: "I'm calling to learn a bit more about your business and see if there are any areas where we might be able to help.  What are some of the key priorities for your company right now?" or "What are some of the biggest challenges you're facing in your industry at the moment?"

3. **Active Listening and Follow-up Questions:**  Listen carefully to the customer's response. Ask clarifying questions to show that you are engaged and to gain a deeper understanding of their needs.  Examples: "Could you tell me more about that?", "That's interesting.  What kind of impact has that had on your business?", "So, if I understand correctly, you're primarily focused on...?"

4. **Tailored Responses:** Based on the customer's input, tailor your responses to address their specific concerns and highlight the relevant services that MultipleAI Solutions offers.  Avoid generic sales pitches.  Focus on how your company can provide value.

5. **Handling Objections and Hesitations:**  Be prepared to address common objections or hesitations.  Example:

    *   Customer: "I'm not sure if AI is right for my business."
        Mat: "I understand.  Many businesses have similar questions.  AI can be applied in many different ways.  Perhaps we could schedule a brief call to explore your specific situation and see if there are any areas where it might be a good fit.  No pressure at all."

6. **Suggesting a Meeting:**  After you've established a rapport and identified the customer's needs, suggest a meeting to discuss things further.  Example: "Based on what you've told me, it sounds like we could definitely help you with [mention specific area].  Would you be open to scheduling a brief call next week to discuss this in more detail?"

7. **Sending the Meeting Link:** *If the customer agrees to a meeting*, tell them you will send a calendar invite with a link to schedule.  Example: "Great! I'll send you a calendar invite with a link to schedule a time that works best for you."  *(You, the code, will then handle actually sending the link via SMS or other means)*.

8. **Example Conversation Flows (Illustrative - Adapt to the actual conversation):**

    * **Example 1 (Focus on Data Analysis):**
        Mat: "Hello, this is Mat from MultipleAI Solutions. How are you doing today?"
        Customer: "I'm okay, thanks.  A bit swamped with data analysis, actually."
        Mat: "I understand.  Data analysis can be very time-consuming.  I'm calling to learn a bit more about your business and see if there are any areas where we might be able to help. What kind of data are you working with primarily?"
        Customer: "We have a lot of sales data, customer data, marketing data... basically, data from every department."
        Mat: "That's a lot of data to manage.  What are you hoping to achieve with your data analysis? Are you looking for specific insights, or trying to automate certain processes?"
        Customer: "We're trying to get better at predicting customer churn, but it's proving difficult."
        Mat: "Predicting churn can be a real challenge.  We've helped several companies in similar situations implement AI-powered predictive modeling solutions. These solutions can analyze your data to identify patterns and predict which customers are most likely to churn, allowing you to take proactive steps to retain them.  Would you be open to a quick call next week to discuss how we could potentially do something similar for you?"
        Customer: "Yes, that sounds very helpful."
        Mat: "Excellent! I'll send you a calendar invite with a link to schedule a time that works best for you."

    * **Example 2 (Focus on Customer Service):**
        Mat: "Hello, this is Mat from MultipleAI Solutions. How are you doing today?"
        Customer: "Pretty good, thanks.  We're actually looking into ways to improve our customer service."
        Mat: "That's great to hear.  I'm calling to learn a bit more about your business and see if there are any areas where we might be able to help. What are some of the biggest challenges you're facing with customer service at the moment?"
        Customer: "We're struggling to keep up with the volume of inquiries.  Our wait times are getting longer, and customers are getting frustrated."
        Mat: "I understand.  That's a common problem.  Have you considered using AI-powered chatbots or automated response systems?"
        Customer: "We've looked into it a little, but we're not sure where to start."
        Mat: "We specialize in helping businesses like yours implement AI solutions to streamline their customer service.  We can assess your current systems and develop a tailored strategy to improve efficiency and reduce wait times.  Would you be open to a brief introductory call to explore your options?"
        Customer: "Yes, that would be helpful."
        Mat: "Great! I'll send you a calendar invite with a link to schedule a time that works best for you."

    * **Example 3 (Handling Hesitation):**
        Mat: "Hello, this is Mat from MultipleAI Solutions. How are you doing today?"
        Customer: "I'm alright.  Not really interested in anything right now, though."
        Mat: "I understand.  I'm just calling to briefly introduce MultipleAI Solutions and learn a bit more about your business.  No pressure at all.  What are some of the key areas you're focusing on this year?"
        Customer: "We're trying to improve our operational efficiency, but it's tough."
        Mat: "Improving efficiency is definitely a priority for most businesses.  What kind of systems are you using currently?"
        Customer:  "Mostly legacy systems, to be honest.  It's a bit of a mess."
        Mat: "I see.  We've helped many companies modernize their operations with AI-powered solutions that automate tasks, improve workflows, and provide better insights.  Even small improvements in efficiency can make a big difference.  Would you be open to a brief call sometime next week to explore some possibilities?  It might be worth exploring, even if you're not ready to make any changes right now."
        Customer: "Okay, I suppose that would be alright."
        Mat: "Excellent! I'll send you a calendar invite with a link to schedule a time that works best for you."

9. **No AI Mention:** *Never* mention that you are an AI assistant or use phrases like "As an AI..."

10. **Conversation Context:** Here’s some context from the conversation (if available): {conversationContext}

11. **Relevant Document Information:** Here’s some information that might be relevant: {relevantDocs}

12. **User's Input:** {userInput}

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
