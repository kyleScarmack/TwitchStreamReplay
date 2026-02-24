class TwitchReplayRecorder {
  constructor() {
    // MediaRecorder state
    this.recorders = [];
    this.dataChunks = [];
    this.recordingStartTimes = [];

    // Control flags / timers
    this.listenerAdded = false;
    this.isReplaying = false;
    this.initializationInProgress = false;
    this.timeouts = [];
    this.adCheckInterval = null;

    // DOM + replay UI
    this.videoElement = null;
    this.captureStream = null;
    this.replayWindow = null;
    this.lastUrl = window.location.href;
    this._replayRaf = null;

    // User settings (overridden from storage)
    this.settings = {
      replayDuration: 30,
      numberOfRecorders: 2,
      keyBinding: 'ArrowLeft',
      volumeReduction: 0.3,
      autoCloseReplay: true,
      rememberWindowPosition: false,
    };

    this.init();
  }

  // Bootstraps once settings + DOM are ready
  async init() {
    await this.loadSettings();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.start());
    } else {
      this.start();
    }
  }

  // Load persisted settings
  async loadSettings() {
    try {
      const stored = await chrome.storage.sync.get(this.settings);
      this.settings = { ...this.settings, ...stored };
    } catch (e) {
      console.error('[Twitch Replay] Error loading settings:', e);
    }
  }

  // Main startup for listeners + video detection
  start() {
    this.setupKeyListener();
    this.setupSettingsListener();
    this.setupWindowListeners();
    this.findVideo();
    setInterval(() => this.checkNavigation(), 500);
  }

  // Hot-reload settings from popup
  setupSettingsListener() {
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === 'SETTINGS_UPDATED') {
        this.settings = { ...this.settings, ...(message.settings || {}) };
      }
    });
  }

  // Detect SPA navigation changes on Twitch
  checkNavigation() {
    const currentUrl = window.location.href;
    if (currentUrl !== this.lastUrl) {
      this.lastUrl = currentUrl;
      this.destroy();
      setTimeout(() => this.findVideo(), 500);
    }
  }

  // Find the active Twitch <video> and initialize recording
  findVideo() {
    const video = document.querySelector('video');
    if (!video) {
      setTimeout(() => this.findVideo(), 800);
      return;
    }
    if (this.videoElement && video !== this.videoElement) {
      this.destroy();
    }
    this.videoElement = video;

    if (video.readyState >= 2) {
      this.initialize();
    } else {
      video.addEventListener('loadeddata', () => this.initialize(), { once: true });
    }

    // Catch video element swaps
    video.addEventListener('loadedmetadata', () => {
      const current = document.querySelector('video');
      if (current && current !== this.videoElement) {
        this.destroy();
        this.findVideo();
      }
    }, { once: true });
  }

  // Listen for the replay hotkey
  setupKeyListener() {
    window.addEventListener('keydown', (e) => {
      if (e.key !== this.settings.keyBinding) return;

      // Ignore keybind while typing
      const el = document.activeElement;
      const isTyping = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (isTyping) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      this.playReplay();
    }, true);
  }

  // Initializes capture + recorders (guarded from double-runs)
  async initialize() {
    if (this.initializationInProgress) {
      console.log("[ITR] Initialization already in progress");
      return false;
    }

    this.initializationInProgress = true;
    console.log("[ITR] Starting initialization with delay...");

    try {
      // Allow Twitch player to settle
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Avoid recording ads
      console.log("[ITR] Checking for ads before initialization...");
      await this.waitForAdToFinish();
      console.log("[ITR] No ads playing, proceeding with initialization");

      const videoElement = document.querySelector("video");
      if (!videoElement) {
        console.warn("[ITR] No video element found.");
        return false;
      }

      // Wait until media is playable
      if (videoElement.readyState < 3) {
        console.log("[ITR] Video not ready yet, waiting for metadata...");
        await new Promise((resolve) => {
          videoElement.addEventListener("loadeddata", resolve, { once: true });
        });
      }

      const mediaStream = await this.captureVideoStream(videoElement);
      if (!mediaStream) {
        console.warn("[ITR] Failed to capture media stream");
        return false;
      }

      if (!mediaStream.getTracks().length) {
        console.warn("[ITR] Media stream has no tracks");
        return false;
      }

      const options = await this.getBestRecordingOptions();
      if (!options) return false;

      await this.initializeRecorders(mediaStream, options);
      return true;
    } finally {
      this.initializationInProgress = false;
    }
  }

  // Periodically pauses recording during ads
  setupAdCheckInterval() {
    if (this.adCheckInterval) {
      clearInterval(this.adCheckInterval);
    }
    this.adCheckInterval = setInterval(async () => {
      if (this.isAdPlaying()) {
        console.log("[ITR] Ad detected, pausing recorders");
        this.pauseAllRecorders();
        await this.waitForAdToFinish();
        console.log("[ITR] Ad finished, resuming recorders");
        this.resumeAllRecorders();
      }
    }, 1000);
  }

  // Pause all active recorders
  pauseAllRecorders() {
    for (let i = 0; i < this.recorders.length; i++) {
      const recorder = this.recorders[i];
      if (recorder.state === "recording") {
        recorder.pause();
      }
    }
  }

  // Resume paused recorders
  resumeAllRecorders() {
    for (let i = 0; i < this.recorders.length; i++) {
      const recorder = this.recorders[i];
      if (recorder.state === "paused") {
        recorder.resume();
      }
    }
  }

  // Twitch ad label detection
  isAdPlaying() {
    return !!document.querySelector('span[data-a-target="video-ad-label"]');
  }

  // Wait until ad label disappears
  async waitForAdToFinish() {
    return new Promise((resolve) => {
      if (!this.isAdPlaying()) {
        resolve();
        return;
      }
      const observer = new MutationObserver(() => {
        if (!this.isAdPlaying()) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });
    });
  }

  // Capture stream from the video element (Chrome/Firefox)
  async captureVideoStream(videoElement) {
    try {
      let stream = null;
      if (videoElement.captureStream) {
        stream = videoElement.captureStream();
      } else if (videoElement.mozCaptureStream) {
        stream = videoElement.mozCaptureStream();
      }
      if (!stream) {
        console.error("[ITR] Video captureStream() not supported");
        return null;
      }
      if (stream.getTracks().length === 0) {
        console.error("[ITR] Captured stream has no tracks");
        return null;
      }
      console.log(
        "[ITR] Successfully captured video stream with tracks:",
        stream.getTracks().map((t) => t.kind).join(", ")
      );
      return stream;
    } catch (error) {
      console.error("[ITR] Error capturing stream:", error);
      return null;
    }
  }

  // Pick best available codec for MediaRecorder
  async getBestRecordingOptions() {
    const codecPreferences = [
      "video/webm; codecs=vp9",
      "video/webm; codecs=vp8",
      "video/webm",
    ];
    for (const mimeType of codecPreferences) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        console.log("[ITR] Using codec:", mimeType);
        return {
          mimeType,
          videoBitsPerSecond: 2500000,
        };
      }
    }
    console.error("[ITR] No supported mime types found");
    return null;
  }

  // Create recorder ring (staggered) to cover last N seconds
  async initializeRecorders(mediaStream, options) {
    this.recorders = [];
    this.dataChunks = [];
    this.recordingStartTimes = [];

    const numberOfRecorders = this.settings.numberOfRecorders || 2;

    for (let i = 0; i < numberOfRecorders; i++) {
      try {
        const recorder = new MediaRecorder(mediaStream, options);
        this.dataChunks[i] = [];

        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            this.dataChunks[i]?.push(event.data);
            console.log(
              `[ITR] Data chunk received for recorder ${i}, total chunks: ${this.dataChunks[i].length}, size: ${event.data.size} bytes`
            );
          }
        };

        recorder.onerror = (error) => {
          console.error(`[ITR] MediaRecorder ${i} error:`, error);
        };

        recorder.onstart = () => {
          this.recordingStartTimes[i] = Date.now();
          console.log(
            `[ITR] Recorder ${i} started at ${new Date(this.recordingStartTimes[i]).toISOString()}`
          );
        };

        recorder.onstop = () => {
          console.log(`[ITR] Recorder ${i} stopped successfully`);
        };

        this.recorders.push(recorder);
      } catch (error) {
        console.error(`[ITR] Error creating MediaRecorder ${i}:`, error);
        return false;
      }
    }

    await this.startStaggeredRecording();
    return true;
  }

  // Start recorder 0 immediately, others offset to fill gaps
  async startStaggeredRecording() {
    this.startRecorder(0);

    const numberOfRecorders = this.settings.numberOfRecorders || 2;
    for (let i = 1; i < numberOfRecorders; i++) {
      this.timeouts.push(
        setTimeout(() => {
          this.startRecorder(i);
        }, (this.settings.replayDuration / numberOfRecorders) * 1000 * i)
      );
    }
  }

  // Start one recorder with a 1s timeslice and scheduled restart
  startRecorder(index) {
    const recorder = this.recorders[index];

    try {
      if (recorder.state === "inactive") {
        this.dataChunks[index] = [];
        recorder.start(1000);
        console.log(`[ITR] Recorder ${index} started with timeslice of 1 second`);

        this.timeouts.push(
          setTimeout(() => {
            this.restartRecorder(index);
          }, this.settings.replayDuration * 1000)
        );
      }
    } catch (error) {
      console.error(`[ITR] Error starting recorder ${index}:`, error);
    }
  }

  // Cycle recorder to maintain rolling buffer
  restartRecorder(index) {
    const recorder = this.recorders[index];

    try {
      if (recorder.state !== "inactive") {
        recorder.stop();
        setTimeout(() => {
          this.startRecorder(index);
        }, 100);
      }
    } catch (error) {
      console.error(`[ITR] Error restarting recorder ${index}:`, error);
    }
  }

  // Choose recorder with most data available
  getBestRecorder() {
    let bestIndex = 0;
    let maxChunks = 0;

    for (let i = 0; i < this.recorders.length; i++) {
      if (this.dataChunks[i] && this.dataChunks[i].length > maxChunks) {
        maxChunks = this.dataChunks[i].length;
        bestIndex = i;
      }
    }

    return {
      index: bestIndex,
      recordedTime: maxChunks,
    };
  }

  // Build a Blob from the best recorder and open replay UI
  async playReplay() {
    if (this.isReplaying) {
      console.log("[ITR] Replay already in progress");
      return;
    }

    const bestRecorder = this.getBestRecorder();
    const chunks = this.dataChunks[bestRecorder.index];

    if (!chunks || chunks.length === 0) {
      console.warn("[ITR] No replay data available yet");
      return;
    }

    console.log(
      `[ITR] Playing replay from recorder ${bestRecorder.index} with ${bestRecorder.recordedTime}s recorded`
    );

    this.isReplaying = true;

    const mime = chunks[0].type || 'video/webm';
    const blob = new Blob(chunks, { type: mime });
    const url = URL.createObjectURL(blob);

    // Reduce underlying stream volume during replay
    const originalVolume = this.videoElement ? this.videoElement.volume : 1.0;
    if (this.videoElement) {
      this.videoElement.volume = Math.max(0, originalVolume * this.settings.volumeReduction);
    }

    this.showReplay(url, originalVolume);
  }

  // Stop recorders, clear timers, and remove UI
  destroy() {
    console.log("[ITR] Destroying replay system");

    if (this.adCheckInterval) {
      clearInterval(this.adCheckInterval);
      this.adCheckInterval = null;
    }

    for (const recorder of this.recorders) {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    }

    for (const timeout of this.timeouts) {
      clearTimeout(timeout);
    }

    this.recorders = [];
    this.dataChunks = [];
    this.recordingStartTimes = [];
    this.timeouts = [];
    this.listenerAdded = false;
    this.isReplaying = false;
    this.initializationInProgress = false;
    this.videoElement = null;
    this.captureStream = null;

    if (this.replayWindow) this.closeReplay();
  }

  // Use fullscreen element when present so overlay stays visible
  getOverlayParent() {
    return document.fullscreenElement || document.body;
  }

  // Keep the window in bounds and attached to the right parent
  setupWindowListeners() {
    if (this._windowListenersReady) return;
    this._windowListenersReady = true;

    window.addEventListener('resize', () => {
      if (this.replayWindow) {
        this.clampToViewport(this.replayWindow);
        this.updateUiScale(this.replayWindow);
      }
    });

    document.addEventListener('fullscreenchange', () => {
      if (!this.replayWindow) return;
      const parent = this.getOverlayParent();
      if (this.replayWindow.parentElement !== parent) {
        parent.appendChild(this.replayWindow);
      }
      this.clampToViewport(this.replayWindow);
    });
  }

  // Build replay window DOM + wire controls
  showReplay(url, originalVolume) {
    if (this.replayWindow) {
      const oldVideo = this.replayWindow.querySelector('video');
      if (oldVideo && oldVideo.src) {
        try { URL.revokeObjectURL(oldVideo.src); } catch (_) {}
      }
      this.closeReplay();
    }

    const container = document.createElement('div');
    container.className = 'twitch-replay-window';
    container.innerHTML = `
      <div class="twitch-replay-content">
        <div class="twitch-replay-inner">
          <div class="twitch-replay-video-wrap">
            <video class="twitch-replay-video" autoplay playsinline></video>
            <div class="twitch-replay-header">
              <div class="twitch-replay-chip">
                <div class="twitch-replay-live-dot"></div>
                <span>Stream Replay</span>
              </div>
              <button class="twitch-replay-close">×</button>
            </div>
          </div>
          <div class="twitch-replay-controls-panel">
            <div class="twitch-replay-seek-wrapper">
              <div class="twitch-replay-seek-buffer" style="width: 0%"></div>
              <div class="twitch-replay-seek-progress" style="width: 0%"></div>
              <input class="twitch-replay-seek" type="range" min="0" max="1000" value="0" step="1">
            </div>
            <div class="twitch-replay-controls-row">
              <button class="twitch-replay-play" title="Play/Pause">▶</button>
              <div class="twitch-replay-time-display">
                <span class="twitch-replay-current">0:00</span>
                <span class="twitch-replay-separator">/</span>
                <span class="twitch-replay-duration">0:00</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="twitch-replay-resize"></div>
    `;

    const parent = this.getOverlayParent();
    parent.appendChild(container);
    this.replayWindow = container;

    // Restore saved window geometry if enabled
    this.applyWindowPosition(container).then(() => {
      this.clampToViewport(container);
      this.updateUiScale(container);
    });

    const video = container.querySelector('video');
    video.src = url;
    video.volume = 1.0;
    video.controls = false;

    const playBtn = container.querySelector('.twitch-replay-play');
    const seek = container.querySelector('.twitch-replay-seek');
    const curEl = container.querySelector('.twitch-replay-current');
    const durEl = container.querySelector('.twitch-replay-duration');
    const progressBar = container.querySelector('.twitch-replay-seek-progress');

    let knownDuration = 0;
    let isScrubbing = false;

    // Format seconds as M:SS
    const fmt = (secs) => {
      if (!isFinite(secs) || secs < 0) return '0:00';
      const s = Math.floor(secs % 60);
      const m = Math.floor(secs / 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
    };

    // Set duration UI and slider max (ms)
    const setDurationUI = (d) => {
      knownDuration = (isFinite(d) && d > 0) ? d : 0;
      durEl.textContent = fmt(knownDuration);
      seek.max = knownDuration > 0 ? Math.floor(knownDuration * 1000).toString() : '1000';
    };

    // Probe duration for blobs that report Infinity/0 initially
    const probeDuration = () => new Promise((resolve) => {
      const probe = document.createElement('video');
      probe.muted = true;
      probe.preload = 'metadata';
      probe.src = url;
      probe.addEventListener('loadedmetadata', () => {
        if (!isFinite(probe.duration) || probe.duration === Infinity || probe.duration === 0) {
          const onTU = () => {
            probe.removeEventListener('timeupdate', onTU);
            resolve(probe.duration);
          };
          probe.addEventListener('timeupdate', onTU, { once: true });
          try { probe.currentTime = 1e101; } catch (_) { resolve(0); }
        } else {
          resolve(probe.duration);
        }
      }, { once: true });
      probe.addEventListener('error', () => resolve(0), { once: true });
    });

    probeDuration().then(setDurationUI);

    video.addEventListener('loadedmetadata', () => {
      if (isFinite(video.duration) && video.duration > 0) setDurationUI(video.duration);
    }, { once: true });

    // UI update loop
    const updateLoop = () => {
      if (!this.replayWindow) return;

      if (knownDuration <= 0 && isFinite(video.duration) && video.duration > 0) {
        setDurationUI(video.duration);
      }

      if (!isScrubbing) {
        const t = video.currentTime || 0;
        curEl.textContent = fmt(t);

        if (knownDuration > 0) {
          const ms = Math.floor(t * 1000);
          const max = parseInt(seek.max || '1000', 10);
          seek.value = Math.min(ms, max).toString();
          const percent = (t / knownDuration) * 100;
          progressBar.style.width = `${Math.min(percent, 100)}%`;
        } else {
          seek.value = '0';
          progressBar.style.width = '0%';
        }
      }

      playBtn.textContent = video.paused ? '▶' : '⏸';
      this._replayRaf = requestAnimationFrame(updateLoop);
    };

    if (this._replayRaf) {
      cancelAnimationFrame(this._replayRaf);
      this._replayRaf = null;
    }
    this._replayRaf = requestAnimationFrame(updateLoop);

    // Play/pause toggle
    playBtn.addEventListener('click', () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });

    // Live scrub preview
    seek.addEventListener('input', () => {
      isScrubbing = true;
      const ms = parseInt(seek.value || '0', 10);
      curEl.textContent = fmt(ms / 1000);
      if (knownDuration > 0) {
        const percent = (ms / 1000 / knownDuration) * 100;
        progressBar.style.width = `${Math.min(percent, 100)}%`;
      }
    });

    // Commit scrub to video
    const commitSeek = () => {
      if (knownDuration <= 0) { isScrubbing = false; return; }
      const ms = parseInt(seek.value || '0', 10);
      const t = ms / 1000;
      try { video.currentTime = Math.min(Math.max(0, t), knownDuration); } catch (_) {}
      isScrubbing = false;
    };

    seek.addEventListener('change', commitSeek);
    seek.addEventListener('mouseup', commitSeek);
    seek.addEventListener('touchend', commitSeek);

    // Close button restores volume + cleans blob URL
    container.querySelector('.twitch-replay-close').addEventListener('click', () => {
      this.isReplaying = false;
      this.closeReplay();
      try { URL.revokeObjectURL(url); } catch (_) {}
      if (this.videoElement) this.videoElement.volume = originalVolume;
    });

    // Auto-close at end (optional)
    video.addEventListener('ended', () => {
      if (!this.settings.autoCloseReplay) return;
      setTimeout(() => {
        this.isReplaying = false;
        this.closeReplay();
        try { URL.revokeObjectURL(url); } catch (_) {}
        if (this.videoElement) this.videoElement.volume = originalVolume;
      }, 350);
    });

    this.makeDraggable(container);
    this.makeResizable(container);
  }

  // Drag window by grabbing the chip/header area
  makeDraggable(container) {
    const header = container.querySelector('.twitch-replay-header');
    const chip = container.querySelector('.twitch-replay-chip');
    const closeBtn = container.querySelector('.twitch-replay-close');

    let isDragging = false;
    let startX = 0, startY = 0, initialX = 0, initialY = 0;

    header.style.cursor = 'default';
    chip.style.cursor = 'move';

    const startDrag = (e) => {
      if (e.target === closeBtn || closeBtn.contains(e.target)) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      initialX = container.offsetLeft;
      initialY = container.offsetTop;
      e.preventDefault();
    };

    header.addEventListener('mousedown', startDrag);

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      container.style.left = (initialX + dx) + 'px';
      container.style.top = (initialY + dy) + 'px';
      container.style.right = 'auto';
      container.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (isDragging && this.settings.rememberWindowPosition) {
        this.saveWindowPosition(container);
      }
      isDragging = false;
      this.clampToViewport(container);
      this.updateUiScale(container);
    });
  }

  // Resize using the bottom-right handle
  makeResizable(container) {
    const handle = container.querySelector('.twitch-replay-resize');

    let isResizing = false;
    let startX = 0, startY = 0, startW = 0, startH = 0;

    handle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startY = e.clientY;
      startW = container.offsetWidth;
      startH = container.offsetHeight;
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const newWidth = startW + (e.clientX - startX);
      const newHeight = startH + (e.clientY - startY);
      const minWidth = 320, minHeight = 246, maxWidth = 800, maxHeight = 600;

      if (newWidth >= minWidth && newWidth <= maxWidth) container.style.width = newWidth + 'px';
      if (newHeight >= minHeight && newHeight <= maxHeight) container.style.height = newHeight + 'px';

      this.clampToViewport(container);
      this.updateUiScale(container);
    });

    document.addEventListener('mouseup', () => {
      isResizing = false;
      this.clampToViewport(container);
      this.updateUiScale(container);
    });
  }

  // Keep window inside viewport bounds
  clampToViewport(container) {
    if (!container) return;
    const parent = this.getOverlayParent();
    const viewW = parent === document.body ? window.innerWidth : parent.clientWidth;
    const viewH = parent === document.body ? window.innerHeight : parent.clientHeight;
    const margin = 8;
    const rect = container.getBoundingClientRect();

    let left = Math.min(Math.max(margin, rect.left), Math.max(margin, viewW - rect.width - margin));
    let top = Math.min(Math.max(margin, rect.top), Math.max(margin, viewH - rect.height - margin));

    container.style.left = `${left}px`;
    container.style.top = `${top}px`;
    container.style.right = 'auto';
    container.style.bottom = 'auto';
  }

  // Adjust UI sizing for small window widths
  updateUiScale(container) {
    if (!container) return;
    const w = container.getBoundingClientRect().width;
    let scale = 1;
    if (w < 340) scale = 0.75;
    else if (w < 380) scale = 0.82;
    else if (w < 420) scale = 0.90;
    else if (w < 460) scale = 0.95;
    container.style.setProperty('--treplay-scale', String(scale));
  }

  // Persist window position (local storage)
  async saveWindowPosition(container) {
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const position = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    try {
      await chrome.storage.local.set({ replayWindowPosition: position });
    } catch (e) {
      console.error('[Twitch Replay] Failed to save window position:', e);
    }
  }

  // Read saved window position
  async getWindowPosition() {
    if (!this.settings.rememberWindowPosition) return null;
    try {
      const result = await chrome.storage.local.get('replayWindowPosition');
      return result.replayWindowPosition || null;
    } catch (e) {
      return null;
    }
  }

  // Apply saved window position if present
  async applyWindowPosition(container) {
    const saved = await this.getWindowPosition();
    if (!saved) return;
    container.style.left = `${saved.left}px`;
    container.style.top = `${saved.top}px`;
    container.style.width = `${saved.width}px`;
    container.style.height = `${saved.height}px`;
    container.style.right = 'auto';
    container.style.bottom = 'auto';
    this.clampToViewport(container);
  }

  // Remove replay window and stop UI RAF loop
  closeReplay() {
    if (this._replayRaf) {
      cancelAnimationFrame(this._replayRaf);
      this._replayRaf = null;
    }
    if (this.replayWindow) {
      this.replayWindow.remove();
      this.replayWindow = null;
    }
  }
}

let __twitchReplayRecorder = null;

// Create recorder instance once the DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    __twitchReplayRecorder = new TwitchReplayRecorder();
  });
} else {
  __twitchReplayRecorder = new TwitchReplayRecorder();
}

// Allow background command to trigger replay
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'CREATE_REPLAY' && __twitchReplayRecorder) {
    __twitchReplayRecorder.playReplay();
  }
});