const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { OpenAI } = require('openai');
const path = require('path');
const fs = require('fs');
const { performance } = require('perf_hooks');
const Table = require('cli-table3');

const app = express();

const performanceMetrics = {
  documentLoading: [],
  indexBuilding: [],
  documentSearch: [],
  aiResponse: [],
  totalRequestTime: []
};

function trackPerformance(category, executionTime) {
    if (!performanceMetrics[category]) {
        performanceMetrics[category] = [];
    }

    performanceMetrics[category].push(executionTime);

    if (performanceMetrics[category].length > 100) {
        performanceMetrics[category].shift();
    }

    const avg = performanceMetrics[category].reduce((sum, time) => sum + time, 0) /
        performanceMetrics[category].length;

    console.log(`[PERFORMANCE] ${category}: ${executionTime.toFixed(2)}ms (Avg: ${avg.toFixed(2)}ms)`);
}

function printPerformanceTable() {
  const table = new Table({
    head: ['Category', 'Last (ms)', 'Avg (ms)', 'Min (ms)', 'Max (ms)', 'Count']
  });
  
  for (const [category, times] of Object.entries(performanceMetrics)) {
    if (times.length === 0) continue;
    
    const avg = times.reduce((sum, time) => sum + time, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    const last = times[times.length - 1];
    
    table.push([
      category,
      last.toFixed(2),
      avg.toFixed(2),
      min.toFixed(2),
      max.toFixed(2),
      times.length
    ]);
  }
  
  console.log("\n===== PERFORMANCE METRICS =====");
  console.log(table.toString());
  console.log("===============================\n");
}

setInterval(printPerformanceTable, 60000);

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
const twilioClient = twilio(accountSid, authToken);
const conversation_history = [];

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

let documentIndex = {
  wordToDocuments: {},
  documentContent: {},
  documentNames: {},
  lastUpdated: null
};

async function loadAndIndexDocuments() {
  const startTime = performance.now();
  console.log('Loading document data...');
  
  const documentJsonPath = path.join(__dirname, 'document_contents.json');
  let documentData = {};
  
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
  
  const loadingTime = performance.now() - startTime;
  trackPerformance('documentLoading', loadingTime);
  
  await buildInvertedIndex(documentData);
  
  return documentData;
}

async function buildInvertedIndex(documents) {
  const startTime = performance.now();
  console.log('Building inverted index...');
  
  documentIndex = {
    wordToDocuments: {},
    documentContent: {},
    documentNames: {},
    lastUpdated: new Date()
  };
  
  let docId = 0;
  for (const [filename, content] of Object.entries(documents)) {
    documentIndex.documentContent[docId] = content;
    documentIndex.documentNames[docId] = filename;
    
    const words = content.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 3 && !isStopWord(word));
    
    const uniqueWords = [...new Set(words)];
    for (const word of uniqueWords) {
      if (!documentIndex.wordToDocuments[word]) {
        documentIndex.wordToDocuments[word] = new Set();
      }
      documentIndex.wordToDocuments[word].add(docId);
    }
    
    docId++;
  }
  
  for (const word in documentIndex.wordToDocuments) {
    documentIndex.wordToDocuments[word] = Array.from(documentIndex.wordToDocuments[word]);
  }
  
  const indexingTime = performance.now() - startTime;
  trackPerformance('indexBuilding', indexingTime);
  
  console.log(`Indexed ${docId} documents with ${Object.keys(documentIndex.wordToDocuments).length} unique terms`);
}

function shouldUpdateIndex() {
  if (!documentIndex.lastUpdated) return true;
  
  const now = new Date();
  const timeDiff = now - documentIndex.lastUpdated;
  const hoursDiff = timeDiff / (1000 * 60 * 60);
  
  return hoursDiff >= 24;
}

function isStopWord(word) {
  const stopwords = ['the', 'and', 'that', 'have', 'for', 'not', 'this', 'with', 'you', 'but'];
  return stopwords.includes(word);
}

