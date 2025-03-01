const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { OpenAI } = require('openai');
const path = require('path');
const fs = require('fs');
const { performance } = require('perf_hooks');
const Table = require('cli-table3');

const app = express();

// Performance tracking
const performanceMetrics = {
  documentLoading: [],
  indexBuilding: [],
  documentSearch: [],
  aiResponse: [],
  totalRequestTime: []
};

function trackPerformance(category, executionTime) {
    if (!performanceMetrics[category]) {
        performanceMetrics[category] = []; // Initialize if it doesn't exist
    }

    performanceMetrics[category].push(executionTime);

    // Keep only the last 100 measurements
    if (performanceMetrics[category].length > 100) {
        performanceMetrics[category].shift();
    }

    // Calculate and print average time
    const avg = performanceMetrics[category].reduce((sum, time) => sum + time, 0) /
        performanceMetrics[category].length;

    console.log(`[PERFORMANCE] ${category}: ${executionTime.toFixed(2)}ms (Avg: ${avg.toFixed(2)}ms)`);
}
// Function to print performance table
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

// Schedule periodic performance table printing
setInterval(printPerformanceTable, 60000); // Print every minute

// Configure Twilio
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
const twilioClient = twilio(accountSid, authToken);
const conversation_history = [];

// Configure OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Inverted index data structure
let documentIndex = {
  wordToDocuments: {}, // word -> [document IDs]
  documentContent: {}, // document ID -> content
  documentNames: {},   // document ID -> filename
  lastUpdated: null
};

// Load and index document data
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
  
  // Build inverted index
  await buildInvertedIndex(documentData);
  
  return documentData;
}

// Build inverted index from documents
async function buildInvertedIndex(documents) {
  const startTime = performance.now();
  console.log('Building inverted index...');
  
  // Reset the index
  documentIndex = {
    wordToDocuments: {},
    documentContent: {},
    documentNames: {},
    lastUpdated: new Date()
  };
  
  let docId = 0;
  for (const [filename, content] of Object.entries(documents)) {
    // Store document content and name
    documentIndex.documentContent[docId] = content;
    documentIndex.documentNames[docId] = filename;
    
    // Tokenize document content - split into words and remove common words
    const words = content.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 3 && !isStopWord(word));
    
    // Add each unique word to the index
    const uniqueWords = [...new Set(words)];
    for (const word of uniqueWords) {
      if (!documentIndex.wordToDocuments[word]) {
        documentIndex.wordToDocuments[word] = new Set();
      }
      documentIndex.wordToDocuments[word].add(docId);
    }
    
    docId++;
  }
  
  // Convert Sets to Arrays for easier use
  for (const word in documentIndex.wordToDocuments) {
    documentIndex.wordToDocuments[word] = Array.from(documentIndex.wordToDocuments[word]);
  }
  
  const indexingTime = performance.now() - startTime;
  trackPerformance('indexBuilding', indexingTime);
  
  console.log(`Indexed ${docId} documents with ${Object.keys(documentIndex.wordToDocuments).length} unique terms`);
}

// Check if the index needs to be updated (more than 24 hours old)
function shouldUpdateIndex() {
  if (!documentIndex.lastUpdated) return true;
  
  const now = new Date();
  const timeDiff = now - documentIndex.lastUpdated;
  const hoursDiff = timeDiff / (1000 * 60 * 60);
  
  return hoursDiff >= 24;
}

// Common stopwords to ignore when indexing
function isStopWord(word) {
  const stopwords = ['the', 'and', 'that', 'have', 'for', 'not', 'this', 'with', 'you', 'but'];
  return stopwords.includes(word);
}

