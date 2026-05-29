const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const statusText = document.getElementById('status');
const glow = document.getElementById('glow');

// Check current state from background service worker
chrome.runtime.sendMessage({ type: 'get-status' }, (response) => {
  if (response && response.isCasting) {
    showCastingState(response.tabTitle);
  }
});

startBtn.addEventListener('click', async () => {
  statusText.textContent = 'Requesting stream...';
  // Send message to background to start
  chrome.runtime.sendMessage({ type: 'start-cast' }, (response) => {
    if (response && response.success) {
      showCastingState(response.tabTitle);
    } else {
      statusText.textContent = 'Failed: ' + (response ? response.error : 'Unknown error');
      statusText.style.color = '#FF4D4D';
    }
  });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'stop-cast' }, () => {
    showIdleState();
  });
});

function showCastingState(tabTitle) {
  statusText.textContent = 'Casting: ' + (tabTitle ? (tabTitle.length > 25 ? tabTitle.substring(0, 22) + '...' : tabTitle) : 'Active Tab');
  statusText.style.color = '#00E676';
  glow.style.background = '#00E676';
  glow.style.boxShadow = '0 0 10px #00E676';
  glow.style.animationPlayState = 'running';
  startBtn.style.display = 'none';
  stopBtn.style.display = 'flex';
}

function showIdleState() {
  statusText.textContent = 'Idle';
  statusText.style.color = '#9A9DAF';
  glow.style.background = '#626575';
  glow.style.boxShadow = 'none';
  glow.style.animationPlayState = 'paused';
  startBtn.style.display = 'flex';
  stopBtn.style.display = 'none';
}
