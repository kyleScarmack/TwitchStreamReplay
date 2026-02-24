# Twitch Stream Replay
A Chrome extension that adds stream replay functionality to Twitch live streams. Press your configured keybind to replay the last few seconds in a floating window without interrupting the live stream.

As an avid esports viewer, I prefer Twitch’s chat experience over YouTube’s viewing experience. However, Twitch lacks a built-in live rewind feature. Rewatching a moment typically requires creating a clip or opening the VOD in a separate window, which causes viewers to miss ongoing live action. To address this limitation, I developed a floating replay window that plays on top of the stream without interrupting playback.

## Chrome Web Store Link

*(Add link once published)*

## Features
- **Instant replay on demand**
- **Customizable keybind trigger**
- **Adjustable replay duration**
- **Floating mini-player window**
- **Playback controls (play/pause/skip)**
- **Automatic volume reduction of live stream**
- **Draggable and resizable replay window**
- **Optional window position memory**
- **Ad detection to avoid recording ads**
- **Works entirely locally**

## Installation (Development)

1. Clone this repository
2. Open Chrome and navigate to: chrome://extensions/
3. Enable **Developer mode** (top right)
4. Click **Load unpacked**
5. Select the extension folder

## Usage

1. Navigate to any Twitch live stream
2. Wait a few seconds for initialization
3. Press your configured keybind (default: **Left Arrow ←**)
4. A replay window will appear showing the previous X seconds
5. Use controls to pause, play, or skip
6. Close the window using the **X button**

## Settings

The popup allows you to configure:

- Replay duration (seconds)
- Volume reduction during replay
- Key binding
- Auto-close behavior
- Remember window position

## Privacy

This extension runs entirely on your device. There is no need to collect personal data, transmit video or audio, or require login access.
