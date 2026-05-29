// ==========================================================================
// LinguaFlow App Logic (Pure Client-Side PWA Controller)
// ==========================================================================

// --- 0. Platform Detection ---
// Google Translate TTS (translate.google.com) is blocked by CORS on iOS/mobile.
// We detect mobile here and auto-switch to high-quality system voices instead.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isMobile = isIOS || /Mobi|Android/i.test(navigator.userAgent);

// --- 1. Global State ---
let sentences = [];    // Raw sentences parsed from CSV
let progress = {};     // Status & play counts: { id: { status: 'unstarted'|'practicing'|'mastered', playCount: 0, lastSeen: 'YYYY-MM-DD' } }
let settings = {
  lang: 'en-US',
  voiceURI: '',
  speed: 1.0,
  singleRepeat: 5,
  gap: 1.0,
  engine: 'google',       // 預設為高品質免 Key 的 Google 語音
  openaiApiKey: '',       // OpenAI API 密鑰
  openaiVoice: 'alloy'    // OpenAI 推薦真人音色
};

// UI Filter States
let searchQuery = "";
let statusFilter = "all";
let contextFilter = "all";

// Pagination
let currentPage = 1;
const itemsPerPage = 50;

// Active Focus & Play States
let focusedCardId = null;
let activePlayingId = null;
let activeRepeatMenuCardId = null; // Custom dropdown trigger

// Brush Teeth Mode (Loop) State
let isBrushTeethActive = false;
let btSentenceIndex = 0;
let btTimeoutId = null;

// --- 2. LocalStorage Helper ---
const STORAGE_SENTENCES = "lf-sentences";
const STORAGE_PROGRESS = "lf-progress";
const STORAGE_SETTINGS = "lf-settings";

function loadData() {
  try {
    const savedSentences = localStorage.getItem(STORAGE_SENTENCES);
    if (savedSentences) {
      sentences = JSON.parse(savedSentences);
    }
    
    const savedProgress = localStorage.getItem(STORAGE_PROGRESS);
    if (savedProgress) {
      progress = JSON.parse(savedProgress);
    }
    
    const savedSettings = localStorage.getItem(STORAGE_SETTINGS);
    if (savedSettings) {
      settings = { ...settings, ...JSON.parse(savedSettings) };
    }
    } catch (e) {
    console.error("讀取 LocalStorage 發生錯誤，將使用預設值", e);
  }
}

function saveData() {
  try {
    localStorage.setItem(STORAGE_SENTENCES, JSON.stringify(sentences));
    localStorage.setItem(STORAGE_PROGRESS, JSON.stringify(progress));
    localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(settings));
  } catch (e) {
    console.error("儲存 LocalStorage 發生錯誤", e);
  }
}

// --- 3. Robust CSV & Excel Parser ---
// Handles fields enclosed in quotes, nested double quotes, newlines, and auto-generated IDs
function parseCSV(text) {
  const lines = [];
  let row = [""];
  let inQuotes = false;
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    
    if (char === '"') {
      if (inQuotes && next === '"') {
        row[row.length - 1] += '"';
        i++; // Skip next double quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push("");
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        i++; // Skip Windows CRLF \n
      }
      lines.push(row);
      row = [""];
    } else {
      row[row.length - 1] += char;
    }
  }
  if (row.length > 1 || row[0] !== "") {
    lines.push(row);
  }
  
  return parse2DArray(lines);
}

// Global Parser for 2D Array data (shared between CSV and Excel)
function parse2DArray(lines) {
  if (lines.length === 0) return [];
  
  // Header identification with aliases matching support
  const headers = lines[0].map(h => h !== null && h !== undefined ? String(h).trim().toLowerCase() : "");
  
  function findHeaderIndex(headersList, aliases) {
    for (const alias of aliases) {
      const idx = headersList.indexOf(alias.toLowerCase());
      if (idx !== -1) return idx;
    }
    return -1;
  }
  
  const targetIdx = findHeaderIndex(headers, ['target', '英文翻譯', '英文句子', '英文', 'english', 'sentence']);
  const transIdx = findHeaderIndex(headers, ['translation', '中文句子', '中文翻譯', '中文', '翻譯', 'chinese']);
  const idIdx = findHeaderIndex(headers, ['id', '序號', '編號', 'no', 'num']);
  const contextIdx = findHeaderIndex(headers, ['context', '情境應用', '情境', '分類', '標籤', 'tags', 'tag']);
  const notesIdx = findHeaderIndex(headers, ['notes', '實用片語/單字解析', '備註', '片語', '解析', '單字', 'note']);
  const diffIdx = findHeaderIndex(headers, ['difficulty', '難度', 'level']);
  
  if (targetIdx === -1 || transIdx === -1) {
    throw new Error(
      "表格格式錯誤：無法辨識關鍵欄位名稱！\n" +
      "必須包含「英文翻譯」或 'target'，以及「中文句子」或 'translation' 欄位標題。\n" +
      "目前偵測到的欄位標題為: [" + lines[0].filter(h => h).join(', ') + "]"
    );
  }
  
  const parsedResults = [];
  let autoIdCounter = 1;
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length <= Math.max(targetIdx, transIdx)) continue;
    
    const target = line[targetIdx] !== null && line[targetIdx] !== undefined ? String(line[targetIdx]).trim() : "";
    const translation = line[transIdx] !== null && line[transIdx] !== undefined ? String(line[transIdx]).trim() : "";
    
    if (!target && !translation) continue; // Skip empty rows
    
    let id = idIdx !== -1 && line[idIdx] !== null && line[idIdx] !== undefined ? String(line[idIdx]).trim() : "";
    if (!id) {
      id = String(autoIdCounter++).padStart(3, '0');
    }
    
    const context = contextIdx !== -1 && line[contextIdx] !== null && line[contextIdx] !== undefined ? String(line[contextIdx]).trim() : "";
    const difficulty = diffIdx !== -1 && line[diffIdx] !== null && line[diffIdx] !== undefined ? String(line[diffIdx]).trim() : "";
    const notes = notesIdx !== -1 && line[notesIdx] !== null && line[notesIdx] !== undefined ? String(line[notesIdx]).trim() : "";
    
    parsedResults.push({ id, target, translation, context, difficulty, notes });
  }
  
  return parsedResults;
}

// Smart Data Merger
function handleCSVSmartMerge(newSentences) {
  const todayStr = new Date().toISOString().split('T')[0];
  
  // 1. Maintain progress for sentences still present
  newSentences.forEach(s => {
    if (!progress[s.id]) {
      progress[s.id] = {
        status: 'unstarted',
        playCount: 0,
        lastSeen: todayStr
      };
    } else {
      // Keep existing progress intact
      progress[s.id].lastSeen = todayStr;
    }
  });
  
  // 2. Sentences removed in CSV will remain in progress object silently (in case they are re-added)
  sentences = newSentences;
  saveData();
}

