// rollingReplay.js

// Rotating MediaRecorder buffer that always keeps the last full segment as a standalone WebM.
export default class SegmentRotatingReplayBuffer {
  constructor(maxSeconds = 30, videoBitrate = 2_500_000) {
    this.maxSeconds = Number(maxSeconds) || 30;
    this.videoBitrate = Number(videoBitrate) || 2_500_000;

    this.running = false;
    this.paused = false;

    this._stream = null;
    this._recorder = null;

    this._chunks = [];
    this._lastBlob = null;

    this._rotateTimer = null;
    this._rotating = false;

    this._mimeType = "";
  }

  async start(videoElement) {
    if (!videoElement) return false;

    const stream = this._capture(videoElement);
    if (!stream) return false;

    this._stream = stream;
    this.running = true;
    this.paused = false;

    // Start first segment
    const ok = this._startRecorder();
    if (!ok) return false;

    // Rotate periodically so _lastBlob is always fresh
    this._startRotationTimer();

    return true;
  }

  hasData() {
    // True only after at least one segment has finalized
    return !!this._lastBlob && this._lastBlob.size > 0;
  }

  async getReplayBlob() {
    // Return last finalized full segment (null before first rotation)
    return this._lastBlob || null;
  }

  pause() {
    this.paused = true;
    try {
      if (this._recorder && this._recorder.state === "recording") this._recorder.pause();
    } catch (_) {}
  }

  resume() {
    this.paused = false;
    try {
      if (this._recorder && this._recorder.state === "paused") this._recorder.resume();
    } catch (_) {}
  }

  stop() {
    this.running = false;
    this.paused = false;

    this._stopRotationTimer();

    try {
      if (this._recorder && (this._recorder.state === "recording" || this._recorder.state === "paused")) {
        this._recorder.stop();
      }
    } catch (_) {}

    this._recorder = null;
    this._stream = null;
    this._chunks = [];
    this._lastBlob = null;
  }

  // ---------- internals ----------

  _capture(videoElement) {
    try {
      if (videoElement.captureStream) return videoElement.captureStream();
      if (videoElement.mozCaptureStream) return videoElement.mozCaptureStream();
      console.error("[TSR] captureStream() not supported");
      return null;
    } catch (e) {
      console.error("[TSR] captureStream() failed:", e);
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

  _startRotationTimer() {
    this._stopRotationTimer();
    this._rotateTimer = setInterval(() => this._rotateSegment(), (this.maxSeconds + 1) * 1000);
  }

  _stopRotationTimer() {
    if (this._rotateTimer) {
      clearInterval(this._rotateTimer);
      this._rotateTimer = null;
    }
  }

  async _rotateSegment() {
    if (!this.running) return;
    if (!this._recorder) return;
    if (this._rotating) return;

    // Don't rotate while paused
    if (this.paused || this._recorder.state === "paused") return;

    this._rotating = true;

    try {
      // Stop current segment (onstop finalizes _lastBlob)
      this._recorder.stop();

      // Let onstop run before starting the next segment
      await new Promise((r) => setTimeout(r, 0));

      if (!this.running) return;

      this._startRecorder();
    } catch (e) {
      console.error("[TSR] rotateSegment failed:", e);
    } finally {
      this._rotating = false;
    }
  }

  _startRecorder() {
    if (!this._stream) return false;

    // Reset chunk list for this segment
    this._chunks = [];

    const mimeType = this._pickMimeType();
    const options = {};
    if (mimeType) options.mimeType = mimeType;
    options.videoBitsPerSecond = this.videoBitrate;

    let rec;
    try {
      rec = new MediaRecorder(this._stream, options);
    } catch (e) {
      console.error("[TSR] MediaRecorder init failed:", e);
      return false;
    }

    this._mimeType = rec.mimeType || mimeType || "video/webm";

    rec.ondataavailable = (evt) => {
      if (!this.running) return;
      if (evt?.data && evt.data.size > 0) this._chunks.push(evt.data);
    };

    rec.onerror = (evt) => {
      console.error("[TSR] MediaRecorder error:", evt?.error || evt);
    };

    rec.onstop = () => {
      // Finalize this segment as a standalone file
      try {
        const blob = new Blob(this._chunks, { type: this._mimeType || "video/webm" });
        if (blob.size > 0) this._lastBlob = blob;
      } catch (e) {
        console.error("[TSR] failed to finalize segment:", e);
      }
    };

    this._recorder = rec;

    try {
      rec.start(); // no timeslice -> one clean file per segment
      return true;
    } catch (e) {
      console.error("[TSR] MediaRecorder.start() failed:", e);
      this._recorder = null;
      return false;
    }
  }
}