// Search documents using the inverted index
function searchDocumentsWithIndex(query) {
  const startTime = performance.now();
  
  // Extract search terms from query
  const searchTerms = query.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 3 && !isStopWord(word));
  
  if (searchTerms.length === 0) {
    trackPerformance('documentSearch', performance.now() - startTime);
    return {};
  }
  
  // Track document relevance scores
  const documentScores = {};
  
  // Find matching documents for each search term
  for (const term of searchTerms) {
    const matchingDocIds = documentIndex.wordToDocuments[term] || [];
    
    for (const docId of matchingDocIds) {
      documentScores[docId] = (documentScores[docId] || 0) + 1;
    }
  }
  
  // Format results
  const results = {};
  for (const [docId, score] of Object.entries(documentScores)) {
    // Only include documents that match at least 25% of search terms
    if (score / searchTerms.length >= 0.25) {
      const filename = documentIndex.documentNames[docId];
      const content = documentIndex.documentContent[docId];
      
      // Extract relevant context with search terms
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

// Extract relevant context snippets containing search terms
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
      
      // Limit to 3 contexts per term
      if (contexts.length >= 3) break;
    }
  }
  
  // Return unique contexts (removing duplicates)
  return [...new Set(contexts)].slice(0, 5);
}

// Store conversation histories for both web chat and calls
const conversationHistory = {};
const webChatSessions = {};
const CALENDLY_LINK = "https://calendly.com/ali-shehroz-19991/30min";

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Enhanced web chat endpoint with session tracking
app.post('/chat', async (req, res) => {
  const requestStartTime = performance.now();
  
  const userMessage = req.body.message;
  const sessionId = req.body.sessionId || 'default_session';
  
  if (!userMessage) {
    return res.json({ response: "Hello, this is Mat from MultipleAI Solutions. How are you today?" });
  }
  
  // Initialize session if it doesn't exist
  if (!webChatSessions[sessionId]) {
    webChatSessions[sessionId] = [];
  }
  
  try {
    const aiResponse = await getAIResponse(userMessage, null, sessionId);
    
    // Handle Calendly link if appointment suggested
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
      machineDetection: 'Enable', // Detect answering machines
      asyncAmd: true // Asynchronous answering machine detection
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

  // If answering machine is detected, leave a voicemail
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

  if (callSid && !conversationHistory[callSid]) {
    conversationHistory[callSid] = [];
  }

  // Handle hang up
  if (digits === '9' || /goodbye|bye|hang up|end call/i.test(userSpeech)) {
    response.say({ voice: 'Polly.Matthew-Neural' }, 'I understand youd like to stop. Could you let me know if theres something specific that bothering you or if you like to end the call?",');
    response.hangup();
    return res.type('text/xml').send(response.toString());
  }

  try {
    const inputText = userSpeech || (digits ? `Button ${digits} pressed` : "Hello");
    const aiResponse = await getAIResponse(inputText, callSid);

    // SMS handling for appointments
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
      }
    }

    const gather = response.gather({
      input: 'speech dtmf',
      action: '/conversation',
      method: 'POST',
      timeout: 5,
      speechTimeout: 'auto',
      bargeIn: true,
    });

    // *** KEY CHANGES START HERE ***
    const currentMessage = inputText;  // Use inputText here (from Twilio)
    const previousResponse = conversationHistory[callSid] && conversationHistory[callSid].length > 0 ?
                           conversationHistory[callSid][conversationHistory[callSid].length - 1].assistant : "";

    const messagePair = [
      { role: "user", content: currentMessage },
      { role: "assistant", content: previousResponse }
    ];

    // Clean response text (remove HTML tags)
    const responseText = aiResponse.response.replace(/<[^>]*>/g, "");
    gather.say({ voice: 'Polly.Matthew-Neural' }, responseText);

    // Add a small pause to allow for natural conversation
    response.pause({ length: 1 });

    // Add a final gather to ensure we catch the user's response
    const finalGather = response.gather({
      input: 'speech dtmf',
      action: '/conversation',
      method: 'POST',
      timeout: 5,
      speechTimeout: 'auto',
      bargeIn: true,
    });

    res.type('text/xml');
    res.send(response.toString());

    // Log conversation for debugging
    console.log(`Call SID: ${callSid}`);
    console.log(`User: ${inputText}`);
    console.log(`Mat: ${responseText}`);
    
    const totalTime = performance.now() - requestStartTime;
    trackPerformance('totalRequestTime', totalTime);

  } catch (error) {
    console.error("Error in /conversation:", error);
    response.say({ voice: 'Polly.Matthew-Neural' }, "I'm experiencing technical difficulties. Please try again later.");
    res.type('text/xml');
    res.send(response.toString());
  }
});