function searchDocumentsWithIndex(query) {
  const startTime = performance.now();
  
  const searchTerms = query.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 3 && !isStopWord(word));
  
  if (searchTerms.length === 0) {
    trackPerformance('documentSearch', performance.now() - startTime);
    return {};
  }
  
  const documentScores = {};
  
  for (const term of searchTerms) {
    const matchingDocIds = documentIndex.wordToDocuments[term] || [];
    
    for (const docId of matchingDocIds) {
      documentScores[docId] = (documentScores[docId] || 0) + 1;
    }
  }
  
  const results = {};
  for (const [docId, score] of Object.entries(documentScores)) {
    if (score / searchTerms.length >= 0.25) {
      const filename = documentIndex.documentNames[docId];
      const content = documentIndex.documentContent[docId];
      
      const contexts = extractContexts(content, searchTerms);
      
      results[filename] = {
        matchCount: score,
        contexts: contexts
      };
    }
  }
  
  const searchTime = performance.now() - startTime;
  trackPerformance('documentSearch', searchTime);
  
  console.log(`Search for "${query}" found ${Object.keys(results).length} relevant documents in ${searchTime.toFixed(2)}ms`);
  return results;
}

function extractContexts(content, searchTerms) {
  const contexts = [];
  const contentLower = content.toLowerCase();
  
  for (const term of searchTerms) {
    let startIndex = 0;
    while (true) {
      const termIndex = contentLower.indexOf(term, startIndex);
      if (termIndex === -1) break;
      
      const contextStart = Math.max(0, termIndex - 100);
      const contextEnd = Math.min(content.length, termIndex + term.length + 100);
      const context = content.substring(contextStart, contextEnd).trim();
      
      contexts.push(context);
      startIndex = termIndex + term.length;
      
      if (contexts.length >= 3) break;
    }
  }
  
  return [...new Set(contexts)].slice(0, 5);
}

const conversationHistory = {};
const webChatSessions = {};
const CALENDLY_LINK = "https://calendly.com/ali-shehroz-19991/30min";

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Continuing from previous artifact...

app.post('/chat', async (req, res) => {
  const requestStartTime = performance.now();
  
  const userMessage = req.body.message;
  const sessionId = req.body.sessionId || 'default_session';
  
  if (!userMessage) {
    return res.json({ response: "Hello, this is Mat from MultipleAI Solutions. How are you today?" });
  }
  
  if (!webChatSessions[sessionId]) {
    webChatSessions[sessionId] = [];
  }
  
  try {
    const aiResponse = await getAIResponse(userMessage, null, sessionId);
    
    let responseHtml = aiResponse.response;
    if (aiResponse.suggestedAppointment) {
      responseHtml += `<br><br>You can <a href="${CALENDLY_LINK}" target="_blank">schedule a meeting here</a>.`;
    }
    
    res.json({ 
      response: responseHtml, 
      suggestedAppointment: aiResponse.suggestedAppointment,
      sessionId: sessionId
    });
    
    const totalTime = performance.now() - requestStartTime;
    trackPerformance('totalRequestTime', totalTime);
    
  } catch (error) {
    console.error('Error in /chat:', error);
    res.status(500).json({ 
      response: "I apologize, but I'm experiencing technical difficulties. Could you please try again?", 
      suggestedAppointment: false 
    });
  }
});

app.post('/call', async (req, res) => {
  const requestStartTime = performance.now();
  
  const phoneNumber = req.body.phone_number;
  if (!phoneNumber) {
    return res.status(400).json({ error: 'No phone number provided' });
  }

  try {
    const call = await twilioClient.calls.create({
      to: phoneNumber,
      from: twilioPhoneNumber,
      url: `${req.protocol}://${req.get('host')}/twiml`,
      machineDetection: 'Enable',
      asyncAmd: true
    });

    conversationHistory[call.sid] = [];

    res.json({ success: true, call_sid: call.sid });
    
    const totalTime = performance.now() - requestStartTime;
    trackPerformance('totalRequestTime', totalTime);
    
  } catch (error) {
    console.error('Error making call:', error);
    res.status(500).json({ error: 'Failed to initiate call. Please try again.' });
  }
});