// --- 4. Web Speech Synthesis TTS Controller ---

let globalAudio = null; // 全域單一 Audio 實例，用於手機端手勢授權與防重疊

// 手動在使用者點擊或按鍵時，解鎖 Audio 播放權限（專為手機/iOS端設計）
function unlockAudioContext() {
  if (!globalAudio) {
    globalAudio = new Audio();
  }
  // Only play silent audio to unlock if the engine is OpenAI, because OpenAI requires async fetch.
  // Google TTS is synchronous, so its play is user-triggered and unlocks the audio naturally!
  if (settings.engine === 'openai') {
    try {
      globalAudio.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
      globalAudio.play().catch(err => console.log("Silent play unlock skipped or failed:", err));
    } catch (e) {
      console.warn("Silent play unlock failed:", e);
    }
  }
}

// 統一中止當前所有發音引擎的播放
function cancelAllSpeech() {
  // 1. 停止系統 TTS
  window.speechSynthesis.cancel();
  
  // 2. 停止 Audio TTS (Google/OpenAI)
  if (globalAudio) {
    try {
      globalAudio.pause();
      globalAudio.onended = null;
      globalAudio.onerror = null;
    } catch (e) {
      console.error("停止音訊播放失敗:", e);
    }
  }
}


// 智慧偵測文字語言，自動適配發音口音
function detectLanguage(text) {
  if (!text) return settings.lang || 'en-US';
  
  // 1. 檢測日文字元（平假名、片假名）
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) {
    return 'ja-JP';
  }
  // 2. 檢測韓文字元
  if (/[\uac00-\ud7af]/.test(text)) {
    return 'ko-KR';
  }
  
  const hasChinese = /[\u4e00-\u9fa5]/.test(text);
  const hasEnglish = /[a-zA-Z]/.test(text);
  
  // 3. 如果字串不含任何中文，但含有英文字母，則強制判定為 en-US (避免使用者設定為 zh-TW 導致英文句被用中文語音怪異朗讀)
  if (hasEnglish && !hasChinese) {
    const globalLangLower = (settings.lang || 'en-US').toLowerCase();
    if (globalLangLower.startsWith('zh') || globalLangLower.startsWith('ja') || globalLangLower.startsWith('ko')) {
      return 'en-US';
    }
    return settings.lang || 'en-US';
  }
  
  // 4. 檢測中文字元
  if (hasChinese) {
    return 'zh-TW';
  }
  
  // 預設回退至使用者設定的語言代碼
  return settings.lang || 'en-US';
}

// 淨化語音文字，過濾括號註解、備註或不同語言翻譯，提升發音流暢度
function cleanTextForTTS(text, targetLang) {
  if (!text) return "";
  
  // 1. 移除包含中文字的括號說明，例如：I got a book. (我買了一本書。) -> I got a book.
  let cleaned = text.replace(/[\(\[\{（【][^\(\[\{（【]*[\u4e00-\u9fa5]+[^\)\]\}）】]*[\)\]\}）】]/g, '');
  
  // 2. 如果主體是中文，移除包含英文/半角字元的括號說明
  if (/[\u4e00-\u9fa5]/.test(cleaned)) {
    cleaned = cleaned.replace(/[\(\[\{（【][^\(\[\{（【]*[a-zA-Z]+[^\)\]\}）】]*[\)\]\}）】]/g, '');
  }
  
  // 3. 移除多餘的半形、全形括號以及內部為空白的括號
  cleaned = cleaned.replace(/[\(\[\{（【\s]*[\)\]\}）】]/g, '');
  
  // 4. 如果目標語音語言是英文/拉丁語系，而文字中混雜了中日韓(CJK)字元，則把中日韓字元濾掉，避免 TTS 試圖用英文發音讀中文
  const isLatinLang = targetLang && !targetLang.toLowerCase().startsWith('zh') && 
                      !targetLang.toLowerCase().startsWith('ja') && 
                      !targetLang.toLowerCase().startsWith('ko');
  if (isLatinLang) {
    cleaned = cleaned.replace(/[^\x00-\xff]/g, ''); // 移除雙位元組字元（如中日韓文字）
  }
  return cleaned.trim();
}

// 從瀏覽器可用語音中自動選出最佳語音（優先 Enhanced > Premium > 增強音質 > 高音質 > Natural > Siri > Google > 第一個）
function getBestVoice(lang) {
  const voices = window.speechSynthesis.getVoices();
  const targetLang = (lang || 'en-US').toLowerCase().split('-')[0];
  const langVoices = voices.filter(v => v.lang && v.lang.toLowerCase().replace('_', '-').startsWith(targetLang));
  const pool = langVoices.length > 0 ? langVoices : voices;

  // Priority keywords — iOS Enhanced/Premium voices sound like real humans
  const priority = ['enhanced', 'premium', '增強音質', '高音質', 'natural', 'siri', 'google'];
  for (const kw of priority) {
    const match = pool.find(v => v.name.toLowerCase().includes(kw));
    if (match) return match;
  }
  return pool[0] || null;
}

