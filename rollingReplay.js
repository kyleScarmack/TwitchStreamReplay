// rollingReplay.js
//
// Records in 1-second timeslice chunks into a rolling window.
// On trigger: stops the recorder, slices the window to maxSeconds,
// builds one clean WebM blob, then restarts recording immediately.

export default class SegmentRotatingReplayBuffer {
  constructor(maxSeconds = 30, videoBitrate = 2_500_000) {
    this.maxSeconds = Number(maxSeconds) || 30;
    this.videoBitrate = Number(videoBitrate) || 2_500_000;

    this.running = false;
    this.paused = false;

    this._stream = null;
    this._recorder = null;
    this._mimeType = "";

    // Rolling window: each entry is { blob: Blob, duration: number (ms) }
    this._window = [];
    this._windowMs = 0;
  }

  async start(videoElement) {
    if (!videoElement) return false;

    const stream = this._capture(videoElement);
    if (!stream) return false;

    this._stream = stream;
    this.running = true;
    this.paused = false;

    return this._startRecorder();
  }

  hasData() {
    return this._window.length > 1; // need at least header + one data chunk
  }

  async getReplayBlob() {
    if (!this.running) return null;

    // Flush whatever is currently buffered in the recorder right now
    const flushedChunks = await this._flushAndRestart();

    // Combine window blobs + flushed chunks into one continuous WebM
    const allChunks = [
      ...this._window.map(e => e.blob),
      ...flushedChunks,
    ];

    if (allChunks.length === 0) return null;

    return new Blob(allChunks, { type: this._mimeType || "video/webm" });
  }

  pause() {
    this.paused = true;
    try {
      if (this._recorder?.state === "recording") this._recorder.pause();
    } catch (_) {}
  }

  resume() {
    this.paused = false;
    try {
      if (this._recorder?.state === "paused") this._recorder.resume();
    } catch (_) {}
  }

  stop() {
    this.running = false;
    this.paused = false;
    try {
      if (this._recorder && this._recorder.state !== "inactive") this._recorder.stop();
    } catch (_) {}
    this._recorder = null;
    this._stream = null;
    this._window = [];
    this._windowMs = 0;
  }

  // ---------- internals ----------

  _capture(videoElement) {
    try {
      if (videoElement.captureStream) return videoElement.captureStream();
      if (videoElement.mozCaptureStream) return videoElement.mozCaptureStream();
      console.warn("[TSR] captureStream() not supported.");
      return null;
    } catch (e) {
      console.warn("[TSR] captureStream() failed.", e);
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
      if (MediaRecorder.isTypeSupported?.(mt)) return mt;
    }
    return "";
  }

  _startRecorder() {
    if (!this._stream) return false;

    const mimeType = this._pickMimeType();
    const options = { videoBitsPerSecond: this.videoBitrate };
    if (mimeType) options.mimeType = mimeType;

    let rec;
    try {
      rec = new MediaRecorder(this._stream, options);
    } catch (e) {
      console.warn("[TSR] MediaRecorder could not be created.", e);
      return false;
    }

    this._mimeType = rec.mimeType || mimeType || "video/webm";
    let isFirstChunk = true;

    rec.ondataavailable = (evt) => {
      if (!this.running || !evt?.data || evt.data.size === 0) return;

      const chunkMs = 1000;
      this._window.push({ blob: evt.data, duration: isFirstChunk ? 0 : chunkMs });
      if (!isFirstChunk) this._windowMs += chunkMs;
      isFirstChunk = false;

      // Trim window to maxSeconds — always keep index 0 (WebM header chunk)
      const maxMs = this.maxSeconds * 1000;
      while (this._window.length > 2 && this._windowMs - this._window[1].duration > maxMs) {
        this._windowMs -= this._window[1].duration;
        this._window.splice(1, 1);
      }
    };

    rec.onerror = (evt) => {
      console.warn("[TSR] MediaRecorder error.", evt?.error || evt);
    };

    this._recorder = rec;

    try {
      rec.start(1000); // deliver a chunk every 1 second
      return true;
    } catch (e) {
      console.warn("[TSR] MediaRecorder.start() failed.", e);
      this._recorder = null;
      return false;
    }
  }

  // Stop current recorder, collect any last chunks it was holding, restart immediately.
  _flushAndRestart() {
    return new Promise((resolve) => {
      const rec = this._recorder;
      if (!rec || rec.state === "inactive") {
        resolve([]);
        return;
      }

      const finalChunks = [];
      const origOnData = rec.ondataavailable;

      rec.ondataavailable = (evt) => {
        origOnData?.call(rec, evt); // still feed the rolling window
        if (evt?.data && evt.data.size > 0) finalChunks.push(evt.data);
      };

      rec.addEventListener("stop", () => {
        if (this.running && !this.paused) this._startRecorder();
        resolve(finalChunks);
      }, { once: true });

      try {
        rec.stop();
      } catch (e) {
        resolve([]);
      }
    });
  }
}
