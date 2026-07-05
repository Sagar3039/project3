const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const isDev = process.env.NODE_ENV === 'development';

const SESSIONS_FILE = path.join(app.getPath('userData'), 'sessions.json');
const MEMORY_FILE = path.join(app.getPath('userData'), 'memory.json');

const VOICE_LIST_URL = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4';

const WSS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
};

let EdgeTTS = null;

async function getEdgeTTS() {
  if (!EdgeTTS) {
    const mod = await import('node-edge-tts');
    EdgeTTS = mod.EdgeTTS;
  }
  return EdgeTTS;
}

function readSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    }
  } catch {}
  return [];
}

function writeSessions(sessions) {
  fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf-8');
}

// ─── Memory System ──────────────────────────────────────────────────
const DEFAULT_MEMORY = { facts: [], explicit_memories: [], stories: [], goals: [], preferences: [], key_topics: [], extracted_sessions: [] };

function readMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
    }
  } catch {}
  return { ...DEFAULT_MEMORY };
}

function writeMemory(memory) {
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2), 'utf-8');
}

const STOPWORDS = new Set(['i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing', 'a', 'an', 'the', 'and', 'but', 'if', 'or', 'because', 'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 's', 't', 'can', 'will', 'just', 'don', 'should', 'now', 'hey', 'bob', 'hii', 'hiii', 'hiiii', 'yoo', 'yo', 'hello', 'hi', 'yes', 'no', 'yeah', 'ok', 'okay', 'lol', 'lmao', 'haha', 'hmm', 'um', 'uh', 'ah', 'oh']);

function extractKeywords(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

function extractMemoryFromSession(session) {
  const userMessages = session.messages.filter(m => m.role === 'user').map(m => m.content);
  const allText = userMessages.join(' ').toLowerCase();

  // Extract facts (numbers, scores, percentages)
  const facts = [];
  for (const msg of userMessages) {
    const percentMatch = msg.match(/(\d+)\s*%/g);
    if (percentMatch) {
      for (const p of percentMatch) {
        facts.push(`${msg.substring(0, 80).trim()} (mentioned ${p})`);
      }
    }
    const scoreMatch = msg.match(/(\d+)\s*(marks|score|scored|got)/i);
    if (scoreMatch) {
      facts.push(msg.substring(0, 100).trim());
    }
  }

  // Extract explicit memories ("remember", "don't forget", etc.)
  const explicit = [];
  for (const msg of userMessages) {
    if (/remember|don't forget|keep in mind|note that|important/i.test(msg)) {
      explicit.push(msg.substring(0, 150).trim());
    }
  }

  // Extract goals/decisions
  const goals = [];
  for (const msg of userMessages) {
    if (/want to|plan to|going to|goal is|decided to|i need to|i should|dream/i.test(msg)) {
      goals.push(msg.substring(0, 150).trim());
    }
  }

  // Extract preferences
  const prefs = [];
  for (const msg of userMessages) {
    if (/prefer|like|love|hate|favorite|best|worst/i.test(msg)) {
      prefs.push(msg.substring(0, 150).trim());
    }
  }

  // Detect stories (multi-turn exchanges with narrative content)
  const stories = [];
  const narrativeMarkers = /then|later|after that|finally|next|suddenly|meanwhile|3 days|next day|hours later|minutes later/i;
  let storyBuffer = [];
  let inStory = false;

  for (const msg of session.messages) {
    if (msg.role === 'user' && narrativeMarkers.test(msg.content)) {
      inStory = true;
    }
    if (inStory) {
      storyBuffer.push(msg);
    }
    if (inStory && storyBuffer.length >= 4) {
      const summary = storyBuffer.map(m => `${m.role}: ${m.content.substring(0, 80)}`).join(' | ');
      stories.push({
        title: session.title || 'Untitled Story',
        summary: summary.substring(0, 300),
        keywords: [...new Set(storyBuffer.flatMap(m => extractKeywords(m.content)))]
      });
      storyBuffer = [];
      inStory = false;
    }
  }

  // If we have a partial story buffer, still save it
  if (storyBuffer.length >= 2) {
    const summary = storyBuffer.map(m => `${m.role}: ${m.content.substring(0, 80)}`).join(' | ');
    stories.push({
      title: session.title || 'Untitled Story',
      summary: summary.substring(0, 300),
      keywords: [...new Set(storyBuffer.flatMap(m => extractKeywords(m.content)))]
    });
  }

  // Key topics for the session
  const allKeywords = extractKeywords(allText);
  const freq = {};
  for (const kw of allKeywords) { freq[kw] = (freq[kw] || 0) + 1; }
  const topTopics = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word);

  const keyTopics = {
    sessionId: session.id,
    title: session.title || 'Untitled',
    date: new Date(session.updatedAt || session.createdAt).toISOString().split('T')[0],
    mainTopics: topTopics
  };

  return { facts, explicit, goals, prefs, stories, keyTopics };
}

function extractAndStoreMemory(session) {
  const memory = readMemory();

  // Skip if already extracted this session version
  const sessionVersion = `${session.id}_${session.updatedAt || session.createdAt}`;
  if (memory.extracted_sessions && memory.extracted_sessions.includes(sessionVersion)) {
    return memory;
  }

  const extracted = extractMemoryFromSession(session);

  // Merge facts (deduplicate)
  for (const f of extracted.facts) {
    if (!memory.facts.some(existing => existing.toLowerCase() === f.toLowerCase())) {
      memory.facts.push(f);
    }
  }

  // Merge explicit memories
  for (const e of extracted.explicit) {
    if (!memory.explicit_memories.some(existing => existing.toLowerCase() === e.toLowerCase())) {
      memory.explicit_memories.push(e);
    }
  }

  // Merge goals
  for (const g of extracted.goals) {
    if (!memory.goals.some(existing => existing.toLowerCase() === g.toLowerCase())) {
      memory.goals.push(g);
    }
  }

  // Merge preferences
  for (const p of extracted.prefs) {
    if (!memory.preferences.some(existing => existing.toLowerCase() === p.toLowerCase())) {
      memory.preferences.push(p);
    }
  }

  // Merge stories (by title to avoid duplicates)
  for (const s of extracted.stories) {
    if (!memory.stories.some(existing => existing.title === s.title)) {
      memory.stories.push(s);
    }
  }

  // Update key_topics
  const existingTopics = memory.key_topics.findIndex(t => t.sessionId === extracted.keyTopics.sessionId);
  if (existingTopics >= 0) {
    memory.key_topics[existingTopics] = extracted.keyTopics;
  } else {
    memory.key_topics.push(extracted.keyTopics);
  }

  // Track extracted sessions
  if (!memory.extracted_sessions) memory.extracted_sessions = [];
  memory.extracted_sessions.push(sessionVersion);

  // Cap memory size
  if (memory.facts.length > 100) memory.facts = memory.facts.slice(-80);
  if (memory.explicit_memories.length > 50) memory.explicit_memories = memory.explicit_memories.slice(-40);
  if (memory.goals.length > 50) memory.goals = memory.goals.slice(-40);
  if (memory.preferences.length > 50) memory.preferences = memory.preferences.slice(-40);
  if (memory.stories.length > 30) memory.stories = memory.stories.slice(-20);
  if (memory.key_topics.length > 50) memory.key_topics = memory.key_topics.slice(-40);

  writeMemory(memory);
  return memory;
}

function getMemoryContext(currentMessage, currentSessionId) {
  const memory = readMemory();
  const keywords = extractKeywords(currentMessage);
  const contextParts = [];

  // Always include facts
  if (memory.facts.length > 0) {
    contextParts.push('Facts about Sagar:\n' + memory.facts.slice(-15).map(f => `- ${f}`).join('\n'));
  }

  // Always include goals
  if (memory.goals.length > 0) {
    contextParts.push('Goals & Plans:\n' + memory.goals.slice(-10).map(g => `- ${g}`).join('\n'));
  }

  // Include explicit memories
  if (memory.explicit_memories.length > 0) {
    contextParts.push('Important notes:\n' + memory.explicit_memories.slice(-10).map(e => `- ${e}`).join('\n'));
  }

  // Keyword-matched stories
  const matchedStories = memory.stories.filter(s =>
    s.keywords.some(kw => keywords.includes(kw))
  );
  if (matchedStories.length > 0) {
    contextParts.push('Relevant stories from past conversations:\n' +
      matchedStories.slice(0, 3).map(s => `[${s.title}] ${s.summary}`).join('\n'));
  }

  // Keyword-matched conversation topics
  const matchedTopics = memory.key_topics.filter(t =>
    t.sessionId !== currentSessionId &&
    t.mainTopics.some(kw => keywords.includes(kw))
  );
  if (matchedTopics.length > 0) {
    contextParts.push('Related past conversations:\n' +
      matchedTopics.slice(0, 3).map(t => `- "${t.title}" (${t.date}): discussed ${t.mainTopics.join(', ')}`).join('\n'));
  }

  // If user asks about past conversations directly
  if (/last time|previous|before|earlier|before that|our last|past|remember/i.test(currentMessage)) {
    // Include ALL conversation summaries
    const allTopics = memory.key_topics
      .filter(t => t.sessionId !== currentSessionId)
      .slice(-10);
    if (allTopics.length > 0) {
      contextParts.push('All past conversations:\n' +
        allTopics.map(t => `- "${t.title}" (${t.date}): ${t.mainTopics.join(', ')}`).join('\n'));
    }
  }

  const fullContext = contextParts.join('\n\n');
  // Cap at ~2000 chars to avoid hitting context limits
  return fullContext.length > 2000 ? fullContext.substring(0, 2000) + '...' : fullContext;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 480,
    minHeight: 560,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  Menu.setApplicationMenu(null);

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
    } else {
      callback(false);
    }
  });
}