// 播放 Google 高品質網路語音 (免費、免 Key、CORS 友善)
// ⚠️ 注意：translate.google.com 的 TTS API 在 iOS/行動端會被 CORS 阻擋，會自動 fallback 至系統語音
function playGoogleTTS(text, callback) {
  const lang = detectLanguage(text);
  let cleanedText = cleanTextForTTS(text, lang);
  
  // 限制 200 字以內，防範 Google Translate 官方接口字數上限報錯
  if (cleanedText.length > 200) {
    cleanedText = cleanedText.substring(0, 199);
  }
  
  // 使用 translate.google.com 搭配 client=tw-ob，這被社群證實能取得更高品質、更自然的 Neural/WaveNet 朗讀音色
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(lang)}&client=tw-ob&q=${encodeURIComponent(cleanedText)}`;
  
  if (!globalAudio) {
    globalAudio = new Audio();
  }
  
  cancelAllSpeech();
  
  globalAudio.src = url;
  
  // 設定防變調與變速邏輯，適用於所有瀏覽器（包含 iOS Safari）
  const applySpeedAndPitch = () => {
    try {
      globalAudio.playbackRate = settings.speed || 1.0;
      if ('preservesPitch' in globalAudio) {
        globalAudio.preservesPitch = true;
      } else if ('webkitPreservesPitch' in globalAudio) {
        globalAudio.webkitPreservesPitch = true;
      }
    } catch (e) {
      console.warn("Failed to apply speed/pitch on Google Audio:", e);
    }
  };
  
  globalAudio.onloadedmetadata = applySpeedAndPitch;
  
  // 只有當 readyState 大於 0 (已經載入 metadata) 時才安全套用，防範 iOS Safari 報錯中斷載入
  if (globalAudio.readyState > 0) {
    applySpeedAndPitch();
  }
  
  globalAudio.onended = () => {
    cleanupListeners();
    if (callback) callback();
  };
  
  // Fallback helper：自動選最佳系統語音再播（解決 iOS CORS 阻擋後音質差的問題）
  const fallbackToSystem = () => {
    const lang = detectLanguage(text);
    const bestVoice = getBestVoice(lang);
    const savedVoiceURI = settings.voiceURI;
    if (bestVoice) settings.voiceURI = bestVoice.voiceURI;
    playSystemTTS(text, () => {
      settings.voiceURI = savedVoiceURI;
      if (callback) callback();
    });
  };

  globalAudio.onerror = (err) => {
    console.error("Google TTS error:", err);
    cleanupListeners();
    console.warn("Google 語音播放出錯（可能為 iOS/行動端 CORS 限制），自動降級至最佳系統語音...");
    fallbackToSystem();
  };

  function cleanupListeners() {
    globalAudio.onended = null;
    globalAudio.onerror = null;
    globalAudio.onloadedmetadata = null;
  }

  globalAudio.play().catch(err => {
    console.error("Google Audio play failed:", err);
    cleanupListeners();
    console.warn("Google 語音播放失敗（可能為 iOS/行動端 CORS 限制），自動降級至最佳系統語音...");
    fallbackToSystem();
  });
}

// 播放 OpenAI 頂級真人 AI 語音 (極致效果，需 Key)
async function playOpenAITTS(text, callback) {
  const apiKey = settings.openaiApiKey;
  if (!apiKey) {
    console.warn("未設定 OpenAI API Key，自動降級切換至 Google 高品質語音...");
    playGoogleTTS(text, callback);
    return;
  }
  
  const lang = detectLanguage(text);
  const cleanedText = cleanTextForTTS(text, lang);
  
  if (!globalAudio) {
    globalAudio = new Audio();
  }
  
  cancelAllSpeech();
  
  let audioUrl = null;
  
  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "tts-1",
        input: cleanedText,
        voice: settings.openaiVoice || 'alloy',
        speed: settings.speed || 1.0
      })
    });
    
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API 錯誤: ${response.status} - ${errText}`);
    }
    
    const blob = await response.blob();
    audioUrl = URL.createObjectURL(blob);
    
    globalAudio.src = audioUrl;
    
    // 設定防變調與變速邏輯，確保變速行為一致（OpenAI 雖然在 API 端變速，但我們在瀏覽器端依然維持相應控制）
    const applyPitch = () => {
      try {
        globalAudio.playbackRate = 1.0; // speed is already handled by OpenAI API
        if ('preservesPitch' in globalAudio) {
          globalAudio.preservesPitch = true;
        } else if ('webkitPreservesPitch' in globalAudio) {
          globalAudio.webkitPreservesPitch = true;
        }
      } catch (e) {
        console.warn("Failed to apply pitch on OpenAI Audio:", e);
      }
    };
    
    globalAudio.onloadedmetadata = applyPitch;
    
    if (globalAudio.readyState > 0) {
      applyPitch();
    }
    
    globalAudio.onended = () => {
      cleanupListeners();
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      if (callback) callback();
    };
    
    globalAudio.onerror = (err) => {
      console.error("OpenAI TTS Audio error:", err);
      cleanupListeners();
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      console.warn("OpenAI 語音音軌載入失敗，自動降級至 Google 高品質語音...");
      playGoogleTTS(text, callback);
    };
    
    function cleanupListeners() {
      globalAudio.onended = null;
      globalAudio.onerror = null;
      globalAudio.onloadedmetadata = null;
    }
    
    globalAudio.play().catch(err => {
      console.error("OpenAI Audio play failed:", err);
      cleanupListeners();
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      console.warn("OpenAI 語音播放出錯，自動降級至 Google 高品質語音...");
      playGoogleTTS(text, callback);
    });
    
  } catch (error) {
    console.error("OpenAI TTS 請求錯誤:", error);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    playGoogleTTS(text, callback);
  }
}

// 播放系統內建 TTS 語音 (Web Speech API, 回退引擎)
function playSystemTTS(text, callback) {
  const lang = detectLanguage(text);
  let cleanedText = cleanTextForTTS(text, lang);
  
  cancelAllSpeech();
  
  const utterance = new SpeechSynthesisUtterance(cleanedText);
  utterance.lang = lang;
  utterance.rate = settings.speed || 1.0;
  
  // 嘗試匹配使用者指定的系統發音人
  if (settings.voiceURI) {
    const voices = window.speechSynthesis.getVoices();
    const matchedVoice = voices.find(v => v.voiceURI === settings.voiceURI);
    if (matchedVoice) {
      utterance.voice = matchedVoice;
    }
  }
  
  let called = false;
  const finish = () => {
    if (!called) {
      called = true;
      if (callback) callback();
    }
  };
  
  utterance.onend = finish;
  utterance.onerror = (e) => {
    console.error("System TTS error:", e);
    finish();
  };
  
  // 安全逾時防線 (解決某些行動裝置瀏覽器遺失 onend 事件的 Bug)
  const duration = (cleanedText.length * 0.15 + 1.0) / (settings.speed || 1.0) * 1000;
  const safetyTimeout = setTimeout(finish, duration + 2000);
  
  utterance.onend = () => {
    clearTimeout(safetyTimeout);
    finish();
  };
  utterance.onerror = () => {
    clearTimeout(safetyTimeout);
    finish();
  };
  
  window.speechSynthesis.speak(utterance);
}


// Speaks a single text string and executes a callback on completion
function speakSingle(text, callback) {
  cancelAllSpeech(); // 每次開始前先停止所有 ongoing 語音
  
  if (!text) {
    if (callback) callback();
    return;
  }
  
  // 依引擎分流
  if (settings.engine === 'google') {
    playGoogleTTS(text, callback);
  } else if (settings.engine === 'openai') {
    playOpenAITTS(text, callback);
  } else {
    playSystemTTS(text, callback);
  }
}

// Handles N-times loops recursively using speechSynthesis events
function speakRepeat(text, n, count, onComplete, onProgress) {
  if (count >= n || !activePlayingId) {
    if (onComplete) onComplete();
    return;
  }
  
  if (onProgress) onProgress(count + 1, n);
  
  speakSingle(text, () => {
    speakRepeat(text, n, count + 1, onComplete, onProgress);
  });
}

