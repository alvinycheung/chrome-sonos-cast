const http = require('http');
const WebSocket = require('ws');
const os = require('os');

const PORT = 3000;
const SONOS_IP = '192.168.1.78'; // Sonos Playbar IP found on network

let activeClients = [];
let totalBytesReceived = 0;
let sonosName = 'Sonos Playbar';

// Fetch Sonos room/friendly name on startup
function fetchSonosName() {
  const req = http.request(`http://${SONOS_IP}:1400/xml/device_description.xml`, { method: 'GET', timeout: 3000 }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      const match = data.match(/<roomName>(.*?)<\/roomName>/) || data.match(/<friendlyName>(.*?)<\/friendlyName>/);
      if (match && match[1]) {
        sonosName = match[1].replace(/Media\s*Renderer|Media\s*Server/gi, '').replace(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\s*-\s*/, '').trim();
        console.log(`[Sonos] Resolved device name: ${sonosName}`);
      }
    });
  });
  req.on('error', (e) => console.log(`[Sonos] Could not resolve device name: ${e.message}. Defaulting to 'Sonos Playbar'.`));
  req.end();
}
fetchSonosName();

// Periodically print throughput stats to verify streaming is active
setInterval(() => {
  if (totalBytesReceived > 0) {
    const kb = (totalBytesReceived / 1024).toFixed(1);
    console.log(`[Stream Stats] Received ${kb} KB from Chrome, active Sonos listeners: ${activeClients.length}`);
    totalBytesReceived = 0; // Reset
  }
}, 5000);

// Helper to get local IP address
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        if (net.address.startsWith('192.168.')) {
          return net.address;
        }
      }
    }
  }
  return 'localhost';
}

const localIp = getLocalIpAddress();
console.log(`Detected Mac IP: ${localIp}`);

// Create HTTP server to serve WAV stream
const server = http.createServer((req, res) => {
  console.log(`[HTTP] Request: ${req.method} ${req.url}`);
  
  if (req.url === '/status') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      sonosIp: SONOS_IP,
      sonosName: sonosName,
      streamingActive: activeClients.length > 0
    }));
    return;
  }

  if (req.url === '/stream.wav') {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Type': 'audio/x-wav',
        'Transfer-Encoding': 'chunked',
        'Connection': 'keep-alive'
      });
      res.end();
      return;
    }
    
    // Serve live WAV stream
    res.writeHead(200, {
      'Content-Type': 'audio/x-wav',
      'Transfer-Encoding': 'chunked',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': 0
    });
    
    // Write 44-byte WAV header for CD-quality stereo audio (44.1kHz, 16-bit)
    // We set ChunkSize and Subchunk2Size to 0xFFFFFFFF for infinite stream length
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(0xFFFFFFFF, 4); // ChunkSize
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // Subchunk1Size
    header.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
    header.writeUInt16LE(2, 22); // NumChannels (2 = Stereo)
    header.writeUInt32LE(44100, 24); // SampleRate (44.1kHz)
    header.writeUInt32LE(44100 * 2 * 2, 28); // ByteRate
    header.writeUInt16LE(4, 32); // BlockAlign
    header.writeUInt16LE(16, 34); // BitsPerSample
    header.write('data', 36);
    header.writeUInt32LE(0xFFFFFFFF, 40); // Subchunk2Size
    
    res.write(header);
    
    activeClients.push(res);
    console.log(`[HTTP] Sonos speaker connected to stream. Active listeners: ${activeClients.length}`);
    
    req.on('close', () => {
      activeClients = activeClients.filter(c => c !== res);
      console.log(`[HTTP] Sonos speaker disconnected. Active listeners: ${activeClients.length}`);
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// Create WebSocket server attached to HTTP server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('[WS] Chrome extension connected. Streaming audio to server...');
  
  // Trigger Sonos Playbar to stream our HTTP endpoint
  triggerSonosPlay().catch(err => {
    console.error('[Sonos] Failed to trigger Sonos playback:', err.message);
  });
  
  ws.on('message', (data) => {
    totalBytesReceived += data.length;
    // Forward the binary audio chunks to Sonos client connections
    activeClients.forEach(client => {
      client.write(data);
    });
  });
  
  ws.on('close', () => {
    console.log('[WS] Chrome extension disconnected. Stopping Sonos...');
    triggerSonosStop().catch(err => {
      console.error('[Sonos] Failed to stop Sonos playback:', err.message);
    });
  });
});

// SOAP commands to control Sonos via UPnP
function sendSonosSoap(action, body) {
  return new Promise((resolve, reject) => {
    const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    ${body}
  </s:Body>
</s:Envelope>`;

    const req = http.request({
      hostname: SONOS_IP,
      port: 1400,
      path: '/MediaRenderer/AVTransport/Control',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPACTION': `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`,
        'Content-Length': Buffer.byteLength(soapEnvelope)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.write(soapEnvelope);
    req.end();
  });
}

async function triggerSonosPlay() {
  const streamUrl = `http://${localIp}:${PORT}/stream.wav`;
  console.log(`[Sonos] Setting Sonos transport URI to: ${streamUrl}`);
  
  const setUriXml = `<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
    <InstanceID>0</InstanceID>
    <CurrentURI>${streamUrl}</CurrentURI>
    <CurrentURIMetaData></CurrentURIMetaData>
  </u:SetAVTransportURI>`;
  
  const playXml = `<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
    <InstanceID>0</InstanceID>
    <Speed>1</Speed>
  </u:Play>`;
  
  await sendSonosSoap('SetAVTransportURI', setUriXml);
  // Wait a short moment for Sonos to configure the URI, then send Play command
  setTimeout(async () => {
    try {
      console.log('[Sonos] Sending Play command...');
      await sendSonosSoap('Play', playXml);
    } catch (e) {
      console.error('[Sonos] Play command failed:', e.message);
    }
  }, 1000);
}

async function triggerSonosStop() {
  console.log('[Sonos] Stopping playback...');
  const stopXml = `<u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
    <InstanceID>0</InstanceID>
  </u:Stop>`;
  try {
    await sendSonosSoap('Stop', stopXml);
  } catch (e) {
    console.error('[Sonos] Stop command failed:', e.message);
  }
}

server.listen(PORT, () => {
  console.log(`\n=============================================================`);
  console.log(`Local Sonos Streaming Server running at http://${localIp}:${PORT}/`);
  console.log(`Sonos Playbar Target IP: ${SONOS_IP}`);
  console.log(`=============================================================\n`);
});