// Session IPC handlers
ipcMain.handle('sessions:load', () => readSessions());
ipcMain.handle('sessions:save', (_, sessions) => {
  writeSessions(sessions);
  return true;
});

// Memory IPC handlers
ipcMain.handle('memory:load', () => readMemory());
ipcMain.handle('memory:save', (_, memory) => {
  writeMemory(memory);
  return true;
});
ipcMain.handle('memory:extract', (_, session) => {
  return extractAndStoreMemory(session);
});
ipcMain.handle('memory:getContext', (_, currentMessage, currentSessionId) => {
  return getMemoryContext(currentMessage, currentSessionId);
});

// Edge TTS IPC handlers
let cachedVoices = null;

ipcMain.handle('tts:getEdgeVoices', async () => {
  try {
    if (cachedVoices && cachedVoices.length > 0) return cachedVoices;

    console.log('Fetching Edge TTS voices...');
    const response = await fetch(VOICE_LIST_URL, { headers: WSS_HEADERS });

    if (!response.ok) {
      console.error('Failed to fetch voices:', response.status);
      return [];
    }

    const voices = await response.json();
    console.log('Edge TTS voices fetched:', voices?.length);
    cachedVoices = Array.isArray(voices) ? voices : [];
    return cachedVoices;
  } catch (e) {
    console.error('Failed to get Edge voices:', e.message);
    return [];
  }
});

