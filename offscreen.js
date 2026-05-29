let audioContext = null;
let ws = null;
let mediaStream = null;
let workletNode = null;

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.target !== 'offscreen') return;

  if (message.type === 'initiate-capture') {
    try {
      await startCapture(message.streamId);
    } catch (e) {
      console.error('Offscreen capture error:', e);
    }
  }
});

async function startCapture(streamId) {
  // Capture the audio stream using streamId
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    }
  });

  // Create websocket connection to local node server
  ws = new WebSocket('ws://localhost:3000');
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    console.log('WS Connection established with local streaming server');
  };

  ws.onclose = () => {
    console.log('WS Connection closed');
    chrome.runtime.sendMessage({ type: 'offscreen-disconnected' });
  };

  ws.onerror = (err) => {
    console.error('WS Error:', err);
  };

  // Set up AudioContext to decode and stream PCM
  audioContext = new AudioContext({ sampleRate: 44100 });

  // Explicitly resume the AudioContext to prevent it from starting in suspended state
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
    console.log('Resumed AudioContext in offscreen document. State is:', audioContext.state);
  }

  // Load the AudioWorklet processor module
  await audioContext.audioWorklet.addModule('pcm-processor.js');

  const source = audioContext.createMediaStreamSource(mediaStream);

  // Create a silent gain node to keep the audio graph processing without playing out of Mac speakers
  const silentGain = audioContext.createGain();
  silentGain.gain.setValueAtTime(0, audioContext.currentTime);
  silentGain.connect(audioContext.destination);

  // Create AudioWorkletNode to capture audio samples (2 channels for stereo)
  workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
  source.connect(workletNode);
  workletNode.connect(silentGain);

  workletNode.port.onmessage = (event) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(event.data);
    }
  };
}

// Clean up when window/document is destroyed
window.addEventListener('unload', () => {
  if (ws) {
    ws.close();
  }
  if (workletNode) {
    workletNode.disconnect();
  }
  if (audioContext) {
    audioContext.close();
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
  }
});