// Manual play trigger from a card
function playCardSentence(cardId, repeatCount) {
  unlockAudioContext(); // 解鎖手機端音訊播放
  if (isBrushTeethActive) {
    stopBrushTeethMode();
  }
  
  const sentence = sentences.find(s => s.id === cardId);
  if (!sentence) return;
  
  activePlayingId = cardId;
  focusedCardId = cardId;
  incrementPlayCount(cardId);
  
  renderCards();
  
  speakRepeat(
    sentence.target,
    repeatCount,
    0,
    // OnComplete
    () => {
      activePlayingId = null;
      renderCards();
    },
    // OnProgress (Not strictly displayed on normal card headers, but good for stability)
    null
  );
}

function incrementPlayCount(cardId) {
  if (!progress[cardId]) {
    progress[cardId] = { status: 'unstarted', playCount: 0 };
  }
  
  progress[cardId].playCount++;
  
  // Automatically move from "未開始" to "練習中" if played
  if (progress[cardId].status === 'unstarted') {
    progress[cardId].status = 'practicing';
  }
  
  progress[cardId].lastSeen = new Date().toISOString().split('T')[0];
  saveData();
  updateProgressTracker();
}

// --- 5. Brush Teeth Background Mode State Machine ---

function startBrushTeethMode() {
  unlockAudioContext(); // 解鎖手機端音訊播放
  const filtered = getFilteredSentences();
  if (filtered.length === 0) {
    alert("目前篩選的清單中沒有句子！請調整過濾條件。");
    stopBrushTeethMode();
    return;
  }
  
  isBrushTeethActive = true;
  btSentenceIndex = 0;
  
  // Visual button updates
  const btn = document.getElementById("btn-brush-teeth");
  if (btn) btn.classList.add("active");
  
  playNextBrushTeeth();
}

function playNextBrushTeeth() {
  if (!isBrushTeethActive) return;
  
  const filtered = getFilteredSentences();
  if (filtered.length === 0) {
    stopBrushTeethMode();
    return;
  }
  
  // Wrap around index
  if (btSentenceIndex >= filtered.length) {
    btSentenceIndex = 0;
  }
  
  const sentence = filtered[btSentenceIndex];
  activePlayingId = sentence.id;
  focusedCardId = sentence.id;
  
  incrementPlayCount(sentence.id);
  renderCards();
  
  // Auto-scroll active card to center
  const cardEl = document.getElementById(`card-${sentence.id}`);
  if (cardEl) {
    cardEl.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  
  const repeatCount = settings.singleRepeat;
  
  speakRepeat(
    sentence.target,
    repeatCount,
    0,
    // OnComplete
    () => {
      if (!isBrushTeethActive) return;
      
      btSentenceIndex++;
      updateBrushTeethUI(0, repeatCount);
      
      // Delay and play next
      btTimeoutId = setTimeout(() => {
        playNextBrushTeeth();
      }, settings.gap * 1000);
    },
    // OnProgress
    (currentRep, totalRep) => {
      updateBrushTeethUI(currentRep, totalRep);
    }
  );
}

function stopBrushTeethMode() {
  isBrushTeethActive = false;
  activePlayingId = null;
  
  cancelAllSpeech();
  if (btTimeoutId) clearTimeout(btTimeoutId);
  
  const btn = document.getElementById("btn-brush-teeth");
  if (btn) btn.classList.remove("active");
  
  updateBrushTeethUI();
  renderCards();
}

function updateBrushTeethUI(currentRep = 0, totalRep = 0) {
  const textEl = document.getElementById("brush-teeth-text");
  if (!textEl) return;
  
  if (isBrushTeethActive) {
    const filtered = getFilteredSentences();
    const currentNum = btSentenceIndex + 1;
    const totalNum = filtered.length;
    
    if (currentRep > 0) {
      textEl.textContent = `🌙 運行中：第 ${currentNum}/${totalNum} 句 ｜ 第 ${currentRep}/${totalRep} 遍 (點擊關閉)`;
    } else {
      textEl.textContent = `🌙 運行中：第 ${currentNum}/${totalNum} 句 ｜ 準備中... (點擊關閉)`;
    }
  } else {
    textEl.textContent = "開啟 刷牙洗臉背景模式";
  }
}

// --- 6. Data Filtering & UI Rendering Engine ---

function getFilteredSentences() {
  return sentences.filter(s => {
    // 1. Text Search query filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const targetMatch = s.target.toLowerCase().includes(q);
      const transMatch = s.translation.toLowerCase().includes(q);
      if (!targetMatch && !transMatch) return false;
    }
    
    // 2. Status filter
    const prog = progress[s.id] || { status: 'unstarted' };
    if (statusFilter !== "all" && prog.status !== statusFilter) {
      return false;
    }
    
    // 3. Context (tags) filter
    if (contextFilter !== "all" && s.context !== contextFilter) {
      return false;
    }
    
    return true;
  });
}

function updateProgressTracker() {
  const total = sentences.length;
  if (total === 0) {
    document.getElementById("pb-mastered").style.width = "0%";
    document.getElementById("pb-practicing").style.width = "0%";
    document.getElementById("pb-unstarted").style.width = "100%";
    document.getElementById("progress-summary-text").textContent = "已熟悉 0 ｜ 練習中 0 ｜ 共 0 句";
    document.getElementById("progress-percent-text").textContent = "0%";
    return;
  }
  
  let masteredCount = 0;
  let practicingCount = 0;
  let unstartedCount = 0;
  
  sentences.forEach(s => {
    const prog = progress[s.id] || { status: 'unstarted' };
    if (prog.status === 'mastered') masteredCount++;
    else if (prog.status === 'practicing') practicingCount++;
    else unstartedCount++;
  });
  
  const mPercent = (masteredCount / total) * 100;
  const pPercent = (practicingCount / total) * 100;
  const uPercent = (unstartedCount / total) * 100;
  
  document.getElementById("pb-mastered").style.width = `${mPercent}%`;
  document.getElementById("pb-practicing").style.width = `${pPercent}%`;
  document.getElementById("pb-unstarted").style.width = `${uPercent}%`;
  
  document.getElementById("progress-summary-text").textContent = 
    `已熟悉 ${masteredCount} ｜ 練習中 ${practicingCount} ｜ 共 ${total} 句`;
    
  const overallPercent = Math.round(mPercent);
  document.getElementById("progress-percent-text").textContent = `${overallPercent}%`;
}

