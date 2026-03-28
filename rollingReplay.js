import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Output,
  WebMOutputFormat,
} from "./vendor/mediabunny.min.mjs";

export default class WebCodecsRingBuffer {
  constructor(maxSeconds = 30, videoBitrate = 4_000_000) {
    this.maxSeconds = Math.max(5, Number(maxSeconds) || 30);
    this.videoBitrate = Math.max(250_000, Number(videoBitrate) || 4_000_000);

    this.videoChunks = [];
    this.audioChunks = [];

    this.videoEncoder = null;
    this.audioEncoder = null;
    this.videoReader = null;
    this.audioReader = null;
    this.audioContext = null;

    this.videoWidth = 0;
    this.videoHeight = 0;
    this.sampleRate = 48_000;
    this.numberOfChannels = 2;

    this.firstVideoMeta = null;
    this.firstAudioMeta = null;

    this.running = false;
    this.paused = false;
    this.audioEncoderConfigured = false;
    this.startTime = 0;
    this.lastEncodedAt = 0;
  }

  async start(videoElement) {
    const stream = this._capture(videoElement);
    if (!stream) return false;

    const videoTrack = stream.getVideoTracks?.()[0];
    const audioTrack = stream.getAudioTracks?.()[0];

    if (!videoTrack) {
      console.warn("[TSR] No video track found in captureStream().");
      return false;
    }

    this.videoWidth = videoElement.videoWidth || 1280;
    this.videoHeight = videoElement.videoHeight || 720;
    this.running = true;
    this.paused = false;
    this.startTime = performance.now();
    this.lastEncodedAt = this.startTime;

    this.videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);

        if (!this.firstVideoMeta && meta?.decoderConfig) {
          this.firstVideoMeta = meta;
        }

