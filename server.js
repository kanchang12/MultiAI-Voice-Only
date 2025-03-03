const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { OpenAI } = require('openai');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { performance } = require('perf_hooks');
const Table = require('cli-table3');

const app = express();

// Performance tracking (no placeholders)
const performanceMetrics = {
    documentLoading: [],
    indexBuilding: [],
    documentSearch: [],
    aiResponse: [],
    totalRequestTime: [],
    elevenLabsGeneration: []
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

//setInterval(printPerformanceTable, 60000);

// ElevenLabs configuration (REPLACE with your actual values)
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID; // Your Agent ID

// Configure Twilio (REPLACE with your actual values)
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
const twilioClient = twilio(accountSid, authToken);

// Initialize conversation_history CORRECTLY:
const conversation_history = {};

// Configure OpenAI (REPLACE with your actual value)
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Inverted index data structure (no placeholders)
let documentIndex = {
    wordToDocuments: {},
    documentContent: {},
    documentNames: {},
    lastUpdated: null
};

// Function to interact with ElevenLabs Agents API (no placeholders)
async function callElevenLabsAgent(userInput, callSid) {
    const startTime = performance.now();

    try {
        let conversationContext = '';
        if (callSid && conversation_history[callSid]) {
            conversationContext = conversation_history[callSid]
                .map((msg) => `User: ${msg.user}\nAssistant: ${msg.assistant}`)
                .join('\n');
        }

        const response = await axios.get('https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${process.env.ELEVENLABS_AGENT_ID}',
            {
                text: userInput,
                history: conversationContext,
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    style: 0.0,
                    use_speaker_boost: true
                },
                output_format: "mp3_44100_128",
                model_id: "eleven_turbo_v2"
            },
            {
                headers: {
                    'xi-api-key': ELEVENLABS_API_KEY,
                    'Content-Type': 'application/json'
                },
                responseType: 'arraybuffer'
            }
        );

        const tempDir = path.join(__dirname, 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const audioFileName = `response_${callSid || 'web'}_${Date.now()}.mp3`;
        const audioFilePath = path.join(tempDir, audioFileName);
        fs.writeFileSync(audioFilePath, response.data);

        const textResponse = response.headers['x-elevenlabs-agent-response'] ||
            "I'm sorry, I couldn't process your request at this time.";

        const executionTime = performance.now() - startTime;
        trackPerformance('elevenLabsGeneration', executionTime);

        return {
            text: textResponse,
            audioPath: audioFilePath,
            audioFileName: audioFileName,
            suggestedAppointment: textResponse.toLowerCase().includes('schedule') ||
                textResponse.toLowerCase().includes('appointment') ||
                textResponse.toLowerCase().includes('meeting')
        };
    } catch (error) {
        console.error('Error with ElevenLabs agent:', error);
        const executionTime = performance.now() - startTime;
        trackPerformance('elevenLabsGeneration', executionTime);
        throw error;
    }
}

// Load and index document data (no placeholders - you'll need to fill in the actual file loading/parsing)
async function loadAndIndexDocuments() {
    const startTime = performance.now();
    console.log('Loading document data...');

    const documentJsonPath = path.join(__dirname, 'document_contents.json'); // Path to your JSON file
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


// Build inverted index from documents (no placeholders)
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

// Check if the index needs to be updated
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

// Store conversation histories

const webChatSessions = {};
const CALENDLY_LINK = process.env.CALENDLY_LINK || "https://calendly.com/ali-shehroz-19991/30min"; // Replace with your Calendly link or put in env variable

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Route to serve audio files (no placeholders)
app.get('/audio/:filename', (req, res) => {
    const filePath = path.join(__dirname, 'temp', req.params.filename);

    if (fs.existsSync(filePath)) {
        res.setHeader('Content-Type', 'audio/mpeg');
        fs.createReadStream(filePath).pipe(res);
    } else {
        res.status(404).send('Audio file not found');
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Web chat endpoint (no placeholders)
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
        const agentResponse = await callElevenLabsAgent(userMessage, sessionId);

        let responseHtml = agentResponse.text;
        if (agentResponse.suggestedAppointment) {
            responseHtml += `<br><br>You can <a href="${CALENDLY_LINK}" target="_blank">schedule a meeting here</a>.`;
        }

        webChatSessions[sessionId].push({
            user: userMessage,
            assistant: agentResponse.text,
            timestamp: Date.now()
        });

        if (webChatSessions[sessionId].length > 10) {
            webChatSessions[sessionId] = webChatSessions[sessionId].slice(-10);
        }

        res.json({
            response: responseHtml,
            audioUrl: `/audio/${agentResponse.audioFileName}`,
            suggestedAppointment: agentResponse.suggestedAppointment,
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

// Initiate a call (no placeholders)
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

        conversation_history[call.sid] = [];

        res.json({ success: true, call_sid: call.sid });

        const totalTime = performance.now() - requestStartTime;
        trackPerformance('totalRequestTime', totalTime);

    } catch (error) {
        console.error('Error making call:', error);
        res.status(500).json({ error: 'Failed to initiate call. Please try again.' });
    }
});

app.post('/twiml', async (req, res) => {
    const callSid = req.body.CallSid;
    const machineResult = req.body.AnsweredBy;
    const response = new twilio.twiml.VoiceResponse();

    try {
        if (machineResult === 'machine_start') {
            const voicemailMessage = 'Hello, this is Mat from MultipleAI Solutions. I was calling to discuss how AI might benefit your business. Please call us back at your convenience or visit our website to schedule a meeting. Thank you and have a great day.';
            const voicemailResponse = await callElevenLabsAgent(voicemailMessage, callSid);

            const audioUrl = `${req.protocol}://${req.get('host')}/audio/${voicemailResponse.audioFileName}`;
            response.play(audioUrl);
            response.hangup();

            return res.type('text/xml').send(response.toString()); // Return to stop further execution
        }

        // Corrected greeting logic
        const greeting = "Hello, this is Mat from MultipleAI Solutions. How are you today?";
        const greetingResponse = await callElevenLabsAgent(greeting, callSid); // Ensure we await the call

        const gather = response.gather({
            input: 'speech dtmf',
            action: '/conversation',
            method: 'POST',
            timeout: 3,
            speechTimeout: 'auto',
            bargeIn: true,
        });

        // Corrected URL formatting
        const audioUrl = `${req.protocol}://${req.get('host')}/audio/${greetingResponse.audioFileName}`;
        gather.play(audioUrl);

        // Save to conversation history
        conversation_history[callSid] = [{
            user: "",
            assistant: greeting,
            timestamp: Date.now()
        }];

        response.redirect('/conversation');

        return res.type('text/xml').send(response.toString()); // Ensure return after sending response

    } catch (error) {
        console.error('Error in /twiml:', error);

        // Fallback if ElevenLabs fails
        const gather = response.gather({
            input: 'speech dtmf',
            action: '/conversation',
            method: 'POST',
            timeout: 3,
            speechTimeout: 'auto',
            bargeIn: true,
        });

        gather.say('Hello, this is Mat from MultipleAI Solutions. How are you today?');
        response.redirect('/conversation');

        return res.type('text/xml').send(response.toString()); // Ensure return after sending response
    }
});


// Conversation handler
// Conversation handler (Complete and Correct)
app.post('/conversation', async (req, res) => {
    const requestStartTime = performance.now();
    const userSpeech = req.body.SpeechResult || '';
    const callSid = req.body.CallSid; // Get callSid from Twilio
    const digits = req.body.Digits || '';

    const response = new twilio.twiml.VoiceResponse();

    if (callSid && !conversation_history[callSid]) {
        conversation_history[callSid] = []; // Use conversation_history
    }

    if (digits === '9' || /goodbye|bye|hang up|end call/i.test(userSpeech)) {
        try {
            const goodbyeMessage = "Thank you for your time. Goodbye!";
            const goodbyeResponse = await callElevenLabsAgent(goodbyeMessage, callSid);
            const audioUrl = `${req.protocol}://${req.get('host')}/audio/${goodbyeResponse.audioFileName}`; // Correct URL
            response.play(audioUrl);
            response.hangup();

            return res.type('text/xml').send(response.toString());
        } catch (error) {
            console.error('Error generating goodbye message:', error);
            response.say("Thank you for your time. Goodbye!");
            response.hangup();
            return res.type('text/xml').send(response.toString());
        }
    }

    try {
        const inputText = userSpeech || (digits ? `Button ${digits} pressed` : "Hello");

        const agentResponse = await callElevenLabsAgent(inputText, callSid); // Use callSid

        conversation_history[callSid].push({ // Use callSid as the key
            user: inputText,
            assistant: agentResponse.text,
            timestamp: Date.now()
        });

        if (conversation_history[callSid].length > 10) {
            conversation_history[callSid] = conversation_history[callSid].slice(-10);
        }

        const gather = response.gather({
            input: 'speech dtmf',
            action: '/conversation',
            method: 'POST',
            timeout: 5,
            speechTimeout: 'auto',
            bargeIn: true,
        });

        const audioUrl = `${req.protocol}://${req.get('host')}/audio/${agentResponse.audioFileName}`; // Correct URL
        gather.play(audioUrl);

        // SMS handling for appointments (remains the same)
        if (agentResponse.suggestedAppointment && callSid) {
            try {
                const call = await twilioClient.calls(callSid).fetch();
                const phoneNumber = call.to;

                await twilioClient.messages.create({
                    body: `Here is the link to schedule a meeting with MultipleAI Solutions: ${CALENDLY_LINK}`,
                    from: twilioPhoneNumber,
                    to: phoneNumber,
                });

                console.log(`SMS sent to ${phoneNumber}`);

                const smsNotification = "I've sent you an SMS with the booking link.";
                const smsResponse = await callElevenLabsAgent(smsNotification, callSid);

                const smsAudioUrl = `${req.protocol}://${req.get('host')}/audio/${smsResponse.audioFileName}`; // Correct URL
                gather.play(smsAudioUrl);
            } catch (error) {
                console.error('Error sending SMS:', error);
            }
        }


        response.pause({ length: 1 });

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

        console.log(`Call SID: ${callSid}`);
        console.log(`User: ${inputText}`);
        console.log(`Mat: ${agentResponse.text}`);

        const totalTime = performance.now() - requestStartTime;
        trackPerformance('totalRequestTime', totalTime);

    } catch (error) {
        console.error("Error in /conversation:", error);

        response.say("I'm experiencing technical difficulties. Please try again later.");
        response.redirect('/conversation');

        res.type('text/xml');
        res.send(response.toString());
    }
});
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
  
  // Clean up temporary audio files older than 1 hour
  const tempDir = path.join(__dirname, 'temp');
  if (fs.existsSync(tempDir)) {
    fs.readdir(tempDir, (err, files) => {
      if (err) {
        console.error('Error reading temp directory:', err);
        return;
      }
      
      files.forEach(file => {
        const filePath = path.join(tempDir, file);
        fs.stat(filePath, (err, stats) => {
          if (err) return;
          
          const now = Date.now();
          if (now - stats.mtimeMs > 60 * 60 * 1000) {
            fs.unlink(filePath, err => {
              if (err) console.error(`Error deleting temp file ${filePath}:`, err);
            });
          }
        });
      });
    });
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
      console.log(`Using ElevenLabs Agent ID: ${ELEVENLABS_AGENT_ID}`);
    });
  } catch (error) {
    console.error('Error initializing server:', error);
    process.exit(1);
  }
}

app.post('/twiml', async (req, res) => { // Make the route handler async
    const callSid = req.body.CallSid;
    const machineResult = req.body.AnsweredBy;
    const response = new twilio.twiml.VoiceResponse();

    try {
        if (machineResult === 'machine_start') {
            const voicemailMessage = 'Hello, this is Mat from MultipleAI Solutions. I was calling to discuss how AI might benefit your business. Please call us back at your convenience or visit our website to schedule a meeting. Thank you and have a great day.';
            const voicemailResponse = await callElevenLabsAgent(voicemailMessage, callSid); // await is OK here
            const audioUrl = `${req.protocol}://${req.get('host')}/audio/${voicemailResponse.audioFileName}`;
            response.play(audioUrl);
            response.hangup();
            res.type('text/xml');
            res.send(response.toString());
            return; // Important: Stop further execution
        }

        const greeting = "Hello, this is Mat from MultipleAI Solutions. How are you today?";
        const greetingResponse = await callElevenLabsAgent(greeting, callSid); // await is OK here

        conversation_history[callSid] = [{
            user: "",
            assistant: greeting,
            timestamp: Date.now()
        }];

        const gather = response.gather({
            input: 'speech dtmf',
            action: '/conversation',
            method: 'POST',
            timeout: 3,
            speechTimeout: 'auto',
            bargeIn: true,
        });

        const audioUrl = `${req.protocol}://${req.get('host')}/audio/${greetingResponse.audioFileName}`;
        gather.play(audioUrl);

        res.type('text/xml'); // Send the TML response
        res.send(response.toString()); // Send the TML response

    } catch (error) {
        console.error('Error in /twiml:', error);
        const response = new twilio.twiml.VoiceResponse();
        response.say("I'm sorry, there's been an error. Please try again later."); // Or a more informative message
        res.type('text/xml');
        res.send(response.toString());
    }
});

// Start the server
initializeServer();

module.exports = app;
