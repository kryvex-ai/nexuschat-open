'use strict';

/**
 * Wraps Electron safeStorage for encrypting API keys / session tokens at rest.
 * Falls back to base64 obfuscation when no OS keyring is available
 * (e.g. headless Linux during tests) with a capability flag.
 */
function createSecureAdapter() {
  let safeStorage = null;
  try { safeStorage = require('electron').safeStorage; } catch { /* running outside electron (tests) */ }

  const available = (() => {
    try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
  })();

  return {
    available,
    encrypt(plain) {
      if (!plain) return '';
      if (available) return 'enc1:' + safeStorage.encryptString(String(plain)).toString('base64');
      return 'plain1:' + Buffer.from(String(plain), 'utf8').toString('base64');
    },
    decrypt(stored) {
      if (!stored) return '';
      if (stored.startsWith('enc1:')) {
        try { return safeStorage.decryptString(Buffer.from(stored.slice(5), 'base64')); } catch { return ''; }
      }
      if (stored.startsWith('plain1:')) return Buffer.from(stored.slice(7), 'base64').toString('utf8');
      return String(stored);
    }
  };
}

module.exports = { createSecureAdapter };