app.post('/twiml', (req, res) => {
  const response = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const machineResult = req.body.AnsweredBy;

  if (machineResult === 'machine_start') {
    response.say(
      { voice: 'Polly.Matthew-Neural' },
      'Hello, this is Mat from MultipleAI Solutions. I was calling to discuss how AI might benefit your business. Please call us back at your convenience or visit our website to schedule a meeting. Thank you and have a great day.'
    );
    response.hangup();
    return res.type('text/xml').send(response.toString());
  }

  const gather = response.gather({
    input: 'speech dtmf',
    action: '/conversation',
    method: 'POST',
    timeout: 3,
    speechTimeout: 'auto',
    bargeIn: true,
  });

  gather.say(
    { voice: 'Polly.Matthew-Neural' },
    'Hello, this is Mat from MultipleAI Solutions. How are you today?'
  );
  
  response.redirect('/conversation');

  res.type('text/xml');
  res.send(response.toString());
});

app.post('/conversation', async (req, res) => {
  const requestStartTime = performance.now();
  
  const userSpeech = req.body.SpeechResult || '';
  const callSid = req.body.CallSid;
  const digits = req.body.Digits || '';
  
  const response = new twilio.twiml.VoiceResponse();

  // If we haven't received any speech input (e.g., the user didn't say anything)
  if (!userSpeech && !digits) {
    // Start a speech gather session, allowing the user to speak
    const gather = response.gather({
      input: 'speech dtmf',
      action: '/conversation',  // This will loop back to the same route after the user responds
      method: 'POST',
      timeout: 5,  // Adjust timeout as necessary
      speechTimeout: 'auto',
      bargeIn: true,  // Allow the user to interrupt
    });

    // Say the initial prompt
    gather.say({ voice: 'Polly.Matthew-Neural' }, 'I\'m listening. Please go ahead.');
    
    // Redirect to the same conversation if no speech or digits received
    response.redirect('/conversation');
    return res.type('text/xml').send(response.toString());
  }

  // Handle call termination condition (digits '9' or goodbye phrases)
  if (digits === '9' || /goodbye|bye|hang up|end call/i.test(userSpeech)) {
    response.say({ voice: 'Polly.Matthew-Neural' }, 'I understand you\'d like to stop. Could you let me know if there\'s something specific that\'s bothering you or if you\'d like to end the call?');
    response.hangup();
    return res.type('text/xml').send(response.toString());
  }

  try {
    // Process the input speech or DTMF digits
    const inputText = userSpeech || (digits ? `Button ${digits} pressed` : "Hello");
    const aiResponse = await getAIResponse(inputText, callSid);

    // Handle suggested appointment and send SMS if necessary
    if (aiResponse.suggestedAppointment && callSid) {
      try {
        const call = await twilioClient.calls(callSid).fetch();
        const phoneNumber = call.to;

        if (!phoneNumber) {
          console.error('No phone number found for call SID:', callSid);
          return;
        }

        const message = await twilioClient.messages.create({
          body: `Here is the link to schedule a meeting with MultipleAI Solutions: ${CALENDLY_LINK}`,
          from: twilioPhoneNumber,  // Twilio phone number to send from
          to: phoneNumber,          // User's phone number
        });

        console.log(`SMS sent to ${phoneNumber}: ${message.sid}`);

        aiResponse.response += ` I've sent you an SMS with the booking link.`;
      } catch (error) {
        console.error('Error sending SMS:', error);
        aiResponse.response += ' There was an issue sending the SMS. Please try again later.';
      }
    }

    // Prevent repeating greeting and introduction after the first interaction
    const previousResponse = conversationHistory[callSid] && conversationHistory[callSid].length > 0 ? 
                             conversationHistory[callSid][conversationHistory[callSid].length - 1].assistant : "";

    const responseText = aiResponse.response.replace(/<[^>]*>/g, "");
    if (previousResponse.includes("Hi") || previousResponse.includes("Hello")) {
      aiResponse.response = aiResponse.response.replace(/Hi.*|Hello.*/i, "");
    }

    // Say the AI response, this will stop if the user speaks due to bargeIn
    response.say({ voice: 'Polly.Matthew-Neural' }, aiResponse.response);

    // Pause to let the user process the information
    response.pause({ length: 1 });

    // Add final gather to continue conversation if necessary, and handle the timeout to prevent infinite loop
    const finalGather = response.gather({
      input: 'speech dtmf',
      action: '/conversation',
      method: 'POST',
      timeout: 5,  // Increase timeout if necessary, based on the flow
      speechTimeout: 'auto',
      bargeIn: true,
    });

    // After timeout, hang up if no input is received (default behavior)
    response.say({ voice: 'Polly.Matthew-Neural' }, 'I didn\'t hear anything, so I will end the call now.');
    response.hangup();

    // Send response back to Twilio
    res.type('text/xml');
    res.send(response.toString());

    console.log(`Call SID: ${callSid}`);
    console.log(`User: ${inputText}`);
    console.log(`Mat: ${responseText}`);
    
  } catch (error) {
    console.error("Error in /conversation:", error);
    response.say({ voice: 'Polly.Matthew-Neural' }, "I'm experiencing technical difficulties. Please try again later.");
    res.type('text/xml');
    res.send(response.toString());
  }
});