        const timestamp =
          Number.isFinite(chunk.timestamp) ? chunk.timestamp : Math.round((performance.now() - this.startTime) * 1000);
        this.videoChunks.push({
          data: buf,
          timestamp,
          duration: chunk.duration || 33_333,
          isKey: chunk.type === "key",
        });
        this.lastEncodedAt = performance.now();
        this._trimVideo();
      },
      error: (e) => console.error("[TSR] VideoEncoder error:", e),
    });

    this.videoEncoder.configure({
      codec: "vp8",
      width: this.videoWidth,
      height: this.videoHeight,
      bitrate: this.videoBitrate,
      framerate: 30,
    });

    if (audioTrack) {
      this.audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          const buf = new Uint8Array(chunk.byteLength);
          chunk.copyTo(buf);

          if (!this.firstAudioMeta && meta?.decoderConfig) {
            this.firstAudioMeta = meta;
          }

          const timestamp =
            Number.isFinite(chunk.timestamp) ? chunk.timestamp : Math.round((performance.now() - this.startTime) * 1000);
          this.audioChunks.push({
            data: buf,
            timestamp,
            duration: chunk.duration || 20_000,
            isKey: chunk.type === "key",
          });
          this.lastEncodedAt = performance.now();
          this._trimAudio();
        },
        error: (e) => console.error("[TSR] AudioEncoder error:", e),
      });

      try {
        this.audioContext = new AudioContext({ sampleRate: 48_000 });
        const source = this.audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
        const gainNode = this.audioContext.createGain();
        gainNode.channelCount = 2;
        gainNode.channelCountMode = "explicit";
        gainNode.channelInterpretation = "speakers";
        source.connect(gainNode);
        const dest = this.audioContext.createMediaStreamDestination();
        gainNode.connect(dest);

        const stereoTrack = dest.stream.getAudioTracks?.()[0];
        if (stereoTrack) {
          const audioProcessor = new MediaStreamTrackProcessor({ track: stereoTrack });
          this.audioReader = audioProcessor.readable.getReader();
          this._processAudioFrames();
        }
      } catch (e) {
        console.warn("[TSR] Audio processing unavailable; replay will be video-only.", e);
        this.audioEncoder = null;
      }
    }

    const videoProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
    this.videoReader = videoProcessor.readable.getReader();
    this._processVideoFrames();

    return true;
  }

  hasData() {
    return this.videoChunks.length > 0;
  }

  isLikelyStale(maxStallMs = 5000) {
    if (!this.running || this.paused) return false;
    if (!this.lastEncodedAt) return false;
    return performance.now() - this.lastEncodedAt > maxStallMs;
  }

  getBufferedDurationSeconds() {
    if (this.videoChunks.length < 2) return 0;
    const first = this.videoChunks[0].timestamp;
    const last = this.videoChunks[this.videoChunks.length - 1].timestamp;
    return Math.max(0, (last - first) / 1_000_000);
  }

  async getReplay() {
    const blob = await this.getReplayBlob();
    if (!blob) return null;

    const durationSeconds = this._estimateReplayDurationSeconds();
    return {
      blob,
      mimeType: "video/webm",
      durationSeconds,
    };
  }

  async getReplayBlob() {
    if (this.videoChunks.length === 0) {
      console.warn("[TSR] No video data available for replay.");
      return null;
    }

    try {
      if (this.videoEncoder?.state === "configured") {
        await this.videoEncoder.flush();
      }
      if (this.audioEncoder?.state === "configured") {
        await this.audioEncoder.flush();
      }
    } catch (e) {
      console.warn("[TSR] Encoder flush failed before mux.", e);
    }

    const latestTimestamp = this.videoChunks[this.videoChunks.length - 1].timestamp;
    const cutoff = latestTimestamp - this.maxSeconds * 1_000_000;

    let startIdx = this.videoChunks.findIndex((chunk) => chunk.isKey && chunk.timestamp >= cutoff);
    if (startIdx < 0) {
      startIdx = this.videoChunks.findIndex((chunk) => chunk.isKey);
    }
    if (startIdx < 0) {
      console.warn("[TSR] No keyframe found in replay buffer.");
      return null;
    }

    const videoSlice = this.videoChunks.slice(startIdx);
    if (videoSlice.length === 0) return null;

    const baseTimestamp = videoSlice[0].timestamp;
    const endTimestamp = videoSlice[videoSlice.length - 1].timestamp;

    const audioSlice = this.audioChunks.filter(
      (chunk) => chunk.timestamp >= baseTimestamp && chunk.timestamp <= endTimestamp
    );

    try {
      const videoSource = new EncodedVideoPacketSource("vp8");
      const audioSource = audioSlice.length > 0 ? new EncodedAudioPacketSource("opus") : null;
      const target = new BufferTarget();
      const output = new Output({
        format: new WebMOutputFormat(),
        target,
      });

      output.addVideoTrack(videoSource, { frameRate: 30 });
      if (audioSource) output.addAudioTrack(audioSource);

      await output.start();

      for (let i = 0; i < videoSlice.length; i += 1) {
        const chunk = videoSlice[i];
        const packet = new EncodedPacket(
          chunk.data,
          chunk.isKey ? "key" : "delta",
          (chunk.timestamp - baseTimestamp) / 1_000_000,
          Math.max(0.001, (chunk.duration || 33_333) / 1_000_000)
        );
        const meta = i === 0 ? this.firstVideoMeta : undefined;
        await videoSource.add(packet, meta);
      }

      if (audioSource) {
        for (let i = 0; i < audioSlice.length; i += 1) {
          const chunk = audioSlice[i];
          const packet = new EncodedPacket(
            chunk.data,
            chunk.isKey ? "key" : "delta",
            (chunk.timestamp - baseTimestamp) / 1_000_000,
            Math.max(0.001, (chunk.duration || 20_000) / 1_000_000)
          );
          const meta = i === 0 ? this.firstAudioMeta : undefined;
          await audioSource.add(packet, meta);
        }
      }

      await output.finalize();
      return new Blob([target.buffer], { type: "video/webm" });
    } catch (e) {
      console.error("[TSR] Error creating replay blob:", e);
      return null;
    }
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.lastEncodedAt = performance.now();
  }

  stop() {
    this.running = false;
    this.paused = false;

    try {
      this.videoReader?.cancel();
    } catch (_) {}
    try {
      this.audioReader?.cancel();
    } catch (_) {}
    try {
      if (this.videoEncoder?.state !== "closed") this.videoEncoder.close();
    } catch (_) {}
    try {
      if (this.audioEncoder?.state !== "closed") this.audioEncoder.close();
    } catch (_) {}
    try {
      this.audioContext?.close();
    } catch (_) {}

    this.videoChunks = [];
    this.audioChunks = [];
    this.videoEncoder = null;
    this.audioEncoder = null;
    this.videoReader = null;
    this.audioReader = null;
    this.audioContext = null;
    this.firstVideoMeta = null;
    this.firstAudioMeta = null;
    this.audioEncoderConfigured = false;
    this.lastEncodedAt = 0;
  }

  _capture(videoElement) {
    try {
      if (videoElement.captureStream) return videoElement.captureStream();
      if (videoElement.mozCaptureStream) return videoElement.mozCaptureStream();
    } catch (e) {
      console.warn("[TSR] captureStream() failed.", e);
    }
    console.warn("[TSR] captureStream() not supported.");
    return null;
  }


  async _processVideoFrames() {
    let frameCount = 0;

    while (this.running && this.videoReader) {
      try {
        const { value: frame, done } = await this.videoReader.read();
        if (done || !frame) break;

        if (this.paused) {
          frame.close();
          continue;
        }

        const keyFrame = frameCount % 30 === 0;
        this.videoEncoder.encode(frame, { keyFrame });
        frame.close();
        frameCount += 1;
      } catch (e) {
        if (this.running) {
          console.error("[TSR] Error processing video frame:", e);
        }
        break;
      }
    }
  }

  async _processAudioFrames() {
    while (this.running && this.audioReader && this.audioEncoder) {
      try {
        const { value: audioData, done } = await this.audioReader.read();
        if (done || !audioData) break;

        if (this.paused) {
          audioData.close();
          continue;
        }

        if (!this.audioEncoderConfigured) {
          this.sampleRate = audioData.sampleRate;
          this.numberOfChannels = Math.min(2, audioData.numberOfChannels || 2);

          this.audioEncoder.configure({
            codec: "opus",
            sampleRate: this.sampleRate,
            numberOfChannels: this.numberOfChannels,
            bitrate: 160_000,
          });
          this.audioEncoderConfigured = true;
        }

        this.audioEncoder.encode(audioData);
        audioData.close();
      } catch (e) {
        if (this.running) {
          console.error("[TSR] Error processing audio frame:", e);
        }
        break;
      }
    }
  }

  _trimVideo() {
    if (this.videoChunks.length === 0) return;

    const newest = this.videoChunks[this.videoChunks.length - 1].timestamp;
    const cutoff = newest - this.maxSeconds * 1_000_000;
    let trimIndex = 0;

    for (let i = 0; i < this.videoChunks.length; i += 1) {
      if (this.videoChunks[i].timestamp < cutoff && this.videoChunks[i].isKey) {
        trimIndex = i;
      }
    }

    if (trimIndex > 0) {
      this.videoChunks.splice(0, trimIndex);
    }
  }

  _trimAudio() {
    if (this.audioChunks.length === 0) return;

    const newest = this.audioChunks[this.audioChunks.length - 1].timestamp;
    const cutoff = newest - this.maxSeconds * 1_000_000;
    let trimIndex = 0;

    for (let i = 0; i < this.audioChunks.length; i += 1) {
      if (this.audioChunks[i].timestamp < cutoff) {
        trimIndex = i;
      }
    }

    if (trimIndex > 0) {
      this.audioChunks.splice(0, trimIndex);
    }
  }

  _estimateReplayDurationSeconds() {
    if (this.videoChunks.length < 2) return 0;
    const latestTimestamp = this.videoChunks[this.videoChunks.length - 1].timestamp;
    const cutoff = latestTimestamp - this.maxSeconds * 1_000_000;
    const startChunk =
      this.videoChunks.find((chunk) => chunk.isKey && chunk.timestamp >= cutoff) ||
      this.videoChunks.find((chunk) => chunk.isKey) ||
      this.videoChunks[0];

    return Math.max(0.05, (latestTimestamp - startChunk.timestamp) / 1_000_000);
  }
}
