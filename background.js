let isCasting = false;
let castingTabId = null;
let castingTabTitle = '';

// Listen for messages from popup or offscreen
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'get-status') {
    sendResponse({ isCasting, tabTitle: castingTabTitle });
  } 
  
  else if (message.type === 'start-cast') {
    startCast().then(result => {
      sendResponse(result);
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // Keep message channel open for async response
  } 
  
  else if (message.type === 'stop-cast') {
    stopCast().then(() => {
      sendResponse({ success: true });
    });
    return true;
  }
  
  else if (message.type === 'offscreen-disconnected') {
    isCasting = false;
    castingTabId = null;
    castingTabTitle = '';
    console.log('Offscreen document disconnected');
  }
});

async function startCast() {
  // Get active tab in current window
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || tabs.length === 0) {
    throw new Error('No active tab found');
  }
  const activeTab = tabs[0];
  castingTabId = activeTab.id;
  castingTabTitle = activeTab.title;

  // Create offscreen document
  await setupOffscreenDocument('offscreen.html');

  // Get tab audio stream ID
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: castingTabId });
  
  // Send the ID to the offscreen document to initiate audio capturing
  // Adding delay to allow offscreen document to load and establish listener
  setTimeout(async () => {
    try {
      await chrome.runtime.sendMessage({
        type: 'initiate-capture',
        target: 'offscreen',
        streamId: streamId
      });
    } catch (e) {
      console.error('Failed to send message to offscreen document:', e);
    }
  }, 300);

  isCasting = true;
  return { success: true, tabTitle: castingTabTitle };
}

async function stopCast() {
  isCasting = false;
  castingTabId = null;
  castingTabTitle = '';
  
  // Close the offscreen document
  try {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
  } catch (e) {
    console.error(e);
  }
}

async function setupOffscreenDocument(path) {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: path,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Capture and transmit tab audio to local server',
    });
  }
}
