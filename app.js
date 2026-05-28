// ==========================================================================
// LinguaFlow App Logic (Pure Client-Side PWA Controller)
// ==========================================================================

// --- 1. Global State ---
let sentences = [];    // Raw sentences parsed from CSV
let progress = {};     // Status & play counts: { id: { status: 'unstarted'|'practicing'|'mastered', playCount: 0, lastSeen: 'YYYY-MM-DD' } }
let settings = {
  lang: 'en-US',
  voiceURI: '',
  speed: 1.0,
  singleRepeat: 5,
  gap: 1.0
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

// --- 3. Robust CSV Parser ---
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
  
  if (lines.length === 0) return [];
  
  // Header identification
  const headers = lines[0].map(h => h.trim().toLowerCase());
  const targetIdx = headers.indexOf('target');
  const transIdx = headers.indexOf('translation');
  const idIdx = headers.indexOf('id');
  const contextIdx = headers.indexOf('context');
  const diffIdx = headers.indexOf('difficulty');
  const notesIdx = headers.indexOf('notes');
  
  if (targetIdx === -1 || transIdx === -1) {
    throw new Error("CSV 格式錯誤：必須包含 'target' (英文句子) 與 'translation' (中文翻譯) 欄位！");
  }
  
  const parsedResults = [];
  let autoIdCounter = 1;
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.length <= Math.max(targetIdx, transIdx)) continue;
    
    const target = line[targetIdx]?.trim() || "";
    const translation = line[transIdx]?.trim() || "";
    
    if (!target && !translation) continue; // Skip empty rows
    
    let id = idIdx !== -1 && line[idIdx]?.trim() ? line[idIdx].trim() : "";
    if (!id) {
      id = String(autoIdCounter++).padStart(3, '0');
    }
    
    const context = contextIdx !== -1 ? line[contextIdx]?.trim() || "" : "";
    const difficulty = diffIdx !== -1 ? line[diffIdx]?.trim() || "" : "";
    const notes = notesIdx !== -1 ? line[notesIdx]?.trim() || "" : "";
    
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

// Speaks a single text string and executes a callback on completion
function speakSingle(text, callback) {
  window.speechSynthesis.cancel(); // Terminate ongoing speech immediately
  
  if (!text) {
    if (callback) callback();
    return;
  }
  
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = settings.lang;
  utterance.rate = settings.speed;
  
  // Match System Voice
  const voices = window.speechSynthesis.getVoices();
  const matchedVoice = voices.find(v => v.voiceURI === settings.voiceURI);
  if (matchedVoice) {
    utterance.voice = matchedVoice;
  }
  
  utterance.onend = () => {
    if (callback) callback();
  };
  
  utterance.onerror = (err) => {
    console.error("SpeechSynthesis error:", err);
    if (callback) callback();
  };
  
  window.speechSynthesis.speak(utterance);
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
  
  window.speechSynthesis.cancel();
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
  
  // Filter voices matching selected settings.lang
  const filteredVoices = voices.filter(v => v.lang.toLowerCase().startsWith(settings.lang.toLowerCase().split('-')[0]));
  
  if (filteredVoices.length === 0) {
    // Fallback: list all system voices
    voices.forEach(voice => {
      const option = document.createElement("option");
      option.value = voice.voiceURI;
      option.textContent = `${voice.name} (${voice.lang})`;
      voiceSelect.appendChild(option);
    });
  } else {
    filteredVoices.forEach(voice => {
      const option = document.createElement("option");
      option.value = voice.voiceURI;
      option.textContent = `${voice.name} (${voice.lang})`;
      voiceSelect.appendChild(option);
    });
  }
  
  // Match current URI selection
  if (settings.voiceURI) {
    voiceSelect.value = settings.voiceURI;
  }
  
  // Update setting in case current selection has become invalid
  if (voiceSelect.value) {
    settings.voiceURI = voiceSelect.value;
  }
}

// Initialize settings form with current state
function initSettingsUI() {
  document.getElementById("settings-lang").value = settings.lang;
  document.getElementById("settings-speed").value = settings.speed;
  document.getElementById("speed-val").textContent = `${settings.speed}x`;
  document.getElementById("settings-single-repeat").value = settings.singleRepeat;
  document.getElementById("settings-gap").value = settings.gap;
  
  populateVoices();
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
    const reader = new FileReader();
    reader.onload = function(evt) {
      try {
        const text = evt.target.result;
        const parsed = parseCSV(text);
        
        if (parsed.length === 0) {
          alert("上傳成功，但解析出 0 句對話。請確認 CSV 是否有內容！");
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
        alert(err.message || "解析 CSV 檔案失敗！請確認檔案編碼與欄位格式是否正確。");
      }
    };
    reader.readAsText(file, "UTF-8");
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
        
        settings.lang = document.getElementById("settings-lang").value.trim() || 'en-US';
        settings.voiceURI = document.getElementById("settings-voice").value;
        settings.speed = parseFloat(document.getElementById("settings-speed").value);
        settings.singleRepeat = parseInt(document.getElementById("settings-single-repeat").value);
        settings.gap = parseFloat(document.getElementById("settings-gap").value);
        
        saveData();
        hideSettings();
        
        // Re-render
        renderCards();
        alert("設定儲存成功！已套用新配置。");
      });
    }
  }
  
  // Lang input listener to refresh voice selections
  const langInput = document.getElementById("settings-lang");
  if (langInput) {
    langInput.addEventListener("change", () => {
      settings.lang = langInput.value.trim() || 'en-US';
      populateVoices();
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
