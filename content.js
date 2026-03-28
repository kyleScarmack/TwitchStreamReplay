// content.js

class TwitchReplayRecorder {
  constructor() {
    // Ring buffer (dynamic import)
    this.ringBuffer = null;
    this._RingBufferCtor = null;

    // State / timers
    this.listenerAdded = false;
    this.isReplaying = false;
    this.initializationInProgress = false;
    this.timeouts = [];
    this.adCheckInterval = null;

    // DOM + overlay
    this.videoElement = null;
    this.captureStream = null; // legacy (unused)
    this.replayWindow = null;
    this.lastUrl = window.location.href;
    this._replayRaf = null;

    // Settings (overridden by storage)
    this.settings = {
      replayDuration: 30,
      numberOfRecorders: 2, // legacy (unused)
      keyBinding: 'ArrowLeft',
      volumeReduction: 0.3,
      autoCloseReplay: true,
      rememberWindowPosition: false,
    };

    this.init();
  }

  // Bootstrap after settings + DOM ready
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
      console.warn('[Twitch Replay] Could not load settings, using defaults.', e);
    }
  }

  // Start listeners + find video
  start() {
    this.setupKeyListener();
    this.setupSettingsListener();
    this.setupWindowListeners();
    this.findVideo();
    setInterval(() => this.checkNavigation(), 500);
  }

  // Listen for popup/storage changes
  setupSettingsListener() {
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === 'SETTINGS_UPDATED') {
        const prevDuration = this.settings.replayDuration;
        this.settings = { ...this.settings, ...(message.settings || {}) };

        if (
          typeof this.settings.replayDuration !== 'undefined' &&
          this.settings.replayDuration !== prevDuration
        ) {
          this.restartBufferSoon();
        }
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.replayDuration) {
        this.settings.replayDuration = changes.replayDuration.newValue;
        this.restartBufferSoon();
      }
    });
  }

  // Restart buffer after a duration change
  restartBufferSoon() {
    try { this.ringBuffer?.stop?.(); } catch (_) {}
    this.ringBuffer = null;
    setTimeout(() => this.initialize(), 250);
  }

  // Detect Twitch SPA navigation
  checkNavigation() {
    const currentUrl = window.location.href;
    if (currentUrl !== this.lastUrl) {
      this.lastUrl = currentUrl;
      this.destroy();
      setTimeout(() => this.findVideo(), 500);
    }
  }

  // Find the active <video> and init buffer
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

    this.initialize();

    // Handle video element swaps
    video.addEventListener(
      'loadedmetadata',
      () => {
        const current = document.querySelector('video');
        if (current && current !== this.videoElement) {
          this.destroy();
          this.findVideo();
        }
      },
      { once: true }
    );
  }

  // Hotkey to trigger replay
  setupKeyListener() {
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== this.settings.keyBinding) return;

        const el = document.activeElement;
        const isTyping =
          el &&
          (el.tagName === 'INPUT' ||
            el.tagName === 'TEXTAREA' ||
            el.isContentEditable);
        if (isTyping) return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        this.playReplay();
      },
      true
    );
  }

  // Dynamic import for rolling buffer
  async getRingBufferCtor() {
    if (this._RingBufferCtor) return this._RingBufferCtor;

    const url = chrome.runtime.getURL('rollingReplay.js');

    let mod;
    try {
      mod = await import(url);
    } catch (e) {
      console.warn('[TSR] Could not load ring buffer module.', e);
      throw e;
    }

    const ctor = mod.default || mod.RollingReplayBuffer || mod.WebCodecsRingBuffer;
    if (!ctor) throw new Error('[TSR] No export found in rollingReplay.js.');

    this._RingBufferCtor = ctor;
    return ctor;
  }

  // Initialize the ring buffer (guarded)
  async initialize() {
    if (this.initializationInProgress) return false;

    this.initializationInProgress = true;

    try {
      await this.waitForAdToFinish();

      const videoElement = document.querySelector('video');
      if (!videoElement) {
        return false;
      }

      this.videoElement = videoElement;

      // Wait until enough data is buffered
      if (videoElement.readyState < 3) {
        await new Promise((resolve) => {
          const check = () => {
            if (!this.videoElement || videoElement !== this.videoElement) return resolve();
            if (videoElement.readyState >= 3) resolve();
            else setTimeout(check, 200);
          };
          check();
        });
      }

      // Reset any existing buffer
      if (this.ringBuffer) {
        try { this.ringBuffer.stop?.(); } catch (_) {}
        this.ringBuffer = null;
      }

      const RingBuffer = await this.getRingBufferCtor();
      const durationSec = Number(this.settings.replayDuration || 30);
      const bitrate = 2_500_000;

      this.ringBuffer = new RingBuffer(durationSec, bitrate);

      const ok = await this.ringBuffer.start(videoElement);

      if (!ok) {
        this.ringBuffer = null;
        return false;
      }

      this.setupAdCheckInterval();
      return true;
    } catch (e) {
      console.warn('[TSR] Initialization failed, will retry on next trigger.', e);
      return false;
    } finally {
      this.initializationInProgress = false;
    }
  }

  // Pause/resume during ads
  setupAdCheckInterval() {
    if (this.adCheckInterval) clearInterval(this.adCheckInterval);

    this.adCheckInterval = setInterval(async () => {
      if (this.isAdPlaying()) {
        this.pauseAllRecorders();
        await this.waitForAdToFinish();
        this.resumeAllRecorders();
      }
    }, 1000);
  }

  pauseAllRecorders() {
    try { this.ringBuffer?.pause?.(); } catch (_) {}
  }

  resumeAllRecorders() {
    try { this.ringBuffer?.resume?.(); } catch (_) {}
  }

  isAdPlaying() {
    return !!document.querySelector('span[data-a-target="video-ad-label"]');
  }

  async waitForAdToFinish() {
    return new Promise((resolve) => {
      if (!this.isAdPlaying()) return resolve();

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

  // Build + show replay from buffer
  async playReplay() {
    if (this.isReplaying) return;

    if (!this.ringBuffer) {
      console.warn('[TSR] Ring buffer not ready yet — try again in a moment.');
      return;
    }

    if (this.ringBuffer?.isLikelyStale?.()) {
      console.warn('[TSR] Recorder stalled; rebuilding replay buffer.');
      const restarted = await this.initialize();
      if (!restarted || !this.ringBuffer?.hasData?.()) {
        console.warn('[TSR] Replay buffer is refreshing â€” try again in a moment.');
        return;
      }
    }

    if (!this.ringBuffer?.hasData?.()) {
      console.warn('[TSR] Buffer still filling — wait for a full clip.');
      return;
    }

    this.isReplaying = true;

    // Reduce stream volume while replay plays
    const originalVolume = this.videoElement ? this.videoElement.volume : 1.0;
    if (this.videoElement) {
      this.videoElement.volume = Math.max(0, originalVolume * this.settings.volumeReduction);
    }

    let replay = null;
    try {
      replay = await this.ringBuffer.getReplay();
    } catch (e) {
      console.warn('[TSR] Could not create replay clip.', e);
    }

    if (!replay || !(replay.blob instanceof Blob) || replay.blob.size === 0) {
      this.isReplaying = false;
      if (this.videoElement) this.videoElement.volume = originalVolume;
      return;
    }

    this.showReplay(replay, originalVolume);
  }

  // Tear down everything on nav/video swap
  destroy() {
    if (this.adCheckInterval) {
      clearInterval(this.adCheckInterval);
      this.adCheckInterval = null;
    }

    if (this.ringBuffer) {
      try { this.ringBuffer.stop?.(); } catch (_) {}
      this.ringBuffer = null;
    }

    for (const timeout of this.timeouts) clearTimeout(timeout);
    this.timeouts = [];

    this.listenerAdded = false;
    this.isReplaying = false;
    this.initializationInProgress = false;
    this.videoElement = null;
    this.captureStream = null;

    if (this.replayWindow) this.closeReplay();
  }

  // Overlay parent (handles fullscreen)
  getOverlayParent() {
    return document.fullscreenElement || document.body;
  }

  // Keep overlay clamped on resize/fullscreen changes
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
      if (this.replayWindow.parentElement !== parent) parent.appendChild(this.replayWindow);
      this.clampToViewport(this.replayWindow);
    });
  }

  // Build replay UI and wire controls
  showReplay(replay, originalVolume) {
    const replayBlob = replay?.blob instanceof Blob ? replay.blob : null;
    const initialDuration = Math.max(0.05, Number(replay?.durationSeconds || 0));

    if (!replayBlob) {
      this.isReplaying = false;
      if (this.videoElement) this.videoElement.volume = originalVolume;
      return;
    }

    let released = false;
    const cleanupFns = [];
    const releaseAssets = () => {
      if (released) return;
      released = true;
      while (cleanupFns.length) {
        try { cleanupFns.pop()(); } catch (_) {}
      }
    };

    let cleanupReplay = () => {
      this.isReplaying = false;
      this.closeReplay();
      if (this.videoElement) this.videoElement.volume = originalVolume;
    };

    const onEsc = (e) => {
      if (e.key === 'Escape') cleanupReplay();
    };
    document.addEventListener('keydown', onEsc, true);
    this._replayEscHandler = onEsc;

    if (this.replayWindow) this.closeReplay();
    this._releaseReplayAssets = releaseAssets;

    const playIcon = () =>
      '<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M8 5v14l11-7z"></path></svg>';
    const pauseIcon = () =>
      '<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M7 5h4v14H7z"></path><path fill="currentColor" d="M13 5h4v14h-4z"></path></svg>';
    const speakerIcon = (muted) => {
      if (muted) {
        return           '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 4V5L7 9H3z"></path><path fill="currentColor" d="M16.5 8.5l4.5 4.5-1.4 1.4-4.5-4.5 1.4-1.4z"></path><path fill="currentColor" d="M21 8.5l-4.5 4.5-1.4-1.4 4.5-4.5 1.4 1.4z"></path></svg>';
      }
      return         '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 4V5L7 9H3z"></path><path fill="currentColor" d="M16.5 12c0-1.8-1-3.3-2.5-4v8c1.5-.7 2.5-2.2 2.5-4z"></path><path fill="currentColor" d="M14 3.2v2.2c2.9 1 5 3.8 5 6.6s-2.1 5.6-5 6.6v2.2c4.1-1.1 7-4.8 7-8.8s-2.9-7.7-7-8.8z"></path></svg>';
    };

    const container = document.createElement('div');
    container.className = 'twitch-replay-window';
    container.innerHTML =
      '<div class="twitch-replay-content"><div class="twitch-replay-inner"><div class="twitch-replay-video-wrap"><video class="twitch-replay-video" playsinline preload="auto"></video><div class="twitch-replay-header"><div class="twitch-replay-chip"><div class="twitch-replay-live-dot"></div><span>Stream Replay</span></div><button class="twitch-replay-close">x</button></div></div><div class="twitch-replay-controls-panel"><div class="twitch-replay-seek-wrapper"><div class="twitch-replay-seek-buffer" style="width: 100%"></div><div class="twitch-replay-seek-progress" style="width: 0%"></div><input class="twitch-replay-seek" type="range" min="0" max="1000" value="0" step="1"></div><div class="twitch-replay-controls-row"><div class="twitch-replay-controls-left"><button class="twitch-replay-play" title="Play/Pause">' + playIcon() + '</button></div><div class="twitch-replay-time-display"><span class="twitch-replay-current">0:00</span><span class="twitch-replay-separator">/</span><span class="twitch-replay-duration">0:00</span></div><div class="twitch-replay-controls-right"><button class="twitch-replay-speed" title="Playback speed">1x</button><button class="twitch-replay-mute" title="Mute/Unmute">' + speakerIcon(false) + '</button></div></div></div></div></div><div class="twitch-replay-resize"></div>';

    const parent = this.getOverlayParent();
    parent.appendChild(container);
    this.replayWindow = container;

    this.applyWindowPosition(container).then(() => {
      this.clampToViewport(container);
      this.updateUiScale(container);
    });

    const video = container.querySelector('.twitch-replay-video');
    const playBtn = container.querySelector('.twitch-replay-play');
    const seek = container.querySelector('.twitch-replay-seek');
    const curEl = container.querySelector('.twitch-replay-current');
    const durEl = container.querySelector('.twitch-replay-duration');
    const progressBar = container.querySelector('.twitch-replay-seek-progress');
    const muteBtn = container.querySelector('.twitch-replay-mute');
    const speedBtn = container.querySelector('.twitch-replay-speed');

    video.volume = 1.0;
    video.controls = false;
    video.autoplay = false;

    container.querySelector('.twitch-replay-close').addEventListener('click', cleanupReplay);
    video.addEventListener('error', cleanupReplay);

    let prevReplayVolume = 1.0;
    const updateMuteIcon = () => {
      const muted = video.muted || video.volume === 0;
      if (muteBtn) muteBtn.innerHTML = speakerIcon(muted);
    };

    if (muteBtn) {
      updateMuteIcon();
      muteBtn.addEventListener('click', () => {
        if (!video.muted && video.volume > 0) {
          prevReplayVolume = video.volume;
          video.muted = true;
          video.volume = 0;
        } else {
          video.muted = false;
          video.volume = prevReplayVolume > 0 ? prevReplayVolume : 1.0;
        }
        updateMuteIcon();
      });
    }

    const SPEEDS = [1.0, 1.5, 2.0, 0.75];
    let speedIdx = 0;
    const applySpeed = () => {
      const speed = SPEEDS[speedIdx];
      video.playbackRate = speed;
      if (speedBtn) speedBtn.textContent = speed + 'x';
    };

    if (speedBtn) {
      applySpeed();
      speedBtn.addEventListener('click', () => {
        speedIdx = (speedIdx + 1) % SPEEDS.length;
        applySpeed();
      });
    }

    const fmt = (secs) => {
      if (!isFinite(secs) || secs < 0) return '0:00';
      const s = Math.floor(secs % 60);
      const m = Math.floor(secs / 60);
      return m + ':' + s.toString().padStart(2, '0');
    };
    const fmtTotal = (secs) => {
      if (!isFinite(secs) || secs < 0) return '0:00';
      const rounded = Math.max(0, Math.round(secs));
      const s = rounded % 60;
      const m = Math.floor(rounded / 60);
      return m + ':' + s.toString().padStart(2, '0');
    };

    const replayUrl = URL.createObjectURL(replayBlob);
    cleanupFns.push(() => {
      try { URL.revokeObjectURL(replayUrl); } catch (_) {}
    });

    let clipDuration = initialDuration;
    let isScrubbing = false;
    let pendingSeekTime = null;
    let seekResumePending = null;
    let metadataReady = false;
    let wantsPlayback = true;
    let playbackSyncId = 0;
    let lastDisplayedTime = 0;

    durEl.textContent = fmtTotal(clipDuration);
    seek.max = Math.max(1, Math.floor(clipDuration * 1000)).toString();

    const setRelativeTime = (clipTime) => {
      const rel = Math.min(Math.max(0, clipTime), clipDuration);
      lastDisplayedTime = rel;
      curEl.textContent = fmt(rel);
      const ms = Math.floor(rel * 1000);
      const max = parseInt(seek.max || '1000', 10);
      seek.value = Math.min(ms, max).toString();
      const percent = clipDuration > 0 ? (rel / clipDuration) * 100 : 0;
      progressBar.style.width = Math.min(percent, 100) + '%';
    };

    const updatePlayIcon = () => {
      const isActuallyPlaying = metadataReady ? (!video.paused && !video.ended) : wantsPlayback;
      playBtn.innerHTML = isActuallyPlaying ? pauseIcon() : playIcon();
    };

    const forcePause = () => {
      playbackSyncId += 1;
      wantsPlayback = false;
      try { video.pause(); } catch (_) {}
      setTimeout(() => { try { video.pause(); } catch (_) {} }, 0);
      setTimeout(() => { try { video.pause(); } catch (_) {} }, 60);
      setTimeout(() => { try { video.pause(); } catch (_) {} }, 180);
      updatePlayIcon();
    };

    const startPlayback = async () => {
      const syncId = ++playbackSyncId;

      if (!metadataReady) {
        updatePlayIcon();
        return;
      }

      wantsPlayback = true;

      if (video.ended) {
        try { video.currentTime = 0; } catch (_) {}
      }

      try {
        await video.play();
      } catch (_) {
        if (syncId !== playbackSyncId || !wantsPlayback) {
          updatePlayIcon();
          return;
        }
        const restoreMuted = video.muted;
        const restoreVolume = video.volume;
        const wasMuted = video.muted;
        try {
          video.muted = true;
          await video.play();
          updateMuteIcon();
          setTimeout(() => {
            if (syncId !== playbackSyncId || !wantsPlayback) return;
            video.muted = restoreMuted;
            video.volume = restoreVolume;
            updateMuteIcon();
          }, 0);
        } catch (_) {
          video.muted = wasMuted;
          updateMuteIcon();
        }
      }

      if (syncId !== playbackSyncId || !wantsPlayback) {
        video.pause();
      }
      updatePlayIcon();
    };

    const finishReplay = () => {
      wantsPlayback = false;
      playbackSyncId += 1;
      setRelativeTime(clipDuration);
      video.pause();
      updatePlayIcon();
      if (this.settings.autoCloseReplay) setTimeout(cleanupReplay, 350);
    };

    const toggleReplayPlayback = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      if (wantsPlayback && !video.paused && !video.ended) {
        forcePause();
      } else {
        wantsPlayback = true;
        startPlayback();
      }
    };

    playBtn.type = 'button';
    playBtn.addEventListener('pointerdown', toggleReplayPlayback);
    playBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
    });

    seek.addEventListener('input', () => {
      isScrubbing = true;
      const ms = parseInt(seek.value || '0', 10);
      const rel = ms / 1000;
      curEl.textContent = fmt(rel);
      const percent = clipDuration > 0 ? (rel / clipDuration) * 100 : 0;
      progressBar.style.width = Math.min(percent, 100) + '%';
    });

    const commitSeek = () => {
      if (!metadataReady) return;
      const ms = parseInt(seek.value || '0', 10);
      const targetTime = Math.min(clipDuration, Math.max(0, ms / 1000));
      pendingSeekTime = targetTime;
      seekResumePending = wantsPlayback;
      try { video.pause(); } catch (_) {}
      try {
        video.currentTime = targetTime;
      } catch (_) {
        try { video.currentTime = targetTime; } catch (_) {}
      }
      setRelativeTime(targetTime);
      isScrubbing = false;
    };

    seek.addEventListener('change', commitSeek);
    seek.addEventListener('mouseup', commitSeek);
    seek.addEventListener('touchend', commitSeek);

    const updateLoop = () => {
      if (!this.replayWindow) return;
      if (!isScrubbing && pendingSeekTime === null && metadataReady) {
        setRelativeTime(Math.min(video.currentTime || 0, clipDuration));
      }
      updatePlayIcon();
      this._replayRaf = requestAnimationFrame(updateLoop);
    };

    if (this._replayRaf) {
      cancelAnimationFrame(this._replayRaf);
      this._replayRaf = null;
    }
    this._replayRaf = requestAnimationFrame(updateLoop);

    video.addEventListener('timeupdate', () => {
      if (!metadataReady) return;
      if (pendingSeekTime !== null) return;
      const currentClipTime = Math.min(clipDuration, video.currentTime || 0);
      setRelativeTime(currentClipTime);
      if (currentClipTime >= clipDuration - 0.05) {
        finishReplay();
        return;
      }
    });

    video.addEventListener('ended', () => {
      if (!metadataReady) return;
      finishReplay();
    });

    video.addEventListener('play', () => {
      updatePlayIcon();
    });
    video.addEventListener('pause', () => {
      updatePlayIcon();
    });
    video.addEventListener('seeked', () => {
      if (!metadataReady) return;
      const landedTime = Math.min(
        clipDuration,
        Number.isFinite(video.currentTime) ? video.currentTime : (pendingSeekTime !== null ? pendingSeekTime : 0)
      );
      pendingSeekTime = null;
      setRelativeTime(landedTime);
      if (seekResumePending === true) {
        seekResumePending = null;
        wantsPlayback = true;
        startPlayback();
      } else {
        seekResumePending = null;
        forcePause();
      }
    });

    const handleReady = () => {
      if (metadataReady) return;
      metadataReady = true;
      if (Number.isFinite(video.duration) && video.duration > 0) {
        clipDuration = video.duration;
        durEl.textContent = fmtTotal(clipDuration);
        seek.max = Math.max(1, Math.floor(clipDuration * 1000)).toString();
      }
      setRelativeTime(0);
      updatePlayIcon();
      if (wantsPlayback) startPlayback();
    };

    video.addEventListener('loadedmetadata', handleReady, { once: true });
    video.addEventListener('loadeddata', handleReady, { once: true });
    video.addEventListener('canplay', handleReady, { once: true });

    video.src = replayUrl;
    try { video.load(); } catch (_) {}

    this.makeDraggable(container);
    this.makeResizable(container);
  }
  // Drag window via header chip
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

  // Resize window via bottom-right handle
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

  // Keep window fully on-screen
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

  // Scale UI at small widths
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

  // Persist window position/size
  async saveWindowPosition(container) {
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const position = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    try {
      await chrome.storage.local.set({ replayWindowPosition: position });
    } catch (e) {
      console.warn('[Twitch Replay] Could not save window position.', e);
    }
  }

  async getWindowPosition() {
    if (!this.settings.rememberWindowPosition) return null;
    try {
      const result = await chrome.storage.local.get('replayWindowPosition');
      return result.replayWindowPosition || null;
    } catch (e) {
      return null;
    }
  }

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

  // Remove overlay
  closeReplay() {
    this.isReplaying = false;

    if (this._replayRaf) {
      cancelAnimationFrame(this._replayRaf);
      this._replayRaf = null;
    }
    if (this._replayEscHandler) {
      document.removeEventListener('keydown', this._replayEscHandler, true);
      this._replayEscHandler = null;
    }
    if (this._releaseReplayAssets) {
      try { this._releaseReplayAssets(); } catch (_) {}
      this._releaseReplayAssets = null;
    }
    if (this.replayWindow) {
      this.replayWindow.remove();
      this.replayWindow = null;
    }
  }
}

let __twitchReplayRecorder = null;

// Init once DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    __twitchReplayRecorder = new TwitchReplayRecorder();
  });
} else {
  __twitchReplayRecorder = new TwitchReplayRecorder();
}

// External trigger from background/popup
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'CREATE_REPLAY' && __twitchReplayRecorder) {
    __twitchReplayRecorder.playReplay();
  }
});