function updateContextDropdown() {
  const select = document.getElementById("context-filter");
  if (!select) return;
  
  // Extract unique tags
  const tags = new Set();
  sentences.forEach(s => {
    if (s.context) tags.add(s.context);
  });
  
  // Save current selection
  const currentSelection = select.value;
  
  // Reset options
  select.innerHTML = '<option value="all">📁 所有標籤</option>';
  
  Array.from(tags).sort().forEach(tag => {
    const option = document.createElement("option");
    option.value = tag;
    option.textContent = tag;
    select.appendChild(option);
  });
  
  // Restore selection
  if (tags.has(currentSelection)) {
    select.value = currentSelection;
  } else {
    contextFilter = "all";
  }
}

function renderCards() {
  const grid = document.getElementById("cards-grid");
  if (!grid) return;
  
  const filtered = getFilteredSentences();
  const totalItems = filtered.length;
  
  if (totalItems === 0) {
    grid.innerHTML = `
      <div class="welcome-card card-glass text-center" style="padding: 30px;">
        <div style="font-size: 2rem;">🔍</div>
        <h3>沒有符合條件的句子</h3>
        <p style="font-size: 0.85rem; color: var(--text-secondary);">請調整搜尋文字、狀態標籤或重新點選篩選器。</p>
      </div>
    `;
    document.getElementById("pagination-bar").style.display = "none";
    return;
  }
  
  // Calculate paging bounds
  const totalPages = Math.ceil(totalItems / itemsPerPage);
  if (currentPage > totalPages) currentPage = totalPages || 1;
  
  const startIdx = (currentPage - 1) * itemsPerPage;
  const endIdx = Math.min(startIdx + itemsPerPage, totalItems);
  
  const paginatedList = filtered.slice(startIdx, endIdx);
  
  // Update pagination indicator
  document.getElementById("page-indicator").textContent = `第 ${currentPage} / ${totalPages} 頁`;
  document.getElementById("pagination-bar").style.display = totalPages > 1 ? "flex" : "none";
  document.getElementById("btn-prev-page").disabled = currentPage === 1;
  document.getElementById("btn-next-page").disabled = currentPage === totalPages;
  
  grid.innerHTML = "";
  
  paginatedList.forEach(s => {
    const prog = progress[s.id] || { status: 'unstarted', playCount: 0 };
    const isPlaying = activePlayingId === s.id;
    const isFocused = focusedCardId === s.id;
    
    // Check if card has local mask overrides
    const localMaskKey = `lf-mask-${s.id}`;
    let isMasked = localStorage.getItem(localMaskKey) !== "false";
    
    // Status Badge classes
    let statusClass = "badge-unstarted";
    let statusLabel = "🔘 未開始";
    if (prog.status === 'practicing') {
      statusClass = "badge-practicing";
      statusLabel = "🔵 練習中";
    } else if (prog.status === 'mastered') {
      statusClass = "badge-mastered";
      statusLabel = "✅ 已熟悉";
    }
    
    // Create card div element
    const card = document.createElement("div");
    card.id = `card-${s.id}`;
    card.className = `sentence-card card-${prog.status} ${isPlaying ? 'playing' : ''} ${isFocused ? 'focused' : ''}`;
    
    card.innerHTML = `
      <!-- Card Header -->
      <div class="card-header-row">
        <div class="card-id-badges">
          <span class="card-id">#${s.id}</span>
          <span class="badge-status ${statusClass}" data-id="${s.id}">${statusLabel}</span>
        </div>
        <span class="play-count-badge">聽過 ${prog.playCount} 次</span>
      </div>

      <!-- Card Body -->
      <div class="card-body">
        <p class="sentence-target">${escapeHTML(s.target)}</p>
        
        <!-- Translation block -->
        <div class="translation-box">
          <p class="sentence-translation" style="display: ${isMasked ? 'none' : 'block'};">${escapeHTML(s.translation)}</p>
          <div class="translation-mask" data-id="${s.id}" style="display: ${isMasked ? 'flex' : 'none'};">
            <button class="mask-btn">👁️ 顯示翻譯</button>
          </div>
        </div>
      </div>

      <!-- Card Footer Controls -->
      <div class="card-footer-row">
        <div class="meta-badges">
          ${s.context ? `<span class="meta-badge">${escapeHTML(s.context)}</span>` : ''}
          ${s.difficulty ? `<span class="meta-badge">${escapeHTML(s.difficulty)}</span>` : ''}
          ${s.notes ? `<span class="meta-badge" title="${escapeHTML(s.notes)}">📝 備註</span>` : ''}
        </div>
        
        <div class="play-controls">
          <!-- Play Trigger -->
          <div class="btn-control-wrapper">
            <button class="btn-control btn-play-trigger" data-id="${s.id}" title="播放音檔 (P)">▶</button>
          </div>
          
          <!-- Repeat Count Custom Dropdown Trigger -->
          <div class="btn-control-wrapper">
            <button class="btn-control btn-repeat-trigger" data-id="${s.id}" title="自訂重複播放次數">🔁 ${settings.singleRepeat}x</button>
            
            <!-- Menu populated dynamically on click -->
            <div id="repeat-menu-${s.id}" class="repeat-dropdown-menu" style="display: none;">
              <button class="repeat-menu-item" data-id="${s.id}" data-val="1">1次</button>
              <button class="repeat-menu-item" data-id="${s.id}" data-val="3">3次</button>
              <button class="repeat-menu-item" data-id="${s.id}" data-val="5">5次</button>
              <button class="repeat-menu-item" data-id="${s.id}" data-val="10">10次</button>
              <button class="repeat-menu-item" data-id="${s.id}" data-val="20">20次</button>
            </div>
          </div>
          
          <!-- Speed Indicator -->
          <div class="btn-control-wrapper">
            <button class="btn-control btn-speed-trigger" data-id="${s.id}" title="切換發音速度">${settings.speed}x</button>
          </div>
        </div>
      </div>
    `;
    
    // Bind Event Listeners Directly for precise trigger actions
    
    // 1. Status Badge click: cycles status unstarted -> practicing -> mastered
    const badge = card.querySelector(".badge-status");
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      cycleSentenceStatus(s.id);
    });
    
    // 2. Mask click: reveals translation for this card
    const mask = card.querySelector(".translation-mask");
    mask.addEventListener("click", () => {
      localStorage.setItem(localMaskKey, "false");
      renderCards();
    });
    
    // 3. Translation text click: hides translation for this card (manual re-mask)
    const transText = card.querySelector(".sentence-translation");
    transText.addEventListener("click", () => {
      localStorage.setItem(localMaskKey, "true");
      renderCards();
    });
    
    // 4. Play once/repeat default trigger
    const playBtn = card.querySelector(".btn-play-trigger");
    playBtn.addEventListener("click", () => {
      playCardSentence(s.id, settings.singleRepeat);
    });
    
    // 5. Repeat menu open trigger
    const repeatBtn = card.querySelector(".btn-repeat-trigger");
    repeatBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleRepeatMenu(s.id);
    });
    
    // Bind repeat options menu items
    const repeatItems = card.querySelectorAll(".repeat-menu-item");
    repeatItems.forEach(item => {
      const val = parseInt(item.getAttribute("data-val"));
      if (val === settings.singleRepeat) {
        item.classList.add("active");
      }
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        settings.singleRepeat = val;
        saveData();
        // Hide menu
        document.getElementById(`repeat-menu-${s.id}`).style.display = "none";
        activeRepeatMenuCardId = null;
        // Instantly trigger play with this count!
        playCardSentence(s.id, val);
      });
    });
    
    // 6. Speed Cycle Trigger (0.5x -> 0.75x -> 1.0x -> 1.25x -> 1.5x -> back)
    const speedBtn = card.querySelector(".btn-speed-trigger");
    speedBtn.addEventListener("click", () => {
      cycleSpeedSettings();
      renderCards();
    });
    
    // 7. General click to focus card for hotkey control
    card.addEventListener("click", () => {
      focusedCardId = s.id;
      // Remove outline on all, add to current
      document.querySelectorAll(".sentence-card").forEach(el => el.classList.remove("focused"));
      card.classList.add("focused");
    });
    
    grid.appendChild(card);
  });
}

