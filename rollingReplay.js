// rollingReplay.js

// Rolling MediaRecorder buffer that keeps the most recent chunks in memory and
// can flush the current partial chunk on demand so the replay reaches the exact
// moment the user triggered it.
export default class SegmentRotatingReplayBuffer {
  constructor(maxSeconds = 30, videoBitrate = 2_500_000) {
    this.maxSeconds = Number(maxSeconds) || 30;
    this.videoBitrate = Number(videoBitrate) || 2_500_000;

    this.running = false;
    this.paused = false;

    this._stream = null;
    this._recorder = null;
    this._mimeType = "";

    this._chunkTimesliceMs = 250;
    this._chunks = [];
    this._lastChunkAt = 0;
    this._manualBoundaryInProgress = null;
    this._pendingChunkTimestamp = null;
    this._pendingBoundaryResolve = null;
    this._recordingStartedAt = 0;
    this._pausedAt = 0;
    this._pausedTotalMs = 0;
  }

  async start(videoElement) {
    if (!videoElement) return false;

    const stream = this._capture(videoElement);
    if (!stream) return false;

    this._stream = stream;
    this.running = true;
    this.paused = false;
    this._chunks = [];
    this._lastChunkAt = 0;
    this._pendingChunkTimestamp = null;
    this._pendingBoundaryResolve = null;
    this._recordingStartedAt = Date.now();
    this._pausedAt = 0;
    this._pausedTotalMs = 0;

    return this._startRecorder();
  }

  hasData() {
    return this.getAvailableDuration() >= Math.min(this.maxSeconds, 1);
  }

  getAvailableDuration() {
    if (!this.running || !this._recordingStartedAt) return 0;

    const now = Date.now();
    const pausedMs = this.paused && this._pausedAt ? now - this._pausedAt : 0;
    const elapsedMs = now - this._recordingStartedAt - this._pausedTotalMs - pausedMs;
    return Math.max(0, Math.min(this.maxSeconds, elapsedMs / 1000));
  }

  async getReplayBlob() {
    if (!this.running || !this._recorder) return null;

    const boundaryAt = Date.now();
    await this._captureBoundary(boundaryAt);
    this._pruneChunks(boundaryAt);

    const cutoff = boundaryAt - this.maxSeconds * 1000;
    const blobs = this._chunks
      .filter((chunk) => chunk.at >= cutoff && chunk.at <= boundaryAt && chunk.blob && chunk.blob.size > 0)
      .map((chunk) => chunk.blob);

    if (!blobs.length) return null;
    return new Blob(blobs, { type: this._mimeType || "video/webm" });
  }

  pause() {
    this.paused = true;
    if (!this._pausedAt) this._pausedAt = Date.now();
    try {
      if (this._recorder && this._recorder.state === "recording") this._recorder.pause();
    } catch (_) {}
  }

  resume() {
    this.paused = false;
    if (this._pausedAt) {
      this._pausedTotalMs += Date.now() - this._pausedAt;
      this._pausedAt = 0;
    }
    try {
      if (this._recorder && this._recorder.state === "paused") this._recorder.resume();
    } catch (_) {}
  }

  stop() {
    this.running = false;
    this.paused = false;

    try {
      if (this._recorder && (this._recorder.state === "recording" || this._recorder.state === "paused")) {
        this._recorder.stop();
      }
    } catch (_) {}

    this._recorder = null;
    this._stream = null;
    this._chunks = [];
    this._lastChunkAt = 0;
    this._manualBoundaryInProgress = null;
    this._pendingChunkTimestamp = null;
    this._pendingBoundaryResolve = null;
    this._recordingStartedAt = 0;
    this._pausedAt = 0;
    this._pausedTotalMs = 0;
  }

  // ---------- internals ----------

  _capture(videoElement) {
    try {
      if (videoElement.captureStream) return videoElement.captureStream();
      if (videoElement.mozCaptureStream) return videoElement.mozCaptureStream();
      console.warn("[TSR] captureStream() not supported in this browser.");
      return null;
    } catch (e) {
      console.warn("[TSR] captureStream() failed - video may not be ready yet.", e);
      return null;
    }
  }

  _pickMimeType() {
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    for (const mt of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(mt)) return mt;
    }
    return "";
  }

  _startRecorder() {
    if (!this._stream) return false;

    const mimeType = this._pickMimeType();
    const options = {};
    if (mimeType) options.mimeType = mimeType;
    options.videoBitsPerSecond = this.videoBitrate;

    let rec;
    try {
      rec = new MediaRecorder(this._stream, options);
    } catch (e) {
      console.warn("[TSR] MediaRecorder could not be created.", e);
      return false;
    }

    this._mimeType = rec.mimeType || mimeType || "video/webm";

    rec.ondataavailable = (evt) => {
      if (!this.running) return;
      if (!evt?.data || evt.data.size === 0) return;

      const boundaryAt = this._pendingChunkTimestamp;
      const at = boundaryAt ?? Date.now();
      this._pendingChunkTimestamp = null;
      this._lastChunkAt = at;
      this._chunks.push({ blob: evt.data, at });
      this._pruneChunks();

      if (this._pendingBoundaryResolve && boundaryAt && at >= boundaryAt) {
        const resolve = this._pendingBoundaryResolve;
        this._pendingBoundaryResolve = null;
        resolve();
      }
    };

    rec.onerror = (evt) => {
      console.warn("[TSR] MediaRecorder encountered an error.", evt?.error || evt);
    };

    rec.onstop = () => {
      const wasCurrentRecorder = this._recorder === rec;
      if (wasCurrentRecorder) this._recorder = null;
      if (!wasCurrentRecorder) return;
      if (!this.running) return;
      if (this._manualBoundaryInProgress) return;
      this._startRecorder();
    };

    this._recorder = rec;

    try {
      rec.start(this._chunkTimesliceMs);
      return true;
    } catch (e) {
      console.warn("[TSR] MediaRecorder.start() failed - stream may not be ready.", e);
      this._recorder = null;
      return false;
    }
  }

  _pruneChunks(referenceTime = Date.now()) {
    const keepAfter = referenceTime - this.maxSeconds * 1000 - this._chunkTimesliceMs * 2;
    this._chunks = this._chunks.filter((chunk) => chunk.at >= keepAfter);
  }

  async _captureBoundary(boundaryAt) {
    if (this._manualBoundaryInProgress) {
      await this._manualBoundaryInProgress;
      return;
    }
    if (!this._recorder || this._recorder.state !== "recording") return;

    const recorder = this._recorder;
    this._pendingChunkTimestamp = boundaryAt;

    this._manualBoundaryInProgress = new Promise((resolve) => {
      const cleanup = () => {
        recorder.removeEventListener("stop", handleStop);
        this._manualBoundaryInProgress = null;
        resolve();
      };

      const handleStop = () => {
        const waitForBoundaryChunk = new Promise((finish) => {
          if (this._lastChunkAt >= boundaryAt) return finish();
          this._pendingBoundaryResolve = finish;
          setTimeout(() => {
            if (this._pendingBoundaryResolve === finish) {
              this._pendingBoundaryResolve = null;
              finish();
            }
          }, 400);
        });

        waitForBoundaryChunk.finally(() => {
          if (this.running) this._startRecorder();
          cleanup();
        });
      };

      recorder.addEventListener("stop", handleStop, { once: true });

      try {
        recorder.stop();
      } catch (_) {
        this._pendingChunkTimestamp = null;
        cleanup();
      }
    });

    await this._manualBoundaryInProgress;
  }
}
