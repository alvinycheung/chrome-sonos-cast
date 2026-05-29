# Local Sonos Cast

Cast Chrome tab audio to your local Sonos Playbar in high-quality stereo (CD quality: 44.1kHz, 16-bit PCM) for free, with no paywalls or external servers.

## Components

1. **Chrome Extension (Manifest V3)**: Uses the `tabCapture` API and an offscreen document to capture the audio of the active tab, interleave it into stereo 16-bit PCM, and stream it over WebSockets to the local server.
2. **Node.js Local Server**: Receives the raw audio stream via WebSockets, wraps it in a chunked WAV container, and plays it back to Sonos using UPnP SOAP API calls (`SetAVTransportURI` and `Play`).

## Quick Setup

### Step 1: Load the Chrome Extension
1. Open Google Chrome.
2. Go to `chrome://extensions/`.
3. Toggle **Developer mode** to **ON** in the top right.
4. Click **Load unpacked** in the top-left and select this folder.

### Step 2: Start the Local Server
1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the server:
   ```bash
   node server.js
   ```

3. Click the extension icon in Chrome and click **Cast This Tab**.
