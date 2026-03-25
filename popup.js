// Default popup settings (used as storage fallback + reset)
// volumeReduction stored as 0–100 integer in the popup layer;
// converted to 0.0–1.0 float only when writing to storage for content.js
const defaultSettings = {
  replayDuration: 30,
  keyBinding: 'ArrowLeft',
  volumeReduction: 30,   // stored as 0–100 here; converted on save
  autoCloseReplay: true,
  rememberWindowPosition: false
};

// Human-readable key names for UI
function keyLabel(key) {
  const map = {
    'ArrowLeft': '← Left Arrow',
    'ArrowRight': '→ Right Arrow',
    'ArrowUp': '↑ Up Arrow',
    'ArrowDown': '↓ Down Arrow',
    ' ': 'Space',
    'Escape': 'Escape',
    'Enter': 'Enter',
    'Backspace': 'Backspace',
    'Tab': 'Tab',
    'CapsLock': 'Caps Lock',
  };
  if (map[key]) return map[key];
  if (key.length === 1) return key.toUpperCase() + ' Key';
  if (/^F\d+$/.test(key)) return key;
  return key;
}

// Keys we don't allow as bindings
const ignoredKeys = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab']);

let currentKey = defaultSettings.keyBinding;
let isListening = false;

// Init popup
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  setupSliders();
  setupKeyCapture();
  document.getElementById('saveBtn').addEventListener('click', saveSettings);
  document.getElementById('resetBtn').addEventListener('click', resetSettings);
});

// Load settings from storage into UI
// volumeReduction comes back as a 0.0–1.0 float from content.js storage,
// so we multiply by 100 before handing it to the slider.
async function loadSettings() {
  const storageDefaults = {
    replayDuration: defaultSettings.replayDuration,
    keyBinding: defaultSettings.keyBinding,
    volumeReduction: defaultSettings.volumeReduction / 100, // expect float in storage
    autoCloseReplay: defaultSettings.autoCloseReplay,
    rememberWindowPosition: defaultSettings.rememberWindowPosition,
  };

  const s = await chrome.storage.sync.get(storageDefaults);

  syncSlider('replayDuration', 'durationInput', s.replayDuration, 5, 60);

  // Convert float 0.0–1.0 → integer 0–100 for the slider
  const volPct = Math.round(s.volumeReduction * 100);
  syncSlider('volumeReduction', 'volumeInput', volPct, 0, 100);

  currentKey = s.keyBinding;
  document.getElementById('keyDisplay').textContent = keyLabel(s.keyBinding);

  document.getElementById('autoCloseReplay').checked = s.autoCloseReplay;
  document.getElementById('rememberWindowPosition').checked = s.rememberWindowPosition;
}

// Sync slider + number input + CSS fill percentage
function syncSlider(sliderId, inputId, value, min, max) {
  const slider = document.getElementById(sliderId);
  const input = document.getElementById(inputId);
  slider.value = value;
  input.value = value;
  const pct = ((value - min) / (max - min)) * 100;
  slider.style.setProperty('--pct', `${pct}%`);
}

function setupSliders() {
  linkSliderAndInput('replayDuration', 'durationInput', 5, 60);
  linkSliderAndInput('volumeReduction', 'volumeInput', 0, 100);
}

// Keeps a range slider and numeric input in sync (with nice typing behavior)
function linkSliderAndInput(sliderId, inputId, min, max) {
  const slider = document.getElementById(sliderId);
  const input = document.getElementById(inputId);

  // Apply clamped value to both controls
  const commit = (value) => {
    const clamped = Math.min(max, Math.max(min, Number(value)));
    slider.value = clamped;
    input.value = clamped;
    const pct = ((clamped - min) / (max - min)) * 100;
    slider.style.setProperty('--pct', `${pct}%`);
  };

  // Slider always commits immediately
  slider.addEventListener('input', () => commit(slider.value));

  // While typing: update slider only when in range (cap max immediately)
  input.addEventListener('input', () => {
    const raw = input.value;
    if (raw === '' || isNaN(raw)) return;
    const num = Number(raw);

    if (num >= min && num <= max) {
      slider.value = num;
      const pct = ((num - min) / (max - min)) * 100;
      slider.style.setProperty('--pct', `${pct}%`);
    } else if (num > max) {
      commit(max);
    }
  });

  // On blur/Enter: clamp fully
  input.addEventListener('blur', () => commit(input.value === '' ? min : input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
}

// Capture a new trigger key binding
function setupKeyCapture() {
  const btn = document.getElementById('keyCapture');
  const hint = document.getElementById('keyHint');

  btn.addEventListener('click', () => {
    if (isListening) return;
    isListening = true;
    btn.classList.add('listening');
    hint.textContent = 'press any key…';

    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (ignoredKeys.has(e.key)) return;
      currentKey = e.key;
      document.getElementById('keyDisplay').textContent = keyLabel(e.key);
      isListening = false;
      btn.classList.remove('listening');
      hint.textContent = 'click to change';
      document.removeEventListener('keydown', onKey, true);
    };

    document.addEventListener('keydown', onKey, true);
  });
}

// Save settings and notify active Twitch tab
// volumeReduction is stored as 0.0–1.0 float so content.js can use it directly
async function saveSettings() {
  const settings = {
    replayDuration: parseInt(document.getElementById('replayDuration').value),
    keyBinding: currentKey,
    volumeReduction: parseInt(document.getElementById('volumeReduction').value) / 100,
    autoCloseReplay: document.getElementById('autoCloseReplay').checked,
    rememberWindowPosition: document.getElementById('rememberWindowPosition').checked
  };

  try {
    await chrome.storage.sync.set(settings);
    showToast('Saved', 'success');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes('twitch.tv')) {
      chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings });
    }
  } catch {
    showToast('Save failed', 'error');
  }
}

// Restore defaults — write as floats to match what loadSettings expects back
async function resetSettings() {
  await chrome.storage.sync.set({
    ...defaultSettings,
    volumeReduction: defaultSettings.volumeReduction / 100, // store as float
  });
  await loadSettings();
  showToast('Reset to defaults', 'success');
}

// Simple toast UI
function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type} show`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2500);
}