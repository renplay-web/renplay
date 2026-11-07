/*
 * renplay runtime: loaded into every game page before Ren'Py's renpy-pre.js.
 *
 * - Saves: ~/.renpy lives on the server. Before Ren'Py starts, this game's save
 *   folder and the shared folders are restored into Emscripten's in-memory FS;
 *   other games' folders appear as files fetched on first read. Every change
 *   Ren'Py makes (it calls FS.syncfs after each save) is uploaded right away.
 *   A per-browser IndexedDB copy keeps unsent changes across reloads and lets
 *   the game start when the server is unreachable.
 * - Caches game.zip in Cache Storage (build URLs are versioned).
 * - Serves the shared engine files and bridges fullscreen/exit to the player.
 */
;(function () {
  'use strict'
  if (window.__renplayRuntime) return
  var cfg = window.__renplay || {}
  if (!cfg.id) return

  var signedOut = false
  function onSignedOut() {
    if (signedOut) return
    signedOut = true
    post('signed-out', { userId: cfg.userId })
  }
  var HOME = '/home/web_user/.renpy'
  var API = '/api/saves/' + encodeURIComponent(cfg.id)
  var inFrame = window.parent && window.parent !== window
  var log = function () {
    var a = Array.prototype.slice.call(arguments)
    a.unshift('[renplay]')
    console.log.apply(console, a)
  }

  // ---------------------------------------------------------------- frame pacing

  /*
   * Ren'Py expects swapping buffers to block until vsync. In a browser it does
   * not, and the web build yields with emscripten_sleep(0) (a zero-delay
   * setTimeout), so Ren'Py redraws as fast as it can. The browser then shows a
   * frame only every 70-100 ms: the timer chain starves rendering and the GPU
   * queue fills with frames nobody sees.
   *
   * Fix: once Ren'Py has drawn (any WebGL clear), its next short sleep resumes
   * on the next animation frame instead. Ren'Py then draws at most once per
   * display refresh, inside requestAnimationFrame, like a normal web game.
   * Hidden pages keep plain timers so music and autosaves continue.
   *
   * Until Ren'Py draws its first frame, zero-delay yields go through a
   * MessageChannel: browsers stretch chained setTimeout(0) to 4 ms, and
   * unpacking game.zip (a yield every 25 files) and loading the script spent
   * most of their time waiting. Afterwards plain timers are kept for work
   * between frames, so it never competes with drawing.
   */
  var pacing = (function () {
    var realSetTimeout = window.setTimeout.bind(window)
    var realClearTimeout = window.clearTimeout.bind(window)
    var drawn = false
    var started = false
    var waiting = []
    var byId = new Map()
    var raf = 0
    var fallback = 0
    var nextId = 0x40000000
    var stats = { frames: 0, deferred: 0, immediate: 0 }
    var immediate = []
    var channel = new MessageChannel()
    channel.port1.onmessage = function () {
      var list = immediate
      immediate = []
      runList(list)
    }

    ;[window.WebGLRenderingContext, window.WebGL2RenderingContext].forEach(function (C) {
      if (!C || !C.prototype.clear) return
      var clear = C.prototype.clear
      C.prototype.clear = function (mask) {
        drawn = true
        started = true
        return clear.call(this, mask)
      }
    })

    function run(fromRaf) {
      if (fromRaf) {
        if (fallback) realClearTimeout(fallback)
      } else if (raf) cancelAnimationFrame(raf)
      raf = 0
      fallback = 0
      drawn = false
      stats.frames++
      var list = waiting
      waiting = []
      runList(list)
    }

    function runList(list) {
      for (var i = 0; i < list.length; i++) {
        var e = list[i]
        byId.delete(e.id)
        if (e.cancelled) continue
        try {
          e.fn.apply(window, e.args)
        } catch (err) {
          realSetTimeout(function () {
            throw err
          }, 0)
        }
      }
    }

    window.setTimeout = function (fn, ms) {
      if (drawn && typeof fn === 'function' && !(ms > 4) && !document.hidden) {
        var e = { id: nextId++, fn: fn, args: Array.prototype.slice.call(arguments, 2), cancelled: false }
        waiting.push(e)
        byId.set(e.id, e)
        stats.deferred++
        if (!raf) {
          raf = requestAnimationFrame(function () {
            run(true)
          })
          // rAF stops when the page is hidden mid-frame; never stall longer than this.
          fallback = realSetTimeout(function () {
            run(false)
          }, 250)
        }
        return e.id
      }
      if (!started && typeof fn === 'function' && !(ms > 0)) {
        var im = { id: nextId++, fn: fn, args: Array.prototype.slice.call(arguments, 2), cancelled: false }
        byId.set(im.id, im)
        stats.immediate++
        if (immediate.push(im) === 1) channel.port2.postMessage(0)
        return im.id
      }
      return realSetTimeout.apply(window, arguments)
    }

    window.clearTimeout = function (id) {
      var e = byId.get(id)
      if (e) {
        e.cancelled = true
        byId.delete(id)
        return
      }
      return realClearTimeout(id)
    }

    return stats
  })()

  var state = {
    saveDir: cfg.saveDir || null,
    known: new Map(), // path -> { mtime, size, hash }
    lazy: new Map(), // path -> { size, mtime, loaded }
    queue: new Map(), // path -> { data|null, mtime, base }
    // The server's version of each file this device last saw (its mtime), sent with every upload so
    // the server can tell when another device saved the same file in between.
    base: new Map(),
    // True once the server's list arrived: without it (an offline start) no base is known.
    baseKnown: false,
    // The hash of an upload whose answer never came, by path: it may have reached the server, and
    // then the server's copy is this device's own, not another device's.
    unanswered: new Map(),
    inflight: false,
    online: true,
    lastSync: 0,
    failures: 0,
    ready: false,
    parentFullscreen: false,
  }

  // ---------------------------------------------------------------- vertex uploads

  /*
   * Ren'Py's renderer draws from client-side vertex arrays, which WebGL lacks;
   * Emscripten emulates them by copying each draw's vertices and indices into
   * a pooled buffer with bufferSubData(target, 0, data) right before the draw.
   * Overwriting a buffer that earlier draws of the same frame still read makes
   * the browser's GPU process wait or copy. Menus with many small draws (170 a
   * frame in Ripples) fell to 15 fps that way.
   *
   * Whole uploads from offset 0 therefore get fresh storage of exactly that
   * size (bufferData), which the draw that follows reads in full. Nothing else
   * changes: 15 -> 60 fps on that menu, same picture.
   */
  ;[window.WebGL2RenderingContext, window.WebGLRenderingContext].forEach(function (C) {
    if (!C || C.prototype.__renplayUploads) return
    var bufferSubData = C.prototype.bufferSubData
    C.prototype.bufferSubData = function (target, offset, data) {
      if (offset === 0 && arguments.length === 3 && data && data.byteLength) {
        return this.bufferData(target, data, this.DYNAMIC_DRAW)
      }
      return bufferSubData.apply(this, arguments)
    }
    C.prototype.__renplayUploads = true
  })

  // ---------------------------------------------------------------- mute

  /**
   * The player's mute button works like muting a browser tab: every audio
   * output (Ren'Py's Web Audio, which videos also play through, and SDL's)
   * goes through a gain node set to 0 while muted, so the game's own volume
   * settings stay as they are. The choice is kept per browser.
   */
  var MUTE_KEY = 'renplay:muted'
  var muted = false
  try {
    muted = localStorage.getItem(MUTE_KEY) === '1'
  } catch (e) {}
  var outputs = new Map()
  if (typeof AudioNode !== 'undefined' && typeof AudioDestinationNode !== 'undefined') {
    var nativeConnect = AudioNode.prototype.connect
    var nativeDisconnect = AudioNode.prototype.disconnect
    var outputFor = function (dest) {
      var g = outputs.get(dest)
      if (!g) {
        g = dest.context.createGain()
        g.gain.value = muted ? 0 : 1
        nativeConnect.call(g, dest)
        outputs.set(dest, g)
      }
      return g
    }
    var redirect = function (native) {
      return function (target) {
        if (!(target instanceof AudioDestinationNode)) return native.apply(this, arguments)
        var args = Array.prototype.slice.call(arguments)
        args[0] = outputFor(target)
        return native.apply(this, args)
      }
    }
    AudioNode.prototype.connect = redirect(nativeConnect)
    AudioNode.prototype.disconnect = redirect(nativeDisconnect)
  }

  function setMuted(on) {
    muted = !!on
    outputs.forEach(function (g) {
      g.gain.value = muted ? 0 : 1
    })
  }

  // ---------------------------------------------------------------- messaging

  function post(type, data) {
    if (!inFrame) return
    var msg = { type: 'renplay:' + type, game: cfg.id }
    if (data) for (var k in data) msg[k] = data[k]
    try {
      window.parent.postMessage(msg, location.origin)
    } catch (e) {}
  }

  function status() {
    post('sync', {
      pending: state.queue.size + (state.inflight ? 1 : 0),
      online: state.online,
      lastSync: state.lastSync,
      saveDir: state.saveDir,
    })
  }

  // ---------------------------------------------------------------- IndexedDB

  var dbPromise = null
  function idb() {
    if (!window.indexedDB) return Promise.reject(new Error('no indexedDB'))
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        var req = indexedDB.open('renplay', 1)
        req.onupgradeneeded = function () {
          var s = req.result.createObjectStore('files', { keyPath: 'key' })
        }
        req.onsuccess = function () {
          resolve(req.result)
        }
        req.onerror = function () {
          reject(req.error)
        }
      })
    }
    return dbPromise
  }

  function idbTx(mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('files', mode)
        var out = fn(tx.objectStore('files'))
        tx.oncomplete = function () {
          resolve(out && out.result !== undefined ? out.result : out)
        }
        tx.onerror = function () {
          reject(tx.error)
        }
        tx.onabort = function () {
          reject(tx.error)
        }
      })
    })
  }

  // ~/.renpy is shared by games, never by accounts (including unsent changes).
  function localKey(path) { return String(cfg.userId) + ':' + path }
  function idbPut(path, data, mtime, synced, base) {
    return idbTx('readwrite', function (s) {
      s.put({ key: localKey(path), userId: cfg.userId, game: cfg.id, path: path, data: data, mtime: mtime, synced: synced ? 1 : 0, base: base })
    }).catch(function () {})
  }

  function idbAll() {
    return idbTx('readwrite', function (s) {
      var all = s.getAll()
      all.onsuccess = function () {
        all.result.forEach(function (entry) {
          if (entry.userId != null) return
          if (cfg.legacySaveOwner === cfg.userId) {
            // Only the known pre-accounts owner may claim legacy entries, never overwrite a newer queue.
            var existing = s.get(localKey(entry.path))
            existing.onsuccess = function () {
              if (existing.result) {
                post('legacy-saves', { message: 'An older browser save was kept separately for recovery because this account already has a copy.' })
                return
              }
              s.delete(entry.key)
              entry.key = localKey(entry.path)
              entry.userId = cfg.userId
              s.put(entry)
            }
          } else {
            console.warn('[renplay] Unowned browser saves were kept for recovery; their account is not known.')
            post('legacy-saves', { message: 'Unowned browser saves were kept on this device. Their account is not known.' })
          }
        })
      }
      return all
    }).then(function (entries) {
      return entries.filter(function (entry) { return entry.userId === cfg.userId })
    }).catch(function () {
      return []
    })
  }

  function idbMarkSynced(path, mtime, base) {
    return idbTx('readwrite', function (s) {
      var r = s.get(localKey(path))
      r.onsuccess = function () {
        var v = r.result
        if (!v) return
        if (v.mtime !== mtime) {
          // A newer write waits here: it now builds on the version the server just took.
          if (base !== undefined && !v.synced) {
            v.base = base
            s.put(v)
          }
          return
        }
        if (v.data === null) s.delete(localKey(path))
        else {
          v.synced = 1
          s.put(v)
        }
      }
    }).catch(function () {})
  }

  // ---------------------------------------------------------------- helpers

  function b64ToBytes(b64) {
    var bin = atob(b64)
    var out = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }

  function hash(bytes) {
    // FNV-1a over the bytes plus the length; enough to skip identical rewrites.
    var h = 0x811c9dc5
    for (var i = 0; i < bytes.length; i++) {
      h ^= bytes[i]
      h = Math.imul(h, 0x01000193)
    }
    return (h >>> 0).toString(16) + ':' + bytes.length
  }

  function isJunk(path) {
    var base = path.slice(path.lastIndexOf('/') + 1)
    return base.charAt(0) === '.' || /\.(tmp|new)$/.test(base) || base === 'text.txt'
  }

  function fetchJSON(url, opts, tries) {
    tries = tries || 1
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    }).catch(function (e) {
      if (signedOut || tries <= 1) throw e
      return new Promise(function (res) {
        setTimeout(res, 600)
      }).then(function () {
        return fetchJSON(url, opts, tries - 1)
      })
    })
  }

  function mkdirp(dir) {
    var parts = dir.split('/')
    var cur = ''
    for (var i = 1; i < parts.length; i++) {
      cur += '/' + parts[i]
      try {
        FS.mkdir(cur)
      } catch (e) {}
    }
  }

  function setTimes(full, mtime) {
    try {
      FS.utime(full, mtime, mtime)
    } catch (e) {}
  }

  function writeLocal(path, bytes, mtime) {
    var full = HOME + '/' + path
    mkdirp(full.slice(0, full.lastIndexOf('/')))
    FS.writeFile(full, bytes)
    setTimes(full, mtime)
  }

  /** Synchronous binary GET (Ren'Py reads files synchronously). */
  function syncFetch(path) {
    var xhr = new XMLHttpRequest()
    xhr.open('GET', API + '/raw?path=' + encodeURIComponent(path), false)
    xhr.setRequestHeader('x-renplay-user', String(cfg.userId))
    xhr.overrideMimeType('text/plain; charset=x-user-defined')
    xhr.send(null)
    if (xhr.status === 401) onSignedOut()
    if (xhr.status !== 200) throw new Error('lazy fetch failed ' + xhr.status)
    var s = xhr.responseText
    var out = new Uint8Array(s.length)
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
    return out
  }

  /**
   * Creates a file whose bytes are fetched the first time something reads it.
   * stat() and directory listings use the known size and never fetch.
   */
  function createLazy(path, size, mtime) {
    var full = HOME + '/' + path
    mkdirp(full.slice(0, full.lastIndexOf('/')))
    FS.writeFile(full, new Uint8Array(0))
    var node = FS.lookupPath(full).node
    var backing = null
    var loaded = false
    var entry = { size: size, mtime: mtime, loaded: false }
    state.lazy.set(path, entry)
    Object.defineProperty(node, 'contents', {
      configurable: true,
      enumerable: true,
      get: function () {
        if (!loaded) {
          loaded = true
          entry.loaded = true
          try {
            backing = syncFetch(path)
            log('loaded', path, 'on demand')
          } catch (e) {
            console.warn('[renplay] could not load', path, e)
            backing = new Uint8Array(0)
          }
          node.usedBytes = backing.length
        }
        return backing
      },
      set: function (v) {
        loaded = true
        entry.loaded = true
        backing = v
      },
    })
    node.usedBytes = size
    setTimes(full, mtime)
    state.known.set(path, { mtime: mtime, size: size, hash: null })
  }

  function walk(dir, prefix, out) {
    var names
    try {
      names = FS.readdir(dir)
    } catch (e) {
      return out
    }
    for (var i = 0; i < names.length; i++) {
      var n = names[i]
      if (n === '.' || n === '..') continue
      var full = dir + '/' + n
      var rel = prefix ? prefix + '/' + n : n
      var st
      try {
        st = FS.stat(full)
      } catch (e) {
        continue
      }
      if (FS.isDir(st.mode)) walk(full, rel, out)
      else if (FS.isFile(st.mode) && !isJunk(rel)) out.push({ path: rel, full: full, size: st.size, mtime: +st.mtime })
    }
    return out
  }

  // ---------------------------------------------------------------- sync

  var scanTimer = null
  function scheduleScan(delay) {
    if (scanTimer) clearTimeout(scanTimer)
    scanTimer = setTimeout(function () {
      scanTimer = null
      scan()
    }, delay === undefined ? 250 : delay)
  }

  /** Compares ~/.renpy with what the server has and queues the differences. */
  function scan() {
    if (!state.ready || typeof FS === 'undefined') return
    var seen = new Set()
    var files = walk(HOME, '', [])
    for (var i = 0; i < files.length; i++) {
      var f = files[i]
      seen.add(f.path)
      var k = state.known.get(f.path)
      var lz = state.lazy.get(f.path)
      if (lz && !lz.loaded) continue
      if (k && k.mtime === f.mtime && k.size === f.size) continue
      var bytes
      try {
        bytes = FS.readFile(f.full)
      } catch (e) {
        continue
      }
      var h = hash(bytes)
      if (k && k.hash === h) {
        k.mtime = f.mtime
        continue
      }
      state.known.set(f.path, { mtime: f.mtime, size: f.size, hash: h })
      enqueue(f.path, bytes, f.mtime)
    }
    state.known.forEach(function (_v, path) {
      if (!seen.has(path)) {
        state.known.delete(path)
        state.lazy.delete(path)
        enqueue(path, null, Date.now())
      }
    })
  }

  /** The server version this device last saw, 0 for none, or null when that is not known. */
  function currentBase(path) {
    if (!state.baseKnown) return null
    return state.base.has(path) ? state.base.get(path) : 0
  }

  function enqueue(path, bytes, mtime) {
    var data = bytes ? new Uint8Array(bytes) : null
    // The base is read when the upload is sent, after any upload before it. Only the copy kept on
    // this device records it now, for a later visit that delivers it.
    state.queue.set(path, { data: data, mtime: mtime })
    idbPut(path, data, mtime, false, currentBase(path))
    pump()
  }

  function readLocal(path) {
    try {
      return FS.readFile(HOME + '/' + path)
    } catch (e) {
      return null
    }
  }

  /**
   * The conflict rule: another device saved this file since this one last saw it. The copy saved
   * later stays in the slot and the other is kept in History, so nothing is lost. When the server
   * kept its own copy, the game gets that copy too.
   */
  function onConflict(path, answer, sentHash) {
    post('save-conflict', { path: path, kept: answer.conflict === 'kept' ? 'other' : 'this', deleted: sentHash === null })
    if (answer.conflict !== 'kept') return
    var mtime = answer.mtime
    fetch(API + '/raw?path=' + encodeURIComponent(path), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        mtime = Number(r.headers.get('x-renplay-mtime')) || mtime
        return r.arrayBuffer()
      })
      .then(function (buf) {
        // Only while the game still holds what it sent (or, after a delete, nothing): a save made
        // since then is newer and goes up as usual.
        var local = readLocal(path)
        if (sentHash === null ? local : !local || hash(local) !== sentHash) return
        var bytes = new Uint8Array(buf)
        writeLocal(path, bytes, mtime)
        state.known.set(path, { mtime: mtime, size: bytes.length, hash: hash(bytes) })
        state.base.set(path, mtime)
        idbPut(path, bytes, mtime, true, mtime)
      })
      .catch(function (e) {
        console.warn('[renplay] could not fetch the kept copy of', path, e)
      })
  }

  function pump() {
    if (signedOut || state.inflight || !state.queue.size) {
      status()
      return
    }
    var path = state.queue.keys().next().value
    var item = state.queue.get(path)
    state.queue.delete(path)
    state.inflight = true
    status()
    var url = API + '/file?path=' + encodeURIComponent(path)
    var headers = { 'content-type': 'application/octet-stream', 'x-mtime': String(item.mtime) }
    // A write kept from an earlier visit carries the base it was made on, one made now the newest.
    // A write kept by an older Renplay has none and is delivered as before.
    var base = item.base !== undefined ? item.base : currentBase(path)
    if (base !== null) headers['x-base'] = String(base)
    if (state.unanswered.has(path)) headers['x-unanswered'] = state.unanswered.get(path)
    var req = item.data
      ? fetch(url, { method: 'PUT', body: item.data, headers: headers })
      : fetch(url, { method: 'DELETE', headers: base !== null ? { 'x-base': String(base) } : {} })
    var sentHash = item.data ? hash(item.data) : null
    req
      .then(function (r) {
        // 409 on a delete: another device saved the file since, so it stays and comes back here.
        var deleteKept = !item.data && r.status === 409
        if (!r.ok && !deleteKept && !(r.status === 404 && !item.data)) throw new Error('HTTP ' + r.status)
        state.online = true
        state.failures = 0
        state.lastSync = Date.now()
        state.unanswered.delete(path)
        if (!item.data) {
          idbMarkSynced(path, item.mtime)
          state.base.delete(path)
          if (deleteKept) return r.json().then(function (answer) { onConflict(path, answer, null) }, function () {})
          return
        }
        return r.json().then(function (answer) {
          if (answer && answer.mtime) state.base.set(path, answer.mtime)
          idbMarkSynced(path, item.mtime, answer && answer.mtime)
          if (answer && answer.conflict) onConflict(path, answer, sentHash)
        }, function () {
          idbMarkSynced(path, item.mtime)
        })
      })
      .catch(function (e) {
        console.warn('[renplay] upload failed for', path, e)
        if (sentHash) state.unanswered.set(path, sentHash)
        // Keep the newest version queued.
        if (!state.queue.has(path)) state.queue.set(path, item)
        state.online = false
        state.failures++
      })
      .then(function () {
        state.inflight = false
        if (signedOut) { status(); return }
        if (!state.online) {
          status()
          setTimeout(pump, Math.min(30000, 1000 * Math.pow(2, Math.min(5, state.failures))))
        } else pump()
      })
  }

  function flush(timeoutMs) {
    scan()
    return new Promise(function (resolve) {
      var start = Date.now()
      ;(function wait() {
        if ((!state.queue.size && !state.inflight) || Date.now() - start > (timeoutMs || 8000)) {
          resolve(!state.queue.size && !state.inflight)
          return
        }
        setTimeout(wait, 100)
      })()
    })
  }

  // ---------------------------------------------------------------- boot

  function boot() {
    var server = null
    return fetchJSON(API + '/boot', { cache: 'no-store' }, 3)
      .then(function (b) {
        server = b
        state.baseKnown = true
      })
      .catch(function (e) {
        console.warn('[renplay] save server unreachable, using the local copy', e)
        state.online = false
      })
      .then(function () {
        return idbAll()
      })
      .then(function (local) {
        var serverFiles = new Map()
        if (server) {
          if (server.saveDir) state.saveDir = server.saveDir
          server.files.forEach(function (f) {
            serverFiles.set(f.path, f)
          })
        }
        // 1. Server state.
        serverFiles.forEach(function (f) {
          var bytes = b64ToBytes(f.data)
          writeLocal(f.path, bytes, f.mtime)
          state.known.set(f.path, { mtime: f.mtime, size: bytes.length, hash: hash(bytes) })
          state.base.set(f.path, f.mtime)
        })
        if (server && server.lazy) {
          server.lazy.forEach(function (f) {
            state.base.set(f.path, f.mtime)
            if (!serverFiles.has(f.path)) createLazy(f.path, f.size, f.mtime)
          })
        }
        // 2. Local changes the server has not seen (written while offline or
        //    interrupted). Offline: the whole local copy.
        local.forEach(function (e) {
          if (!server) {
            if (e.data) writeLocal(e.path, e.data, e.mtime)
            if (e.synced) state.known.set(e.path, { mtime: e.mtime, size: e.data ? e.data.length : 0, hash: e.data ? hash(e.data) : null })
            else if (e.data) state.queue.set(e.path, { data: e.data, mtime: e.mtime, base: e.base === undefined ? null : e.base })
            return
          }
          if (e.synced) return
          // Always deliver an unsent write, with the base it was made on: the server applies the
          // conflict rule when another device saved the same file meanwhile.
          if (e.data) {
            writeLocal(e.path, e.data, e.mtime)
            state.known.set(e.path, { mtime: e.mtime, size: e.data.length, hash: hash(e.data) })
            state.queue.set(e.path, { data: e.data, mtime: e.mtime, base: e.base === undefined ? null : e.base })
          } else {
            try {
              FS.unlink(HOME + '/' + e.path)
            } catch (er) {}
            state.known.delete(e.path)
            state.queue.set(e.path, { data: null, mtime: e.mtime, base: e.base === undefined ? null : e.base })
          }
        })
        state.ready = true
        log('saves ready', { saveDir: state.saveDir, files: serverFiles.size, lazy: state.lazy.size, queued: state.queue.size })
        pump()
      })
  }

  // ---------------------------------------------------------------- Emscripten hooks

  var Module = (window.Module = window.Module || {})
  Module.preRun = Module.preRun || []
  if (cfg.engineBase) {
    var prevLocate = Module.locateFile
    Module.locateFile = function (path, prefix) {
      if (/^renpy\.(wasm|data)$/.test(path)) return cfg.engineBase + path
      return prevLocate ? prevLocate(path, prefix) : prefix + path
    }
  }

  /** Size of game.zip, known before renpy-pre.js streams it into the FS. */
  var gameZipSize = 0

  /**
   * Faster file creation for unpacking game.zip (tens of thousands of files).
   * Emscripten finds out that a new file does not exist yet by throwing and
   * catching "not found" twice per file, which costs about 2 s for a big game.
   * These versions check the name table directly and otherwise do exactly what
   * Emscripten does. Only in-memory (MEMFS) directories are affected.
   */
  function speedUpFs() {
    if (typeof MEMFS === 'undefined' || !MEMFS.ops_table || !FS.nameTable) return
    var memDir = MEMFS.ops_table.dir.node
    var find = function (dir, name) {
      var hash = FS.hashName(dir.id, name)
      for (var n = FS.nameTable[hash]; n; n = n.name_next) if (n.parent.id === dir.id && n.name === name) return n
      return null
    }
    var mayCreate = FS.mayCreate
    FS.mayCreate = function (dir, name) {
      if (dir.node_ops !== memDir) return mayCreate.call(FS, dir, name)
      return find(dir, name) ? 20 : FS.nodePermissions(dir, 'wx')
    }
    var open = FS.open
    FS.open = function (path, flags, mode) {
      var f = typeof flags === 'string' ? FS_modeStringToFlags(flags) : flags
      // O_CREAT without O_EXCL on a plain path: create the node first, so the
      // original open finds it instead of throwing to learn it is missing.
      if (typeof path === 'string' && path && f & 64 && !(f & 128)) {
        try {
          var parent = FS.lookupPath(path, { parent: true }).node
          var name = PATH.basename(PATH.normalize(path))
          if (parent && parent.node_ops === memDir && name && name !== '.' && name !== '..' && !find(parent, name)) {
            var m = typeof mode === 'undefined' ? 438 : mode
            FS.mknod(path, (m & 4095) | 32768, 0)
          }
        } catch (e) {}
      }
      var stream = open.call(FS, path, flags, mode)
      if (path === '/game.zip' && stream) gameZipNode = stream.node
      return stream
    }
    // renpy-pre.js streams game.zip in chunks; MEMFS would grow the buffer in
    // 12.5% steps, copying the whole archive each time. Grow it once, to size.
    var gameZipNode = null
    var expand = MEMFS.expandFileStorage
    MEMFS.expandFileStorage = function (node, capacity) {
      if (node === gameZipNode && gameZipSize > capacity) capacity = gameZipSize
      return expand.call(MEMFS, node, capacity)
    }
  }

  function preRun() {
    try {
      speedUpFs()
    } catch (e) {
      console.warn('[renplay] FS speedups not applied', e)
    }
    // Keep ~/.renpy in memory; renplay replaces IDBFS with the server.
    var origMount = FS.mount
    FS.mount = function (type, opts, mountpoint) {
      if (mountpoint === HOME && typeof IDBFS !== 'undefined' && type === IDBFS) return null
      return origMount.apply(FS, arguments)
    }
    FS.syncfs = function (populate, callback) {
      if (typeof populate === 'function') {
        callback = populate
        populate = false
      }
      if (!populate) scheduleScan()
      if (callback) setTimeout(function () {
        callback(null)
      }, 0)
    }
    Module.addRunDependency('renplay-caches')
    cachesReady.then(function () {
      try {
        restoreCaches()
      } catch (e) {
        console.warn('[renplay] could not restore caches', e)
      }
      Module.removeRunDependency('renplay-caches')
    })
    Module.addRunDependency('renplay-saves')
    boot()
      .catch(function (e) {
        console.error('[renplay] save restore failed', e)
        state.ready = true
      })
      .then(function () {
        Module.removeRunDependency('renplay-saves')
      })
  }

  // ---------------------------------------------------------------- engine

  var nativeFetch = window.fetch.bind(window)
  var origFetch = function (input, init) {
    var url = typeof input === 'string' ? input : input && input.url
    if (url && new URL(url, location.href).pathname.indexOf('/api/') === 0) {
      init = Object.assign({}, init)
      init.headers = new Headers(init.headers || {})
      init.headers.set('x-renplay-user', String(cfg.userId))
    }
    return nativeFetch(input, init).then(function (res) {
      if (res.status === 401) onSignedOut()
      return res
    })
  }

  /*
   * The shared engine (renpy.wasm + renpy.data, ~37 MB) is fetched as the
   * prebuilt .gz files and unpacked here with DecompressionStream. Proxies in
   * front of renplay tend to strip Accept-Encoding or undo Content-Encoding,
   * but leave a plain .gz download alone. Both files are kept in Cache Storage
   * (immutable per engine id), and renpy.js is only started once renpy.data
   * is in memory, which the engine's package loader needs synchronously.
   */
  var ENGINE_CACHE = 'renplay-engine-v1'
  var engine = null

  function cachedFile(name, type, onBytes) {
    var url = new URL(cfg.engineBase + name, location.href).toString()
    var gz = typeof DecompressionStream === 'function' && typeof TransformStream === 'function'
    var cacheP = 'caches' in window ? caches.open(ENGINE_CACHE).catch(function () { return null }) : Promise.resolve(null)
    return cacheP.then(function (cache) {
      return (cache ? cache.match(url).catch(function () { return null }) : Promise.resolve(null)).then(function (hit) {
        if (hit) {
          onBytes(Number(hit.headers.get('content-length')) || 0, true)
          return hit
        }
        var download = function (src, unzip) {
          return origFetch(src, { credentials: 'same-origin' }).then(function (res) {
            if (!res.ok || !res.body) throw new Error('HTTP ' + res.status + ' for ' + src)
            var counted = res.body.pipeThrough(
              new TransformStream({
                transform: function (chunk, ctl) {
                  onBytes(chunk.length, false)
                  ctl.enqueue(chunk)
                },
              }),
            )
            var body = unzip ? counted.pipeThrough(new DecompressionStream('gzip')) : counted
            var out = new Response(body, { headers: { 'content-type': type } })
            if (cache) cache.put(url, out.clone()).catch(function () {})
            return out
          })
        }
        return (gz ? download(url + '.gz', true) : Promise.reject(new Error('no DecompressionStream'))).catch(function (e) {
          if (gz) console.warn('[renplay] compressed engine download failed, using the plain file', e)
          return download(url, false)
        })
      })
    })
  }

  function loadEngine() {
    var sizes = { 'renpy.wasm': 6.1e6, 'renpy.data': 5.5e6 }
    var got = 0
    var fromCache = 0
    var onBytes = function (n, cached) {
      if (cached) fromCache++
      else got += n
      if (typeof window.progress === 'function') window.progress(got, sizes['renpy.wasm'] + sizes['renpy.data'])
    }
    var wasm = cachedFile('renpy.wasm', 'application/wasm', onBytes)
    var data = cachedFile('renpy.data', 'application/octet-stream', onBytes).then(function (r) {
      return r.arrayBuffer()
    })
    engine = { wasm: wasm, data: data }
    var t0 = Date.now()
    data.then(
      function (buf) {
        Module.getPreloadedPackage = function () {
          Module.getPreloadedPackage = null
          return buf
        }
        log('engine ready in', Date.now() - t0, 'ms', fromCache ? '(cached)' : '')
        var s = document.createElement('script')
        s.src = cfg.engineBase + 'renpy.js'
        s.async = true
        document.body.appendChild(s)
      },
      function (e) {
        console.error('[renplay] engine download failed', e)
        var s = document.createElement('script')
        s.src = cfg.engineBase + 'renpy.js'
        document.body.appendChild(s)
      },
    )
  }

  /*
   * Compiled caches. On first start Ren'Py compiles the game's Python
   * (game/cache/*.rpyb) and, for games made with an older Ren'Py, recompiles
   * every script (.rpyc) from source. renplay stores those with the build and
   * puts them back on later starts: bytecode before Ren'Py starts, scripts
   * right after game.zip is unpacked (it would overwrite them otherwise).
   */
  var CACHE_RE = /^(bytecode-\d+|py3analysis|screens)\.rpyb$/
  var scriptsLoadedAt = 0
  var pyCaches = { files: {}, hashes: {} }
  var cachesReady = Promise.all(
    (cfg.caches || []).map(function (c) {
      return origFetch('cache/' + c.name.split('/').map(encodeURIComponent).join('/') + '?v=' + encodeURIComponent(c.v))
        .then(function (r) {
          return r.ok ? r.arrayBuffer() : null
        })
        .then(function (b) {
          if (!b) return
          var data = new Uint8Array(b)
          pyCaches.files[c.name] = data
          pyCaches.hashes[c.name] = hash(data)
        })
        .catch(function () {})
    }),
  )

  function restoreCaches() {
    var names = Object.keys(pyCaches.files).filter(function (n) {
      return CACHE_RE.test(n)
    })
    if (!names.length) return
    mkdirp('/game/cache')
    names.forEach(function (n) {
      FS.writeFile('/game/cache/' + n, pyCaches.files[n])
      delete pyCaches.files[n]
    })
    log('restored', names.length, 'compiled caches')
  }

  function fileExists(path) {
    try {
      FS.stat(path)
      return true
    } catch (e) {
      return false
    }
  }

  /** Called as Ren'Py starts loading scripts, after game.zip is unpacked. */
  function restoreScripts() {
    scriptsLoadedAt = Date.now()
    var restored = 0
    Object.keys(pyCaches.files).forEach(function (n) {
      if (n.indexOf('rpyc/') !== 0) return
      var full = '/game/' + n.slice(5)
      // Only scripts this build has (a mod may have removed some).
      if (fileExists(full) || fileExists(full.slice(0, -1))) {
        FS.writeFile(full, pyCaches.files[n])
        restored++
      }
      delete pyCaches.files[n]
    })
    if (restored) log('restored', restored, 'compiled scripts')
  }

  function putCache(name, data) {
    return origFetch('/api/games/' + encodeURIComponent(cfg.id) + '/cache?build=' + encodeURIComponent(cfg.build) + '&name=' + encodeURIComponent(name), {
      method: 'PUT',
      body: data,
      headers: { 'content-type': 'application/octet-stream' },
    })
      .then(function (r) {
        return r.ok
      })
      .catch(function () {
        return false
      })
  }

  /** Scripts Ren'Py (re)compiled during this start, as cache names. */
  function compiledScripts() {
    var out = []
    var walk = function (dir, rel) {
      var entries
      try {
        entries = FS.readdir(dir)
      } catch (e) {
        return
      }
      entries.forEach(function (n) {
        if (n === '.' || n === '..' || (dir === '/game' && n === 'cache')) return
        var full = dir + '/' + n
        var st
        try {
          st = FS.stat(full)
        } catch (e) {
          return
        }
        if (FS.isDir(st.mode)) walk(full, rel + n + '/')
        else if (/\.rpyc$/i.test(n) && +st.mtime >= scriptsLoadedAt) out.push(['rpyc/' + rel + n, full])
      })
    }
    if (scriptsLoadedAt) walk('/game', '')
    return out
  }

  function uploadCaches() {
    var files = compiledScripts()
    try {
      FS.readdir('/game/cache').forEach(function (n) {
        if (CACHE_RE.test(n)) files.push([n, '/game/cache/' + n])
      })
    } catch (e) {}
    var puts = []
    files.forEach(function (f) {
      var data
      try {
        data = FS.readFile(f[1])
      } catch (e) {
        return
      }
      var h = hash(data)
      if (data.length < 16 || pyCaches.hashes[f[0]] === h) return
      pyCaches.hashes[f[0]] = h
      puts.push(putCache(f[0], data))
    })
    if (!puts.length) return
    Promise.all(puts).then(function (ok) {
      var n = ok.filter(Boolean).length
      if (n) log('stored', n, 'compiled files for faster starts')
    })
  }

  if (cfg.engineBase) {
    Module.instantiateWasm = function (imports, receive) {
      var plain = function () {
        return origFetch(cfg.engineBase + 'renpy.wasm', { credentials: 'same-origin' })
          .then(function (r) { return r.arrayBuffer() })
          .then(function (b) { return WebAssembly.instantiate(b, imports) })
      }
      engine.wasm
        .then(function (res) {
          return WebAssembly.instantiateStreaming(res, imports).catch(function (e) {
            console.warn('[renplay] streaming compile failed, retrying', e)
            return plain()
          })
        }, plain)
        .then(function (r) {
          receive(r.instance, r.module)
        })
        .catch(function (e) {
          console.error('[renplay] could not start the engine', e)
        })
      return {}
    }
    loadEngine()
  }

  // ---------------------------------------------------------------- game.zip cache

  var CACHE = 'renplay-gamezip-v1'

  /*
   * Downloads game.zip so that a dropped connection (seen with HTTP/3 through
   * the gateway) resumes where it stopped instead of leaving the engine
   * waiting forever. Builds never change, so a byte range is safe to append.
   */
  function downloadGameZip(url, init) {
    return origFetch(url, init).then(function (res) {
      var total = Number(res.headers.get('content-length')) || 0
      if (!res.ok || !res.body || !total || res.headers.get('content-encoding')) return res
      var reader = res.body.getReader()
      var received = 0
      var failures = 0
      var reconnect = function (err) {
        if (++failures > 8) throw err
        log('game.zip download interrupted at', Math.round(received / 1e6), 'MB (' + (err && err.message) + '); resuming')
        return new Promise(function (r) {
          setTimeout(r, Math.min(15000, 1000 * failures))
        })
          .then(function () {
            return origFetch(url, { headers: { Range: 'bytes=' + received + '-' }, cache: 'no-store' })
          })
          .then(function (r) {
            var range = r.headers.get('content-range') || ''
            if (r.status !== 206 || range.indexOf('bytes ' + received + '-') !== 0 || !r.body) throw new Error('HTTP ' + r.status + ' for the rest of game.zip')
            reader = r.body.getReader()
          })
          .catch(function (e) {
            return reconnect(e)
          })
      }
      var next = function (controller) {
        return reader.read().then(
          function (r) {
            if (r.done) {
              if (received < total) return reconnect(new Error('connection closed early')).then(function () {
                return next(controller)
              })
              controller.close()
              return
            }
            received += r.value.length
            failures = 0
            controller.enqueue(r.value)
          },
          function (e) {
            return reconnect(e).then(function () {
              return next(controller)
            })
          },
        )
      }
      var body = new ReadableStream({
        pull: function (controller) {
          return next(controller).catch(function (e) {
            post('error', { message: 'Could not download the game (' + ((e && e.message) || e) + ').' })
            throw e
          })
        },
        cancel: function (reason) {
          return reader.cancel(reason)
        },
      })
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
    })
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input && input.url
    if (url && 'caches' in window && /(^|\/)game\.zip(\?|$)/.test(url)) {
      var abs = new URL(url, location.href).toString()
      return caches
        .open(CACHE)
        .then(function (cache) {
          return cache.match(abs).then(function (hit) {
            if (hit) {
              log('game.zip from cache')
              gameZipSize = Number(hit.headers.get('content-length')) || 0
              return hit
            }
            return downloadGameZip(abs, init).then(function (res) {
              gameZipSize = Number(res.headers.get('content-length')) || 0
              if (res.ok) {
                cache.keys().then(function (keys) {
                  keys.forEach(function (k) {
                    if (k.url.indexOf('/g/' + cfg.id + '/') !== -1 && k.url !== abs) cache.delete(k)
                  })
                })
                cache.put(abs, res.clone()).catch(function () {})
              }
              return res
            })
          })
        })
        .catch(function () {
          return downloadGameZip(abs, init)
        })
    }
    return origFetch(input, init)
  }

  // ---------------------------------------------------------------- Ren'Py bridge

  function exec(py, timeoutMs) {
    if (typeof window.renpy_exec !== 'function') return Promise.reject(new Error('bridge not ready'))
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        reject(new Error('timeout'))
      }, timeoutMs || 5000)
      window.renpy_exec(py).then(
        function (v) {
          clearTimeout(t)
          resolve(v)
        },
        function (e) {
          clearTimeout(t)
          reject(e)
        },
      )
    })
  }

  function sizeArg(v) {
    return typeof v === 'number' && v >= 0.5 && v <= 2 ? String(v) : 'None'
  }

  /** The admin's defaults for everyone, as a Python dict of known names only. */
  function defaultsArg(d) {
    if (!d || typeof d !== 'object') return 'None'
    var out = []
    if (d.rollback === true) out.push('"rollback": True')
    if (d.skip === true) out.push('"skip": True')
    if (sizeArg(d.textSize) !== 'None') out.push('"size": ' + sizeArg(d.textSize))
    return '{' + out.join(', ') + '}'
  }

  /** The patches asked for, as a Python dict of known names and True or False only. */
  function patchArg(p) {
    if (!p || typeof p !== 'object') return 'None'
    var out = []
    ;['rollback', 'skip', 'console'].forEach(function (k) {
      if (typeof p[k] === 'boolean') out.push('"' + k + '": ' + (p[k] ? 'True' : 'False'))
    })
    return out.length ? '{' + out.join(', ') + '}' : 'None'
  }

  function pyStr(s) {
    return JSON.stringify(String(s))
  }

  function verifySaveDir() {
    exec('result = [config.save_directory, config.screen_width, config.screen_height, config.name, config.version]', 20000)
      .then(function (r) {
        var sd = r && r[0]
        var screen = [r[1], r[2]]
        post('info', { saveDir: sd, screen: screen, name: r[3], version: r[4] })
        var screenKnown = cfg.screen && cfg.screen[0] === screen[0] && cfg.screen[1] === screen[1]
        if (!sd || (sd === state.saveDir && screenKnown)) return
        if (sd !== state.saveDir) log('save folder is', sd, '(server had', state.saveDir, ')')
        return fetchJSON(API + '/save-dir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ saveDir: sd, screen: screen }) }).then(function (res) {
          state.saveDir = sd
          // The game's real folder was only listed lazily; reload once so its
          // saves and persistent data are restored before Ren'Py starts.
          var key = 'renplay:reloaded:' + cfg.id
          var hasFiles = false
          state.lazy.forEach(function (_v, p) {
            if (p.indexOf(sd + '/') === 0) hasFiles = true
          })
          if (res.changed && hasFiles && !sessionStorage.getItem(key)) {
            sessionStorage.setItem(key, '1')
            flush(4000).then(function () {
              location.reload()
            })
          }
        })
      })
      .catch(function (e) {
        log('could not read config.save_directory', e && e.message)
      })
  }

  /** Loads a save slot as soon as Ren'Py starts its next interaction. */
  function loadSlot(slot) {
    // The bridge exec()s in the store, where `renpy` is renpy.exports (do not
    // `import renpy`, that is the internal package). Locals are separate, so the
    // callback captures what it needs through default arguments. Anything but
    // renpy.load's own control flow exception must stay inside: an error in an
    // interact callback would crash the game.
    var py =
      'def _renplay_load(renpy=renpy, slot=' + pyStr(slot) + ', st={"done": False}):\n' +
      '    if st["done"]:\n' +
      '        return\n' +
      '    st["done"] = True\n' +
      '    try:\n' +
      '        ok = renpy.can_load(slot)\n' +
      '    except Exception:\n' +
      '        ok = False\n' +
      '    if ok:\n' +
      '        renpy.load(slot)\n' +
      'config.interact_callbacks.append(_renplay_load)\n' +
      'renpy.restart_interaction()\n' +
      'result = True\n'
    return exec(py, 30000)
  }

  /** Saves where the person is: an autosave, or in a game without autosave a quick save. */
  function autosave() {
    return exec(
      'result = False\n' +
        'if not renpy.context()._main_menu:\n' +
        '    if config.has_autosave:\n' +
        '        renpy.force_autosave(take_screenshot=True, block=True)\n' +
        '    else:\n' +
        '        import renpy.loadsave as _rl\n' +
        '        renpy.take_screenshot()\n' +
        '        _rl.cycle_saves("quick-", config.quicksave_slots)\n' +
        '        renpy.save("quick-1", extra_info=save_name)\n' +
        '    result = True\n',
      8000,
    ).catch(function () {
      return false
    })
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || typeof e.data.type !== 'string') return
    var d = e.data
    switch (d.type) {
      case 'renplay:resume-sync':
        if (d.userId === cfg.userId) { signedOut = false; pump() }
        break
      case 'renplay:flush':
        flush(d.timeout).then(function (ok) {
          post('flushed', { ok: ok, id: d.id })
        })
        break
      case 'renplay:save-and-exit':
        autosave()
          .then(function (saved) {
            return flush(10000).then(function (ok) {
              post('flushed', { ok: ok, saved: !!saved, id: d.id })
            })
          })
        break
      case 'renplay:save-now':
        // A save into Ren'Py's own quick-save slots, rotated as the game's Quick Save does, with a
        // screenshot. Not in the main menu, where there is nothing to save.
        exec(
          'result = False\n' +
            'if not renpy.context()._main_menu:\n' +
            '    import renpy.loadsave as _rl\n' +
            '    renpy.take_screenshot()\n' +
            '    _rl.cycle_saves("quick-", config.quicksave_slots)\n' +
            '    renpy.save("quick-1", extra_info=save_name)\n' +
            '    result = True\n',
          8000,
        )
          .then(function (saved) {
            return flush(8000).then(function (ok) {
              post('saved-now', { ok: !!saved && ok, saved: !!saved, id: d.id })
            })
          })
          .catch(function () {
            post('saved-now', { ok: false, saved: false, id: d.id })
          })
        break
      case 'renplay:options':
        // This person's patches for the game (kept in its persistent data, so they follow the person
        // to every device) and Ren'Py's text size. Applied when the game is ready and after a load.
        exec(
          [
          "def _renplay_options(want, size, defaults):",
          "    import renpy",
          "    st = renpy.store",
          "    config = st.config",
          "    p = st.persistent",
          "    defaults = defaults or {}",
          "    stored = getattr(p, \"_renplay_patches\", None)",
          "    # Until the person chooses, the admin's defaults for everyone (never written to their data).",
          "    renpy._renplay_default_patches = dict((k, True) for k in (\"rollback\", \"skip\") if defaults.get(k))",
          "    cur = dict(stored) if stored is not None else dict(renpy._renplay_default_patches)",
          "    orig = getattr(renpy, \"_renplay_orig\", None)",
          "    if orig is None:",
          "        orig = renpy._renplay_orig = dict(rollback=config.rollback_enabled, hard=config.hard_rollback_limit, skip=config.allow_skipping, console=config.console)",
          "    off = []",
          "    if want:",
          "        for k in (\"rollback\", \"skip\", \"console\"):",
          "            if k in want:",
          "                if cur.get(k) and not want[k]:",
          "                    off.append(k)",
          "                cur[k] = bool(want[k])",
          "        p._renplay_patches = cur",
          "    def keep():",
          "        c = getattr(st.persistent, \"_renplay_patches\", None)",
          "        if c is None:",
          "            c = getattr(renpy, \"_renplay_default_patches\", {})",
          "        if c.get(\"rollback\"):",
          "            config.rollback_enabled = True",
          "            config.hard_rollback_limit = max(config.hard_rollback_limit, 100)",
          "        if c.get(\"skip\"):",
          "            config.allow_skipping = True",
          "            st._skipping = True",
          "        if c.get(\"console\"):",
          "            config.console = True",
          "            if st._console.console is None:",
          "                st._console.console = st._console.DebugConsole()",
          "                renpy._renplay_console_made = True",
          "    if \"rollback\" in off:",
          "        config.rollback_enabled = orig[\"rollback\"]",
          "        config.hard_rollback_limit = orig[\"hard\"]",
          "    if \"skip\" in off:",
          "        config.allow_skipping = orig[\"skip\"]",
          "    if \"console\" in off:",
          "        config.console = orig[\"console\"]",
          "        if getattr(renpy, \"_renplay_console_made\", False):",
          "            st._console.console = None",
          "            renpy._renplay_console_made = False",
          "    keep()",
          "    previous = getattr(renpy, \"_renplay_keep\", None)",
          "    config.after_load_callbacks = [f for f in config.after_load_callbacks if f is not previous] + [keep]",
          "    config.interact_callbacks = [f for f in config.interact_callbacks if f is not previous] + [keep]",
          "    renpy._renplay_keep = keep",
          "    chosen = getattr(p, \"_renplay_size_chosen\", False)",
          "    applied = getattr(p, \"_renplay_size_default\", None)",
          "    wanted = defaults.get(\"size\")",
          "    moved = False",
          "    if size is not None:",
          "        p._renplay_size_chosen = chosen = True",
          "    elif not chosen and wanted != applied:",
          "        # The admin's size once each time it changes, so the game's own text size setting still works.",
          "        if wanted:",
          "            size = wanted",
          "        elif st._preferences.font_size == applied:",
          "            size = 1.0",
          "        p._renplay_size_default = applied = wanted",
          "        moved = True",
          "    if size is not None:",
          "        st._preferences.font_size = float(size)",
          "        st.renpy.free_memory()",
          "        renpy.display.interface.display_reset = True",
          "        st.renpy.restart_interaction()",
          "    if want or chosen or moved:",
          "        st.renpy.save_persistent()",
          "    return dict(patches=cur, fontSize=st._preferences.font_size, patchesFrom=\"you\" if stored is not None or want else (\"admin\" if renpy._renplay_default_patches else \"default\"), sizeFrom=\"you\" if chosen else (\"admin\" if applied and st._preferences.font_size == applied else \"default\"))",
            'result = _renplay_options(' + patchArg(d.patches) + ', ' + sizeArg(d.fontSize) + ', ' + defaultsArg(d.defaults) + ')',
          ].join('\n'),
          6000,
        ).then(
          function (r) {
            post('options', { ok: true, patches: (r && r.patches) || {}, fontSize: r && r.fontSize, patchesFrom: r && r.patchesFrom, sizeFrom: r && r.sizeFrom })
          },
          function (er) {
            console.warn('[renplay] options', er)
            post('options', { ok: false })
          },
        )
        break
      case 'renplay:accessibility':
        // Ren'Py's own accessibility menu (shift+A), where the game offers it.
        exec('renpy.run(ToggleScreen("_accessibility"))\nrenpy.restart_interaction()\nresult = True', 4000).then(
          function () {
            post('accessibility', { ok: true })
          },
          function () {
            post('accessibility', { ok: false })
          },
        )
        break
      case 'renplay:load':
        loadSlot(d.slot).catch(function (er) {
          console.warn('[renplay] load failed', er)
        })
        break
      case 'renplay:reload-saves':
        fetchJSON(API + '/boot', { cache: 'no-store' }).then(function (b) {
          b.files.forEach(function (f) {
            var bytes = b64ToBytes(f.data)
            var k = state.known.get(f.path)
            if (k && k.hash === hash(bytes)) return
            writeLocal(f.path, bytes, f.mtime)
            state.known.set(f.path, { mtime: f.mtime, size: bytes.length, hash: hash(bytes) })
          })
          return exec('import renpy.loadsave as _rl\n_rl.location.scan()\nrenpy.restart_interaction()\nresult = True')
        })
        break
      case 'renplay:fullscreen-state':
        state.parentFullscreen = !!d.value
        break
      case 'renplay:mute':
        setMuted(d.value)
        break
      case 'renplay:download-log':
        try {
          var blob = new Blob([FS.readFile('/log.txt')], { type: 'text/plain' })
          var a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = cfg.id + '-log.txt'
          a.click()
          setTimeout(function () {
            URL.revokeObjectURL(a.href)
          }, 1000)
        } catch (e) {}
        break
      case 'renplay:focus':
        var c = document.getElementById('canvas')
        if (c) c.focus()
        window.focus()
        break
    }
  })

  // In fullscreen with Keyboard Lock, holding Esc leaves fullscreen; the
  // player shows for how long. Capture runs before the engine sees the key.
  window.addEventListener(
    'keydown',
    function (e) {
      if (e.key === 'Escape' && !e.repeat && state.parentFullscreen) post('escape', { down: true })
    },
    true,
  )
  window.addEventListener(
    'keyup',
    function (e) {
      if (e.key === 'Escape' && state.parentFullscreen) post('escape', { down: false })
    },
    true,
  )

  // Called after renpy-pre.js (see renderIndex), so this preRun runs first:
  // Emscripten runs preRun callbacks in reverse order of registration.
  window.__renplayLate = function () {
    Module.preRun.push(preRun)

    // game.zip is only read by the unpacker; free its memory (often hundreds
    // of MB) once Ren'Py moves on to loading the script.
    var freeGameZip = function () {
      try {
        FS.unlink('/game.zip')
        log('freed game.zip from memory')
      } catch (e) {}
    }
    var origPrint = Module.print
    Module.print = function (s) {
      if (typeof s === 'string' && s.indexOf('Loading script') === 0) {
        // Synchronous: Ren'Py reads the scripts only after this returns.
        try {
          restoreScripts()
        } catch (e) {
          console.warn('[renplay] could not restore compiled scripts', e)
        }
        setTimeout(freeGameZip, 0)
      }
      return origPrint ? origPrint.apply(this, arguments) : console.log(s)
    }

    var origPresplashEnd = window.presplashEnd
    window.presplashEnd = function () {
      if (origPresplashEnd) origPresplashEnd()
      post('ready')
      setTimeout(verifySaveDir, 500)
      setTimeout(uploadCaches, 10000)
    }

    var origProgress = window.progress
    var lastProgressPost = 0
    window.progress = function (done, total) {
      if (origProgress) origProgress(done, total)
      var now = Date.now()
      if (now - lastProgressPost > 100 || done >= total) {
        lastProgressPost = now
        post('progress', { done: done, total: total })
      }
    }

    var origAtExit = window.atExit
    window.atExit = function () {
      flush(4000).then(function () {
        if (inFrame) post('exited')
        else if (origAtExit) origAtExit()
      })
    }

    if (inFrame) {
      window.setFullscreen = function (enable) {
        post('fullscreen', { enable: !!enable })
      }
      window.isFullscreen = function () {
        return state.parentFullscreen ? 1 : 0
      }
    }
  }

  // Safety nets: periodic scan, and flush when the page is hidden.
  setInterval(function () {
    scan()
  }, 15000)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') scan()
  })
  window.addEventListener('pagehide', function () {
    scan()
  })

  window.__renplayRuntime = {
    state: state,
    pacing: pacing,
    flush: flush,
    scan: scan,
    loadSlot: loadSlot,
    autosave: autosave,
  }
})()
