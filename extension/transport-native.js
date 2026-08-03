'use strict';

// BrowserBuddy native-messaging transport.
//
// Loaded as a plain script: Chrome's service worker pulls it in with
// importScripts() from background.js, Firefox lists it ahead of background.js
// in manifest background.scripts. Either way it shares one global scope with
// background.js, so it must not redeclare anything background.js declares
// (notably `ext`, which it reaches lazily inside functions).
//
// The extension is the CLIENT of a pipe the BROWSER owns: connectNative makes
// the browser spawn the host process and hand us a Port to its stdio. No
// socket is bound on this side, and there is no fallback wire -- if the host
// cannot be spawned, that is a hard, reported error.

const BB_NATIVE_HOST_NAME = 'com.browserbuddy.host';

const BBNativeTransport = (function () {
  let port = null;
  let open = false;
  let handlers = {};

  function nativeApi() {
    // background.js owns the `ext` binding; read it at call time so load order
    // between the two scripts does not matter.
    return typeof browser !== 'undefined' ? browser : chrome;
  }

  function missingHostMessage(detail) {
    return (
      'BrowserBuddy could not start its native messaging host "' +
      BB_NATIVE_HOST_NAME +
      '". ' +
      detail +
      ' Install the host manifest so the browser can find it:\n' +
      '  Chrome/Chromium: <user-data-dir>/NativeMessagingHosts/' +
      BB_NATIVE_HOST_NAME +
      '.json ' +
      '(the default user-data-dir is ~/.config/chromium or ~/.config/google-chrome on Linux)\n' +
      '  Firefox: ~/.mozilla/native-messaging-hosts/' +
      BB_NATIVE_HOST_NAME +
      '.json\n' +
      'Run: browserbuddy install-host --browser <chrome|firefox>\n' +
      '(from a checkout: node scripts/install-native-host.mjs --browser <chrome|firefox> ...)\n' +
      'The manifest must list this extension in allowed_origins (Chrome) or ' +
      'allowed_extensions (Firefox), and its "path" must be an executable launcher.'
    );
  }

  return {
    hostName: BB_NATIVE_HOST_NAME,

    isOpen: function () {
      return open;
    },

    /**
     * Asks the browser to spawn the host and attaches the handlers. Returns
     * true when the Port was created; a host that fails to launch surfaces
     * later through onDisconnect, which is the only signal the browser gives.
     *
     * Two failure shapes, deliberately kept apart:
     *   - onSpawnFailure(message): connectNative threw, or the port died
     *     without the host ever answering. That is almost always a missing or
     *     wrong host manifest, so it gets the long actionable text.
     *   - onClose(detail): the pipe closed after the host had been talking --
     *     a browser shutdown, a service-worker teardown, a host crash. Routine;
     *     it must not shout "install the manifest" at the user.
     */
    connect: function (h) {
      handlers = h || {};
      if (port !== null) return true;

      const api = nativeApi();
      let p;
      try {
        p = api.runtime.connectNative(BB_NATIVE_HOST_NAME);
      } catch (e) {
        open = false;
        if (handlers.onSpawnFailure) {
          handlers.onSpawnFailure(
            missingHostMessage('connectNative threw: ' + (e && e.message ? e.message : String(e)) + '.')
          );
        }
        return false;
      }

      port = p;
      open = true;
      // Proof the host came up: the browser reports a failed spawn only as a
      // disconnect, so "did it ever speak" is the only signal that separates a
      // never-started host from one that later went away.
      let hostSpoke = false;

      p.onMessage.addListener(function (msg) {
        hostSpoke = true;
        if (handlers.onMessage) handlers.onMessage(msg);
      });

      p.onDisconnect.addListener(function () {
        const api2 = nativeApi();
        const err = api2.runtime.lastError || (p.error ? p.error : null);
        const detail = err && err.message ? err.message : 'The host exited or the pipe was closed.';
        port = null;
        open = false;
        if (!hostSpoke && handlers.onSpawnFailure) {
          handlers.onSpawnFailure(missingHostMessage('The browser reported: ' + detail + '.'));
        }
        if (handlers.onClose) handlers.onClose(detail);
      });

      if (handlers.onOpen) handlers.onOpen();
      return true;
    },

    send: function (obj) {
      if (!open || port === null) return false;
      try {
        port.postMessage(obj);
        return true;
      } catch (e) {
        // postMessage after the host died throws; treat it as a closed pipe.
        open = false;
        port = null;
        if (handlers.onClose) handlers.onClose(e && e.message ? e.message : String(e));
        return false;
      }
    },

    disconnect: function () {
      if (port !== null) {
        try {
          port.disconnect();
        } catch (e) {
          /* already gone */
        }
      }
      port = null;
      open = false;
    }
  };
})();