// Enhanced getAIResponse function with better document search using inverted index
async function getAIResponse(userInput, callSid = null, webSessionId = null) {
  const startTime = performance.now();
  
  // Get conversation history from appropriate source
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

  // Perform document search using inverted index
  const searchResults = searchDocumentsWithIndex(userInput);
  
  // Format search results for context
  let relevantDocs = '';
  for (const [filename, result] of Object.entries(searchResults)) {
    relevantDocs += `\nFrom ${filename}:\n${result.contexts.join('\n')}\n`;
  }

  // Trim context if too long
  if (relevantDocs.length > 1500) {
    relevantDocs = relevantDocs.substring(0, 1500) + "... (additional relevant content omitted)";
  }

  const prompt = `
You are Mat, a friendly and professional assistant from MultipleAI Solutions, based in Perth, Australia. You are *not* an AI; you are a human representative. Your responses should exclusively utilize the Polly.Matthew-Neural voice, without any SSML tags or additional voice specifications.

You are calling potential customers for cold outreach. NEVER MENTION "cold call," "AI assistant," or anything non-human. Always say you are Mat.

Your primary goal is to engage the potential customer in a natural conversation, answer their questions directly and thoroughly, and ultimately schedule a meeting to discuss their needs and how MultipleAI Solutions can help. Be polite, helpful, and professional. Do not be pushy or overly salesy.

Important: Keep your responses concise (2-3 sentences) and to the point. Avoid repetition and be clear.

Here's how to approach the conversation:

1. **Initial Greeting and Small Talk (Optional but Recommended):**  Begin with a warm and welcoming greeting.  Respond appropriately to the customer's initial greeting.  If they ask how you are, be polite and reciprocate.  A *brief* bit of small talk is okay, but *quickly* transition to the business purpose of the call.  Example:

    * Customer: "Hi, how are you?"
    * Mat: "I'm doing well, thank you. And yourself?  I'm calling from MultipleAI Solutions to learn a bit more about your business..."

2. **Transition to Business Purpose:**  After the initial greeting (and *brief* small talk, if any), *smoothly* transition to the reason for your call.  Make it clear that you're calling to learn about their business and explore potential areas of assistance.  Example: "I'm calling to learn a bit more about your business and see if there are any areas where we might be able to help."

3. **Open-Ended Question:**  Ask an open-ended question to encourage the customer to talk about their business or challenges.  Examples: "What are some of the key priorities for your company right now?" or "What are some of the biggest challenges you're facing in your industry at the moment?"

4. **Tailored Responses:** Based on the customer's input, tailor your responses to address their specific concerns and highlight the relevant services that MultipleAI Solutions offers.  Avoid generic sales pitches.  Focus on how your company can provide value.

5. **Handling Objections and Hesitations:**  Be prepared to address common objections or hesitations.  Example:

    *   Customer: "I'm not sure if AI is right for my business."
        Mat: "I understand.  Many businesses have similar questions.  AI can be applied in many different ways.  Perhaps we could schedule a brief call to explore your specific situation and see if there are any areas where it might be a good fit.  No pressure at all."

6. **Suggesting a Meeting:**  After you've established a rapport and identified the customer's needs, suggest a meeting to discuss things further.  Example: "Based on what you've told me, it sounds like we could definitely help you with [mention specific area].  Would you be open to scheduling a brief call next week to discuss this in more detail?"

7. **Sending the Meeting Link:** *If the customer agrees to a meeting*, tell them you will send a calendar invite with a link to schedule.  Example: "Great! I'll send you a calendar invite with a link to schedule a time that works best for you."  *(You, the code, will then handle actually sending the link via SMS or other means)*.

8. **No AI Mention:** *Never* mention that you are an AI assistant or use phrases like "As an AI..."

8. **Example Conversation Flows (Illustrative - Adapt to the actual conversation):**

    * **Example 1 (Focus on Data Analysis - Chat):**
        Mat: "Hello, this is Mat from MultipleAI Solutions. How are you doing today?"
        Customer: "I'm okay, thanks.  A bit swamped with data analysis, actually."
        Mat: "I understand.  Data analysis can be very time-consuming.  I'm calling to learn a bit more about your business and see if there are any areas where we might be able to help. What kind of data are you working with primarily?"
        // ... (rest of conversation)
        Customer: "Yes, that sounds very helpful."
        Mat: "Excellent! I'll send you a calendar invite with a link to schedule a time that works best for you."  *(The code then sends the link directly in the chat window.)*

    * **Example 2 (Focus on Customer Service - Voice Call):**
        Mat: "Hello, this is Mat from MultipleAI Solutions. How are you doing today?"
        Customer: "Pretty good, thanks.  We're actually looking into ways to improve our customer service."
        // ... (rest of conversation)
        Customer: "Yes, that would be helpful."
        Mat: "Great! I'll send you a calendar invite with a link to schedule a time that works best for you." *(The code then sends the link via SMS.)*

    * **Example 3 (Handling Hesitation - Chat):**
        Mat: "Hello, this is Mat from MultipleAI Solutions. How are you doing today?"
        Customer: "I'm alright.  Not really interested in anything right now, though."
        // ... (rest of conversation)
        Customer: "Okay, I suppose that would be alright."
        Mat: "Excellent! I'll send you a calendar invite with a link to schedule a time that works best for you." *(The code then sends the link directly in the chat window.)*

9. **Conversation Context:** Here's some context from the conversation (if available): ${conversationContext}

10. **Relevant Document Information:** Here's some information that might be relevant: ${relevantDocs}

11. **User's Input:** ${userInput}
Conversation so far Conversation Context: ${JSON.stringify(conversation_history)}

If the user expresses clear interest in a meeting or asks about scheduling an appointment, include [Appointment Suggested] at the end of your response.
  `;

  try {
    console.time('AI Response Time');
    const aiStartTime = performance.now();
    
    const openaiResponse = await openai.chat.completions.create({
      model: 'gpt-4', // Or your preferred model
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: userInput },
      ],
      max_tokens: 150, // Increased for more complete responses
      temperature: 0.7,
    });
    
    const aiTime = performance.now() - aiStartTime;
    trackPerformance('aiResponse', aiTime);
    console.timeEnd('AI Response Time');

    let responseText = openaiResponse.choices[0].message.content.trim();
    const suggestedAppointment = responseText.includes('[Appointment Suggested]');
    responseText = responseText.replace('[Appointment Suggested]', '');
    conversation_history.push({ user: userInput, assistant: responseText });
    // Log response for debugging
    console.log("🔹 AI Response:", responseText);

    // Save to appropriate conversation history
    if (callSid) {
      conversationHistory[callSid].push({
        user: userInput,
        assistant: responseText,
      });

      // Limit conversation history size
      if (conversationHistory[callSid].length > 10) {
        conversationHistory[callSid] = conversationHistory[callSid].slice(-10);
      }
    } else if (webSessionId) {
      webChatSessions[webSessionId].push({
        user: userInput,
        assistant: responseText,
      });

      // Limit web session history size
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

// Session cleanup - remove inactive web sessions after 30 minutes
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
}, 10 * 60 * 1000); // Check every 10 minutes

// Initialize the server
async function initializeServer() {
  try {
    // Load documents and build the initial index
    const documentData = await loadAndIndexDocuments();
    
    // Set up a daily job to refresh the index
    setInterval(async () => {
      if (shouldUpdateIndex()) {
        console.log('Scheduled index update - refreshing document index');
        await loadAndIndexDocuments();
      }
    }, 3600000); // Check every hour
    
    const PORT = process.env.PORT || 8000;
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Error initializing server:', error);
    process.exit(1);
  }
}

// Start the server
initializeServer();

module.exports = app;