ipcMain.handle('tts:speak', async (_, text, options = {}) => {
  const tmpFile = path.join(app.getPath('temp'), `tts_${Date.now()}.mp3`);

  try {
    console.log('Edge TTS speaking:', text.substring(0, 50), options);

    const EdgeTTSService = await getEdgeTTS();

    const tts = new EdgeTTSService({
      voice: options.voice || 'en-GB-ThomasNeural',
      lang: options.voice?.split('-').slice(0, 2).join('-') || 'en-GB',
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      rate: options.rate || 'default',
      pitch: options.pitch || 'default',
      volume: options.volume || 'default',
      timeout: 30000
    });

    await tts.ttsPromise(text, tmpFile);

    const audioBuffer = fs.readFileSync(tmpFile);
    console.log('Edge TTS audio size:', audioBuffer.length);

    // Clean up temp file
    try { fs.unlinkSync(tmpFile); } catch {}

    return audioBuffer.toString('base64');
  } catch (e) {
    console.error('Edge TTS error:', e.message);
    // Clean up temp file on error
    try { fs.unlinkSync(tmpFile); } catch {}
    throw e;
  }
});

ipcMain.handle('tts:stop', async () => {
  return true;
});

// ─── Whisper STT (runs in main process) ─────────────────────────────
let whisperPipeline = null;

function parseWavToFloat32(buffer) {
  // Parse WAV header
  const header = buffer.slice(0, 44);
  const numChannels = header.readUInt16LE(22);
  const sampleRate = header.readUInt32LE(24);
  const bitsPerSample = header.readUInt16LE(34);
  const bytesPerSample = bitsPerSample / 8;
  const dataOffset = 44; // Standard WAV header is 44 bytes

  const pcmData = buffer.slice(dataOffset);
  const numSamples = Math.floor(pcmData.length / (numChannels * bytesPerSample));
  const float32 = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const offset = i * numChannels * bytesPerSample;
    // Mix down to mono if stereo
    let sum = 0;
    for (let c = 0; c < numChannels; c++) {
      const sampleOffset = offset + c * bytesPerSample;
      const sample = pcmData.readInt16LE(sampleOffset);
      sum += sample / 32768.0;
    }
    float32[i] = sum / numChannels;
  }

  return { audio: float32, sampleRate };
}

ipcMain.handle('stt:transcribe', async (_, audioBase64) => {
  try {
    if (!whisperPipeline) {
      console.log('[STT] Loading Whisper model...');
      const { pipeline } = await import('@xenova/transformers');
      whisperPipeline = await pipeline('automatic-speech-recognition', 'Xenova/whisper-base', {
        language: 'en',
        task: 'transcribe'
      });
      console.log('[STT] Whisper model loaded.');
    }

    // Decode base64 WAV audio
    const wavBuffer = Buffer.from(audioBase64, 'base64');
    const { audio } = parseWavToFloat32(wavBuffer);

    console.log('[STT] Audio length:', audio.length, 'samples');

    // Pass raw Float32Array directly to the pipeline
    const result = await whisperPipeline(audio, {
      language: 'en',
      task: 'transcribe'
    });

    return { text: result?.text?.trim() || '' };
  } catch (e) {
    console.error('[STT] Transcription error:', e.message);
    throw e;
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
