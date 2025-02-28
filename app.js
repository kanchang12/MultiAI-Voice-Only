const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { OpenAI } = require('openai');
const { MessagingResponse, VoiceResponse, Gather } = require('twilio').twiml;
const { Client } = require('twilio');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Twilio setup
const twilioClient = new Client(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const CALENDLY_LINK = "https://calendly.com/ali-shehroz-19991/30min";

// OpenAI setup
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// File upload setup
const upload = multer({ dest: 'uploads/' });
let documentCache = {}; // Store extracted document content
let conversationHistory = {}; // Store conversation history

// Function to extract text from uploaded files (placeholder, implement based on file type)
const extractTextFromFile = (filePath, fileType) => {
    return fs.readFileSync(filePath, 'utf8'); // Dummy extraction for now
};

// Function to load documents into memory
const loadDocuments = () => {
    if (Object.keys(documentCache).length === 0) {
        const files = fs.readdirSync('uploads');
        files.forEach(file => {
            const filePath = path.join('uploads', file);
            documentCache[file] = extractTextFromFile(filePath, path.extname(file));
        });
    }
    return documentCache;
};

// AI Response Function
const getAIResponse = async (userInput, callSid = null) => {
    const documents = loadDocuments();
    let combinedContext = Object.values(documents).join('\n');
    let conversationContext = callSid && conversationHistory[callSid] ? conversationHistory[callSid].slice(-3).join('\n') : '';

    const prompt = `You are Sarah, a friendly and engaging AI assistant from MultipleAI Solutions. Your role is to call potential clients and have a **natural, human-like conversation** before smoothly transitioning into business. Your ultimate goal is to **schedule an appointment**, but only if it makes sense in the conversation.\n\nWhen Responding:\n- **Start with a friendly, short small talk**: \"Hi there! I hope you're having a great day. How’s your day going?\"\n- **Engage the user in casual conversation before transitioning into business.**\n- **DO NOT repeat greetings. Keep responses natural.**\n- **Only suggest an appointment when the user expresses interest in AI.**\n- **Use a warm, engaging, and human-like voice.**\n\nConversation History:\n${conversationContext}\n\nRelevant Document Information:\n${combinedContext}\n\nUser's question: ${userInput}\n\nRespond naturally and only suggest an appointment when appropriate.`;

    try {
        const openaiResponse = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                { role: "system", content: prompt },
                { role: "user", content: userInput }
            ],
            max_tokens: 75,
            temperature: 0.7
        });

        let responseText = openaiResponse.choices[0].message.content.trim();
        let suggestedAppointment = responseText.includes("[Appointment Suggested]");
        if (suggestedAppointment) responseText = responseText.replace("[Appointment Suggested]", "");

        if (callSid) {
            conversationHistory[callSid] = conversationHistory[callSid] || [];
            conversationHistory[callSid].push({ user: userInput, assistant: responseText });
        }

        return { response: responseText, suggestedAppointment };
    } catch (error) {
        console.error("OpenAI Error:", error);
        return { response: "I'm sorry, I’m having trouble processing your request. Could you try again?", suggestedAppointment: false };
    }
};

// Twilio Call Handling
app.post('/twiml', (req, res) => {
    const response = new VoiceResponse();
    const gather = response.gather({ input: 'speech dtmf', action: '/conversation', method: 'POST', timeout: 3, speechTimeout: 'auto', bargeIn: true });
    gather.say({ voice: 'Polly.Joanna' }, "Hi there! This is Sarah from MultipleAI Solutions. How are you today?");
    res.type('text/xml').send(response.toString());
});

app.post('/conversation', async (req, res) => {
    const userSpeech = req.body.SpeechResult || "";
    const callSid = req.body.CallSid;
    
    const aiResponseData = await getAIResponse(userSpeech, callSid);
    const response = new VoiceResponse();
    const gather = response.gather({ input: 'speech dtmf', action: '/conversation', method: 'POST', timeout: 5, speechTimeout: 'auto', bargeIn: true });
    gather.say({ voice: 'Polly.Matthew' }, aiResponseData.response);
    response.append(gather);
    res.type('text/xml').send(response.toString());
});

app.listen(3000, () => console.log('Server running on port 3000!'));
