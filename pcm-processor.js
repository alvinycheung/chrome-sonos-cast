class PCMProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    
    const left = input[0];
    const right = input[1] || left; // Fallback to mono if only 1 channel
    const length = left.length;
    
    // Interleave left and right channels to stereo 16-bit PCM (WAV payload)
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
    
    // Send the interleaved PCM buffer back to offscreen.js
    this.port.postMessage(buffer, [buffer]);
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
