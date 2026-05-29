let audioContext = null;
let ws = null;
let mediaStream = null;

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
  const source = audioContext.createMediaStreamSource(mediaStream);

  // Play audio locally so user can still hear it in their browser
  source.connect(audioContext.destination);

  // Create ScriptProcessor to capture audio samples (2 channels for stereo)
  const processor = audioContext.createScriptProcessor(4096, 2, 2);
  source.connect(processor);
  processor.connect(audioContext.destination);

  processor.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const left = e.inputBuffer.getChannelData(0);
    const right = e.inputBuffer.getChannelData(1);
    
    // Interleave left and right channels to stereo 16-bit PCM (WAV standard payload)
    const length = left.length;
    const buffer = new ArrayBuffer(length * 4); // 2 channels, 2 bytes per sample
    const view = new DataView(buffer);
    
    let offset = 0;
    for (let i = 0; i < length; i++) {
      // Left channel
      let lSample = Math.max(-1, Math.min(1, left[i]));
      view.setInt16(offset, lSample < 0 ? lSample * 0x8000 : lSample * 0x7FFF, true);
      offset += 2;
      
      // Right channel
      let rSample = Math.max(-1, Math.min(1, right[i]));
      view.setInt16(offset, rSample < 0 ? rSample * 0x8000 : rSample * 0x7FFF, true);
      offset += 2;
    }
    
    ws.send(buffer);
  };
}

// Clean up when window/document is destroyed
window.addEventListener('unload', () => {
  if (ws) {
    ws.close();
  }
  if (audioContext) {
    audioContext.close();
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
  }
});