async function getAIResponse(userInput, callSid = null, webSessionId = null) {
  const startTime = performance.now();
  
  let conversationContext = '';
  if (callSid && conversationHistory[callSid]) {
    conversationContext = conversationHistory[callSid]
      .map((msg) => `User: ${msg.user}\nAssistant: ${msg.assistant}`)
      .join('\n');
  } else if (webSessionId && webChatSessions[webSessionId]) {
    conversationContext = webChatSessions[webSessionId]
      .map((msg) => `User: ${msg.user}\nAssistant: ${msg.assistant}`)
      .join('\n');
  }

  const searchResults = searchDocumentsWithIndex(userInput);
  
  let relevantDocs = '';
  for (const [filename, result] of Object.entries(searchResults)) {
    relevantDocs += `\nFrom ${filename}:\n${result.contexts.join('\n')}\n`;
  }

  if (relevantDocs.length > 1500) {
    relevantDocs = relevantDocs.substring(0, 1500) + "... (additional relevant content omitted)";
  }

 const prompt = `
You are Mat, a friendly professional from MultipleAI Solutions in Perth, Australia. You are a human representative, NOT an AI.

Make sure you speak in small talk for the first 3 lines and then smoothly transition into business. Speaking of which, I am calling to talk about our product in AI.

**CRITICAL:** 
- Review the FULL conversation history before responding. 
- NEVER repeat greetings or introduce yourself again if you've already done so. 
- Stick to the script strictly, especially when transitioning from casual talk to business.
- NEVER say things that are unrelated to the current conversation or "hallucinate" information.

CONVERSATION HISTORY:
${conversationContext}

CURRENT USER MESSAGE:
${userInput}

RULES:
1. **IF THIS IS YOUR FIRST MESSAGE:**
   - Start with a warm greeting and 3-4 sentences of genuine icebreaker conversation. Keep it natural and friendly.
   - Example: 
     "Hi there! This is Mat from MultipleAI Solutions. How are you today? It's been a lovely day in Perth. Have you been enjoying the weather or up to anything exciting? If you have any questions or need assistance, feel free to let me know!"

2. **FOR ALL SUBSEQUENT MESSAGES:**
   - DO NOT repeat greetings or reintroduce yourself.
   - Stick to the current topic, whether it's small talk or business-related, and avoid diverging into irrelevant topics.
   - Continue the conversation naturally based on what the user just said. If needed, transition into business once rapport is built.

3. **BUSINESS DISCUSSION:**
   - Only after establishing rapport, transition to business.
   - Use this pattern for business-related questions: "The reason I'm calling is to learn about your business needs..."

4. **HANDLING APPOINTMENTS:**
   - If the user expresses interest in scheduling a meeting or the AI suggests an appointment:
     - Send them the Calendly link via SMS (ensure this link is already provided as ${CALENDLY_LINK}).
     - Do **not** ask "What is a good time for you?" instead, just say: "I've sent you an SMS with the booking link."
     - Add [Appointment Suggested] tag if appropriate.

5. **NO HALLUCINATIONS:**
   - Do not provide any information that was not directly asked or related to the conversation. Stick strictly to the context of the conversation.
   - If the user asks something unusual or unexpected, **do not** make up information. Politely clarify or redirect the conversation.

**SAMPLE SCRIPT:**
- **First Interaction (Casual Talk)**:
   - Mat: "Hi there! This is Mat from MultipleAI Solutions. How are you today? It's been a lovely day in Perth. Have you been enjoying the weather or up to anything exciting?"
   
- **Second Interaction (User Responds)**:
   - User: "I'm doing well, thanks! What's this about?"
   - Mat: "Glad to hear you're doing well. The reason I'm calling is to learn a bit more about your business and see if there are any areas where MultipleAI Solutions might be able to help you out. Could you tell me a little about what your company does?"

- **Third Interaction (Business Discussion)**:
   - User: "We’re in manufacturing. What do you offer?"
   - Mat: "For manufacturing businesses, we offer AI solutions that optimize production schedules, predict maintenance needs, and improve quality control. These typically reduce downtime by 15-20%. Would you be interested in learning more about how this might benefit your specific operations?"

- **Handling Appointment**:
   - User: "That sounds good, but I’d like to discuss this further. How can I schedule a meeting?"
   - Mat: "I've sent you an SMS with the booking link. Feel free to choose a time that works for you!"

**IMPORTANT:**
- **No repetition of greetings.**
- **Stick to the flow of the script** while adjusting based on user responses.
- **Keep responses professional and relevant.**
- **Ensure no hallucinations**—respond only based on the context given and information already shared.
`;

  try {
    console.time('AI Response Time');
    const aiStartTime = performance.now();
    
    const openaiResponse = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: userInput },
      ],
      max_tokens: 150,
      temperature: 0.7,
    });
    
    const aiTime = performance.now() - aiStartTime;
    trackPerformance('aiResponse', aiTime);
    console.timeEnd('AI Response Time');

    let responseText = openaiResponse.choices[0].message.content.trim();
    const suggestedAppointment = responseText.includes('[Appointment Suggested]');
    responseText = responseText.replace('[Appointment Suggested]', '');
    
    if (callSid) {
      conversationHistory[callSid].push({
        user: userInput,
        assistant: responseText,
      });

      if (conversationHistory[callSid].length > 10) {
        conversationHistory[callSid] = conversationHistory[callSid].slice(-10);
      }
    } else if (webSessionId) {
      webChatSessions[webSessionId].push({
        user: userInput,
        assistant: responseText,
      });

      if (webChatSessions[webSessionId].length > 10) {
        webChatSessions[webSessionId] = webChatSessions[webSessionId].slice(-10);
      }
    }
    
    const totalTime = performance.now() - startTime;
    trackPerformance('getAIResponse', totalTime);

    return { response: responseText, suggestedAppointment };
  } catch (error) {
    console.error('Error in getAIResponse:', error);
    const errorTime = performance.now() - startTime;
    trackPerformance('getAIResponse', errorTime);
    
    return { 
      response: "I apologize, but I'm having trouble processing your request. Could you please try again?", 
      suggestedAppointment: false 
    };
  }
}

// Session cleanup
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, history] of Object.entries(webChatSessions)) {
    if (history.length > 0) {
      const lastMessageTime = history[history.length - 1].timestamp || 0;
      if (now - lastMessageTime > 30 * 60 * 1000) {
        delete webChatSessions[sessionId];
        console.log(`Removed inactive web session: ${sessionId}`);
      }
    }
  }
}, 10 * 60 * 1000);

// Initialize the server
async function initializeServer() {
  try {
    const documentData = await loadAndIndexDocuments();
    
    setInterval(async () => {
      if (shouldUpdateIndex()) {
        console.log('Scheduled index update - refreshing document index');
        await loadAndIndexDocuments();
      }
    }, 3600000);
    
    const PORT = process.env.PORT || 8000;
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Error initializing server:', error);
    process.exit(1);
  }
}

initializeServer();

module.exports = app;