function cycleSentenceStatus(id) {
  if (!progress[id]) {
    progress[id] = { status: 'unstarted', playCount: 0 };
  }
  
  const current = progress[id].status;
  let next = 'unstarted';
  if (current === 'unstarted') next = 'practicing';
  else if (current === 'practicing') next = 'mastered';
  
  progress[id].status = next;
  progress[id].lastSeen = new Date().toISOString().split('T')[0];
  saveData();
  
  updateProgressTracker();
  renderCards();
}

function cycleSpeedSettings() {
  const speeds = [0.5, 0.75, 1.0, 1.25, 1.5];
  let currIdx = speeds.indexOf(settings.speed);
  if (currIdx === -1) currIdx = 2; // fallback to 1.0
  
  let nextIdx = currIdx + 1;
  if (nextIdx >= speeds.length) nextIdx = 0;
  
  settings.speed = speeds[nextIdx];
  saveData();
  
  // Sync in modal slider if open
  const slider = document.getElementById("settings-speed");
  if (slider) slider.value = settings.speed;
  const speedLabel = document.getElementById("speed-val");
  if (speedLabel) speedLabel.textContent = `${settings.speed}x`;
}

function toggleRepeatMenu(id) {
  const menu = document.getElementById(`repeat-menu-${id}`);
  if (!menu) return;
  
  // Close any active menu first
  if (activeRepeatMenuCardId && activeRepeatMenuCardId !== id) {
    const prevMenu = document.getElementById(`repeat-menu-${activeRepeatMenuCardId}`);
    if (prevMenu) prevMenu.style.display = "none";
  }
  
  if (menu.style.display === "none") {
    menu.style.display = "flex";
    activeRepeatMenuCardId = id;
  } else {
    menu.style.display = "none";
    activeRepeatMenuCardId = null;
  }
}

// Global click listener to close repeat menus
document.addEventListener("click", () => {
  if (activeRepeatMenuCardId) {
    const menu = document.getElementById(`repeat-menu-${activeRepeatMenuCardId}`);
    if (menu) menu.style.display = "none";
    activeRepeatMenuCardId = null;
  }
});

