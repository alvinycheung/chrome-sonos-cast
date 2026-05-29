const http = require('http');
const WebSocket = require('ws');
const os = require('os');
const lamejs = require('lamejs');

const PORT = 3000;
const SONOS_IP = '192.168.1.78'; // Sonos Playbar IP found on network

let activeClients = [];
let totalBytesReceived = 0;
let sonosName = 'Sonos Playbar';

// MP3 Encoder setup (Stereo, 44.1kHz, 192kbps)
let mp3encoder = new lamejs.Mp3Encoder(2, 44100, 192);

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

// Create HTTP server to serve MP3 stream
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

  if (req.url === '/stream.mp3') {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Connection': 'keep-alive'
      });
      res.end();
      return;
    }
    
    // Serve live MP3 radio stream
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': 0
    });
    
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
  
  // Reinitialize the MP3 Encoder on new connection
  mp3encoder = new lamejs.Mp3Encoder(2, 44100, 192);
  
  // Trigger Sonos Playbar to stream our HTTP endpoint
  triggerSonosPlay().catch(err => {
    console.error('[Sonos] Failed to trigger Sonos playback:', err.message);
  });
  
  ws.on('message', (data) => {
    totalBytesReceived += data.length;
    
    // data is raw interleaved stereo 16-bit PCM (little-endian)
    const numSamples = data.length / 4;
    const left = new Int16Array(numSamples);
    const right = new Int16Array(numSamples);
    
    let idx = 0;
    for (let i = 0; i < data.length; i += 4) {
      left[idx] = data.readInt16LE(i);
      right[idx] = data.readInt16LE(i + 2);
      idx++;
    }
    
    // Encode PCM to MP3 chunk
    const mp3buf = mp3encoder.encodeBuffer(left, right);
    if (mp3buf.length > 0) {
      const mp3chunk = Buffer.from(mp3buf);
      activeClients.forEach(client => {
        client.write(mp3chunk);
      });
    }
  });
  
  ws.on('close', () => {
    console.log('[WS] Chrome extension disconnected. Stopping Sonos...');
    
    // Flush remaining MP3 bytes
    const mp3buf = mp3encoder.flush();
    if (mp3buf.length > 0) {
      const mp3chunk = Buffer.from(mp3buf);
      activeClients.forEach(client => {
        client.write(mp3chunk);
      });
    }
    
    activeClients.forEach(client => client.end());
    activeClients = [];
    
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
  // Use x-rincon-mp3radio:// scheme for live streaming compatibility
  const streamUrl = `x-rincon-mp3radio://${localIp}:${PORT}/stream.mp3`;
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
