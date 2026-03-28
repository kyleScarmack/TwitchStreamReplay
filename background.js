// Runs when extension is installed or updated
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Twitch Stream Replay installed');
    
    // Set default user settings
    chrome.storage.sync.set({
      replayDuration: 30,
      keyBinding: 'ArrowLeft',
      volumeReduction: 0.3,
      autoCloseReplay: true
    });
    
    // Open Twitch on first install
    chrome.tabs.create({
      url: 'https://www.twitch.tv'
    });
  } else if (details.reason === 'update') {
    console.log('Twitch Stream Replay updated to version', chrome.runtime.getManifest().version);
  }
});

// Responds to requests from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_SETTINGS') {
    chrome.storage.sync.get(null, (settings) => {
      sendResponse({ settings });
    });
    return true; // Keep message channel open for async response
  }
});

// Extension icon click (popup opens automatically)
chrome.action.onClicked.addListener((tab) => {});

console.log('Twitch Stream Replay background worker loaded');
