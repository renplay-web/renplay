(function () {
  'use strict';

  var LS_KEY = '/home/web_user/.renpy';
  var SAVE_ENTRY = '__localstorage__';
  var POLL_MS = 10000;
  var gameSlug = null;
  var lastHash = null;
  var running = false;

  function getGameSlug() {
    var m = window.location.pathname.match(/\/play\/([^/]+)/);
    return m ? m[1] : null;
  }

  function getFS() {
    return window.FS || (window.Module && window.Module.FS) || null;
  }

  function readFSTree(FS, base) {
    if (!FS.analyzePath(base).exists) return null;
    var map = {};
    function walk(dir) {
      var names = FS.readdir(dir);
      for (var i = 0; i < names.length; i++) {
        var n = names[i];
        if (n === '.' || n === '..' || n === 'sync') continue;
        var p = dir + '/' + n;
        var st = FS.stat(p);
        if (FS.isDir(st.mode)) {
          walk(p);
        } else if (FS.isFile(st.mode)) {
          map[p.substring(base.length + 1)] = FS.readFile(p);
        }
      }
    }
    walk(base);
    return Object.keys(map).length ? map : null;
  }

  function uint8ToB64(arr) {
    var binary = '';
    for (var i = 0; i < arr.length; i++) {
      binary += String.fromCharCode(arr[i]);
    }
    return btoa(binary);
  }

  function b64ToBytes(b64) {
    var binary = atob(b64);
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function utf8ToB64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  function b64ToUtf8(b64) {
    return decodeURIComponent(escape(atob(b64)));
  }

  function getSaveFiles() {
    var FS = getFS();
    if (FS) {
      try {
        var tree = readFSTree(FS, LS_KEY);
        if (tree) return tree;
      } catch (e) {}
    }
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) return {};
    } catch (e) {}
    return null;
  }

  function buildEntries(files) {
    var entries = [];
    for (var name in files) {
      if (!files.hasOwnProperty(name)) continue;
      var content = files[name];
      var b64;
      if (typeof content === 'string') {
        b64 = utf8ToB64(content);
        if (name !== SAVE_ENTRY) {
          entries.push({ name: name, data: b64 });
        }
      } else {
        b64 = uint8ToB64(content);
        entries.push({ name: name, data: b64 });
      }
    }
    return entries;
  }

  function downloadSaves() {
    if (!gameSlug) return;
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/saves/' + encodeURIComponent(gameSlug), true);
    xhr.responseType = 'json';
    xhr.onerror = function () { console.warn('[renplay] download failed'); };
    xhr.onload = function () {
      if (xhr.status !== 200 || !xhr.response) return;
      writeEntries(xhr.response.entries);
    };
    xhr.send();
  }

  function writeEntries(entries) {
    if (!entries || !entries.length) return;
    var FS = getFS();
    if (FS) {
      try {
        for (var i = 0; i < entries.length; i++) {
          var name = entries[i].name;
          var data = entries[i].data;
          if (name === SAVE_ENTRY) {
            try {
              localStorage.setItem(LS_KEY, b64ToUtf8(data));
              console.log('[renplay] restored legacy save');
            } catch (e) {}
            continue;
          }
          var full = LS_KEY + '/' + name;
          var parts = name.split('/');
          var cur = LS_KEY;
          for (var j = 0; j < parts.length - 1; j++) {
            cur += '/' + parts[j];
            if (!FS.analyzePath(cur).exists) FS.mkdir(cur);
          }
          FS.writeFile(full, b64ToBytes(data));
        }
        FS.syncfs(false, function (err) {
          if (err) console.warn('[renplay] syncfs write error:', err);
        });
        console.log('[renplay] restored saves to FS');
      } catch (e) {
        console.warn('[renplay] FS write failed:', e);
      }
      return;
    }
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].name === SAVE_ENTRY) {
        try {
          localStorage.setItem(LS_KEY, b64ToUtf8(entries[i].data));
          console.log('[renplay] restored saves to localStorage');
        } catch (e) {}
        break;
      }
    }
  }

  function uploadSaves(beacon) {
    if (!gameSlug) return;
    try {
      var files = getSaveFiles();
      if (!files) return;
      var entries = buildEntries(files);
      if (!entries.length) return;
      var h = hashOf(JSON.stringify(entries));
      if (h === lastHash && !beacon) return;
      lastHash = h;
      var body = JSON.stringify({ entries: entries });
      var url = '/api/saves/' + encodeURIComponent(gameSlug);
      if (beacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      } else {
        var xhr = new XMLHttpRequest();
        xhr.open('PUT', url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function () {
          if (xhr.status >= 400) console.warn('[renplay] upload failed:', xhr.status, xhr.responseText);
        };
        xhr.onerror = function () { console.warn('[renplay] upload network error'); };
        xhr.send(body);
      }
    } catch (e) {
      console.warn('[renplay] upload error:', e);
    }
  }

  function hashOf(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return String(h);
  }

  function tick() {
    if (!running || !gameSlug) return;
    uploadSaves(false);
  }

  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'renplay-save-now') {
      uploadSaves(false);
    }
  });

  gameSlug = getGameSlug();
  if (!gameSlug) return;

  console.log('[renplay] starting for game', gameSlug);

  running = true;
  setInterval(tick, POLL_MS);

  window.addEventListener('beforeunload', function () {
    uploadSaves(true);
  });

  var _origAtExit = window.atExit;
  window.atExit = function () {
    if (window.parent) {
      window.parent.postMessage({ type: 'renplay-game-exited' }, '*');
    }
    if (_origAtExit) _origAtExit();
  };

  var fsCheckTimer = setInterval(function () {
    var FS = getFS();
    if (FS && FS.analyzePath(LS_KEY).exists) {
      clearInterval(fsCheckTimer);
      console.log('[renplay] FS ready, downloading saves');
      downloadSaves();
    }
  }, 200);
})();