// Helper: Escape unsafe HTML
function escapeHTML(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// --- 7. Settings Modal Form Controllers & Voice Loading ---

function populateVoices() {
  const voiceSelect = document.getElementById("settings-voice");
  if (!voiceSelect) return;
  
  const voices = window.speechSynthesis.getVoices();
  voiceSelect.innerHTML = "";
  
  // Filter voices matching selected lang — show ALL if none match
  // Safe filtering: guards against null/undefined lang, and standardizes underscores to hyphens (useful for iOS)
  const targetLang = settings.lang.toLowerCase().split('-')[0];
  const filteredVoices = voices.filter(v => v.lang && v.lang.toLowerCase().replace('_', '-').startsWith(targetLang));
  const listToUse = filteredVoices.length > 0 ? filteredVoices : voices;

  // Quality tiers (works even when no 'Enhanced' label exists)
  const qualityTier = (v) => {
    const n = v.name.toLowerCase();
    if (n.includes('enhanced') || n.includes('premium') || n.includes('增強音質') || n.includes('高音質') || n.includes('增強')) return 3;
    if (n.includes('natural') || n.includes('siri') || n.includes('google') || !v.localService) return 2;
    return 1;
  };

  // Sort: highest quality first, then alphabetical
  listToUse.sort((a, b) => {
    const diff = qualityTier(b) - qualityTier(a);
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });

  const tierLabel = (v) => {
    const t = qualityTier(v);
    if (t === 3) return '🔥 ';
    if (t === 2) return '⭐ ';
    return '';
  };

  listToUse.forEach(voice => {
    const option = document.createElement("option");
    option.value = voice.voiceURI;
    option.textContent = `${tierLabel(voice)}${voice.name} (${voice.lang})`;
    voiceSelect.appendChild(option);
  });

  // Match current URI selection
  if (settings.voiceURI) {
    voiceSelect.value = settings.voiceURI;
  }

  // If no matched voice was selected, default to the first voice in the sorted dropdown (first high quality voice)
  if (!voiceSelect.value && voiceSelect.options.length > 0) {
    voiceSelect.selectedIndex = 0;
  }

  // Update setting in case current selection has become invalid or was newly set
  if (voiceSelect.value) {
    settings.voiceURI = voiceSelect.value;
  }
}

// 動態控制設定 Modal 欄位顯隱
function toggleEngineFields(engine) {
  const systemVoiceGroup = document.getElementById("system-voice-config-group");
  const openaiConfigGroup = document.getElementById("openai-config-group");
  const langConfigGroup = document.getElementById("lang-config-group");
  
  if (engine === 'system') {
    if (systemVoiceGroup) systemVoiceGroup.style.display = "flex";
    if (openaiConfigGroup) openaiConfigGroup.style.display = "none";
    if (langConfigGroup) langConfigGroup.style.display = "flex";
  } else if (engine === 'google') {
    if (systemVoiceGroup) systemVoiceGroup.style.display = "none";
    if (openaiConfigGroup) openaiConfigGroup.style.display = "none";
    if (langConfigGroup) langConfigGroup.style.display = "flex";
  } else if (engine === 'openai') {
    if (systemVoiceGroup) systemVoiceGroup.style.display = "none";
    if (openaiConfigGroup) openaiConfigGroup.style.display = "flex";
    if (langConfigGroup) langConfigGroup.style.display = "flex";
  }
}

// Initialize settings form with current state
function initSettingsUI() {
  document.getElementById("settings-engine").value = settings.engine || 'google';
  document.getElementById("settings-lang").value = settings.lang;
  document.getElementById("settings-speed").value = settings.speed;
  document.getElementById("speed-val").textContent = `${settings.speed}x`;
  document.getElementById("settings-single-repeat").value = settings.singleRepeat;
  document.getElementById("settings-gap").value = settings.gap;

  // OpenAI 相關
  document.getElementById("settings-openai-key").value = settings.openaiApiKey || '';
  document.getElementById("settings-openai-voice").value = settings.openaiVoice || 'alloy';

  // 依據目前選用的引擎正常切換顯隱，開放 Google/OpenAI TTS 給行動端使用
  toggleEngineFields(settings.engine || 'google');

  populateVoices();

  // iOS Safari 異步載入語音包的輪詢機制，每次打開設定視窗時在 1.5 秒內輪詢 5 次
  let modalVoicePollCount = 0;
  const pollInterval = setInterval(() => {
    populateVoices();
    modalVoicePollCount++;
    if (modalVoicePollCount > 5) clearInterval(pollInterval);
  }, 300);
}

// --- 8. Event Binding & Initialization on DOMContentLoaded ---

document.addEventListener("DOMContentLoaded", () => {
  // Load local state
  loadData();
  
  // Determine initial screen view
  if (sentences.length > 0) {
    document.getElementById("welcome-screen").style.display = "none";
    document.getElementById("learning-screen").style.display = "block";
    updateContextDropdown();
    renderCards();
    updateProgressTracker();
  } else {
    document.getElementById("welcome-screen").style.display = "block";
    document.getElementById("learning-screen").style.display = "none";
    updateProgressTracker();
  }
  
  // Async voice loading listener
  if (window.speechSynthesis.onvoiceschanged !== undefined) {
    window.speechSynthesis.onvoiceschanged = populateVoices;
  }
  // 啟動延時輪詢，解決行動端 iOS Safari 在頁面載入時 getVoices() 常常回傳空陣列的 Bug
  let voiceRetryCount = 0;
  const initVoicePoll = setInterval(() => {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      populateVoices();
      clearInterval(initVoicePoll);
    } else if (voiceRetryCount > 10) {
      clearInterval(initVoicePoll);
    }
    voiceRetryCount++;
  }, 300);
  
  // A. CSV File Upload Listeners
  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("csv-file-input");
  
  if (dropZone && fileInput) {
    dropZone.addEventListener("click", () => fileInput.click());
    
    // Drag/drop events
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    });
    
    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("dragover");
    });
    
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
      
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        handleUploadedFile(files[0]);
      }
    });
    
    fileInput.addEventListener("change", (e) => {
      const files = e.target.files;
      if (files.length > 0) {
        handleUploadedFile(files[0]);
      }
    });
  }
  
  function handleUploadedFile(file) {
    const fileName = file.name.toLowerCase();
    const isExcel = fileName.endsWith(".xlsx") || fileName.endsWith(".xls");
    
    const reader = new FileReader();
    reader.onload = function(evt) {
      try {
        let parsed = [];
        if (isExcel) {
          // Check if XLSX library is loaded correctly
          if (typeof XLSX === "undefined") {
            throw new Error("Excel 解析庫尚未載入，請確認網路連線是否正常！");
          }
          
          const data = new Uint8Array(evt.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          
          // Convert sheet to a 2D array (header: 1 returns array of arrays)
          const lines = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
          
          // Filter out completely empty lines
          const filteredLines = lines.filter(line => line && line.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== ""));
          
          parsed = parse2DArray(filteredLines);
        } else {
          const text = evt.target.result;
          parsed = parseCSV(text);
        }
        
        if (parsed.length === 0) {
          alert(`上傳成功，但解析出 0 句對話。請確認 ${isExcel ? 'Excel' : 'CSV'} 檔案內是否含有欄位與資料！`);
          return;
        }
        
        handleCSVSmartMerge(parsed);
        
        // Hide welcome screen, render App
        document.getElementById("welcome-screen").style.display = "none";
        document.getElementById("learning-screen").style.display = "block";
        
        currentPage = 1;
        updateContextDropdown();
        renderCards();
        updateProgressTracker();
        
        alert(`🎉 成功匯入 ${parsed.length} 句對話教材！`);
      } catch (err) {
        alert(err.message || `解析 ${isExcel ? 'Excel' : 'CSV'} 檔案失敗！請確認檔案欄位格式是否正確。`);
      }
    };
    
    if (isExcel) {
      reader.readAsArrayBuffer(file);
    } else {
      reader.readAsText(file, "UTF-8");
    }
  }
  
  // B. Navigation & Header Button Listeners
  const btnSettings = document.getElementById("btn-open-settings");
  const modalSettings = document.getElementById("settings-modal");
  const btnCloseSettings = document.getElementById("btn-close-settings");
  const btnSaveSettings = document.getElementById("btn-save-settings");
  
  if (btnSettings && modalSettings) {
    btnSettings.addEventListener("click", () => {
      initSettingsUI();
      modalSettings.style.display = "flex";
    });
    
    const hideSettings = () => { modalSettings.style.display = "none"; };
    if (btnCloseSettings) btnCloseSettings.addEventListener("click", hideSettings);
    
    // Save Settings Event
    if (btnSaveSettings) {
      btnSaveSettings.addEventListener("click", (e) => {
        e.preventDefault();
        
        settings.engine = document.getElementById("settings-engine").value || 'google';
        settings.lang = document.getElementById("settings-lang").value.trim() || 'en-US';
        settings.voiceURI = document.getElementById("settings-voice").value;
        settings.speed = parseFloat(document.getElementById("settings-speed").value);
        settings.singleRepeat = parseInt(document.getElementById("settings-single-repeat").value);
        settings.gap = parseFloat(document.getElementById("settings-gap").value);
        
        // OpenAI 相關
        settings.openaiApiKey = document.getElementById("settings-openai-key").value.trim();
        settings.openaiVoice = document.getElementById("settings-openai-voice").value || 'alloy';
        
        saveData();
        hideSettings();
        
        // Re-render
        renderCards();
        alert("設定儲存成功！已套用新配置。");
      });
    }
  }
  
  // 試聽按鈕：用選單目前選的語音朗讀一段示範句子


  // Lang input listener to refresh voice selections
  const langInput = document.getElementById("settings-lang");
  if (langInput) {
    langInput.addEventListener("change", () => {
      settings.lang = langInput.value.trim() || 'en-US';
      populateVoices();
    });
  }
  
  // Engine select listener to toggle fields
  const engineSelect = document.getElementById("settings-engine");
  if (engineSelect) {
    engineSelect.addEventListener("change", (e) => {
      toggleEngineFields(e.target.value);
    });
  }
  
  // Speed Range Slider Indicator sync
  const speedSlider = document.getElementById("settings-speed");
  if (speedSlider) {
    speedSlider.addEventListener("input", (e) => {
      document.getElementById("speed-val").textContent = `${e.target.value}x`;
    });
  }
  
  // C. Reset progress triggers with secondary modal
  const btnResetTrigger = document.getElementById("btn-clear-progress-trigger");
  const confirmModal = document.getElementById("confirm-modal");
  const btnConfirmCancel = document.getElementById("btn-confirm-cancel");
  const btnConfirmYes = document.getElementById("btn-confirm-yes");
  
  if (btnResetTrigger && confirmModal) {
    btnResetTrigger.addEventListener("click", () => {
      confirmModal.style.display = "flex";
    });
    
    const hideConfirm = () => { confirmModal.style.display = "none"; };
    if (btnConfirmCancel) btnConfirmCancel.addEventListener("click", hideConfirm);
    
    if (btnConfirmYes) {
      btnConfirmYes.addEventListener("click", () => {
        // Reset progress status for all sentences
        Object.keys(progress).forEach(id => {
          progress[id].status = 'unstarted';
          progress[id].playCount = 0;
        });
        saveData();
        hideConfirm();
        modalSettings.style.display = "none"; // Hide settings too
        
        updateProgressTracker();
        renderCards();
        alert("🟢 所有學習進度已成功歸零重設！");
      });
    }
  }
  
  // D. Re-upload CSV inside Settings modal
  const btnReupload = document.getElementById("btn-reupload-csv");
  if (btnReupload) {
    btnReupload.addEventListener("click", () => {
      modalSettings.style.display = "none";
      document.getElementById("csv-file-input").click();
    });
  }
  
  // E. Filter and Search Control Bindings
  const searchInput = document.getElementById("search-input");
  const btnClearSearch = document.getElementById("btn-clear-search");
  let searchDebounceTimeout = null;
  
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      const val = e.target.value;
      if (btnClearSearch) {
        btnClearSearch.style.display = val ? "block" : "none";
      }
      
      // Debounce search update (300ms)
      if (searchDebounceTimeout) clearTimeout(searchDebounceTimeout);
      
      searchDebounceTimeout = setTimeout(() => {
        searchQuery = val.trim();
        currentPage = 1;
        renderCards();
      }, 300);
    });
    
    if (btnClearSearch) {
      btnClearSearch.addEventListener("click", () => {
        searchInput.value = "";
        btnClearSearch.style.display = "none";
        searchQuery = "";
        currentPage = 1;
        renderCards();
      });
    }
  }
  
  // Status tab clicks
  const tabs = document.querySelectorAll(".status-tab");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      
      statusFilter = tab.getAttribute("data-status");
      currentPage = 1;
      renderCards();
    });
  });
  
  // Context tag select dropdown
  const contextSelect = document.getElementById("context-filter");
  if (contextSelect) {
    contextSelect.addEventListener("change", (e) => {
      contextFilter = e.target.value;
      currentPage = 1;
      renderCards();
    });
  }
  
  // One-click Header Toggle for All Translation masks
  const btnToggleAllTrans = document.getElementById("btn-toggle-all-trans");
  let allTransVisible = false; // toggle state
  
  if (btnToggleAllTrans) {
    btnToggleAllTrans.addEventListener("click", () => {
      allTransVisible = !allTransVisible;
      
      // Select currently displayed page items and set their local override masks
      const filtered = getFilteredSentences();
      const totalItems = filtered.length;
      const totalPages = Math.ceil(totalItems / itemsPerPage);
      const startIdx = (currentPage - 1) * itemsPerPage;
      const endIdx = Math.min(startIdx + itemsPerPage, totalItems);
      const pageList = filtered.slice(startIdx, endIdx);
      
      pageList.forEach(s => {
        const localMaskKey = `lf-mask-${s.id}`;
        localStorage.setItem(localMaskKey, allTransVisible ? "false" : "true");
      });
      
      // Visual feedback change
      const icon = btnToggleAllTrans.querySelector(".icon");
      if (icon) icon.textContent = allTransVisible ? "🙈" : "👁️";
      
      renderCards();
    });
  }
  
  // F. Pagination button bindings
  const btnPrevPage = document.getElementById("btn-prev-page");
  const btnNextPage = document.getElementById("btn-next-page");
  
  if (btnPrevPage && btnNextPage) {
    btnPrevPage.addEventListener("click", () => {
      if (currentPage > 1) {
        currentPage--;
        renderCards();
        document.getElementById("cards-grid").scrollIntoView({ behavior: "smooth" });
      }
    });
    
    btnNextPage.addEventListener("click", () => {
      const filtered = getFilteredSentences();
      const totalPages = Math.ceil(filtered.length / itemsPerPage);
      if (currentPage < totalPages) {
        currentPage++;
        renderCards();
        document.getElementById("cards-grid").scrollIntoView({ behavior: "smooth" });
      }
    });
  }
  
  // G. Fixed Bottom Toolbar: Brush Teeth Mode trigger
  const btnBrushTeeth = document.getElementById("btn-brush-teeth");
  if (btnBrushTeeth) {
    btnBrushTeeth.addEventListener("click", () => {
      if (isBrushTeethActive) {
        stopBrushTeethMode();
      } else {
        startBrushTeethMode();
      }
    });
  }
  
  // H. Global Keyboard Shortcuts (Space, P, T)
  document.addEventListener("keydown", (e) => {
    // Ignore hotkeys if user is currently typing in an input field or modal
    const activeEl = document.activeElement;
    const isInput = activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA" || activeEl.tagName === "SELECT";
    if (isInput) return;
    
    const key = e.key.toLowerCase();
    
    // Space key: toggle Brush Teeth Mode
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      if (isBrushTeethActive) {
        stopBrushTeethMode();
      } else {
        startBrushTeethMode();
      }
    }
    
    // P key: Play currently focused card
    else if (key === "p") {
      if (focusedCardId) {
        e.preventDefault();
        playCardSentence(focusedCardId, settings.singleRepeat);
      }
    }
    
    // T key: Toggle translation for all on this page
    else if (key === "t") {
      e.preventDefault();
      if (btnToggleAllTrans) btnToggleAllTrans.click();
    }
  });
});
