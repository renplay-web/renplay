import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../../../runtime/renplay-runtime.js', import.meta.url), 'utf-8')
const vendor = readFileSync(new URL('../../../runtime/vendor/fake-indexeddb.js', import.meta.url), 'utf-8')
const htmlSource = readFileSync(new URL('../../../runtime/renplay-html.js', import.meta.url), 'utf-8')
function section(from: string, to: string): string { return source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from))) }

describe('runtime account isolation', () => {
  it('resends sandboxed HTML local storage after signing back in, even when the failed send cleared its dirty flag', () => {
    const post = vi.fn()
    const storage = htmlSource.slice(htmlSource.indexOf('  var local = {}'), htmlSource.indexOf('  var localStorageApi'))
    const resume = htmlSource.slice(htmlSource.indexOf("      case 'renplay:resume-sync':"), htmlSource.indexOf("      case 'renplay:flush':"))
    const runtime = new Function('post', 'setTimeout', 'clearTimeout', `
      var cfg = { userId: 1 }, has = Object.prototype.hasOwnProperty, idbDirty = false;
      function flushIdb() {}
      ${storage}
      return {
        change: function () { local.fixture = 'unsent'; changed() },
        send: sendStorage,
        resume: function (userId) { var d = { userId: userId }; switch ('renplay:resume-sync') { ${resume} } }
      };
    `)(post, setTimeout, clearTimeout)
    runtime.change(); runtime.send()
    expect(post).toHaveBeenCalledTimes(1)
    runtime.resume(2)
    expect(post).toHaveBeenCalledTimes(1)
    runtime.resume(1)
    expect(post).toHaveBeenCalledTimes(2)
    expect(post).toHaveBeenLastCalledWith('storage', { data: '{"fixture":"unsent"}' })
  })
  it('retries unacknowledged HTML IndexedDB snapshots and never acknowledges newer writes with an older snapshot', async () => {
    const window: any = { addEventListener() {} }
    runInNewContext(vendor, { window, structuredClone, setTimeout, clearTimeout, console, DOMException })
    const post = vi.fn(), retries: Array<() => void> = []
    const idb = htmlSource.slice(htmlSource.indexOf('  var IDB ='), htmlSource.indexOf('  // ------------------------------------------------------------- mute'))
    const ack = htmlSource.slice(htmlSource.indexOf("      case 'renplay:storage-kept':"), htmlSource.indexOf("      case 'renplay:resume-sync':"))
    const runtime = new Function('window', 'post', 'setTimeout', 'clearTimeout', 'setInterval', 'document', `
      var cfg = { userId: 1 }, has = Object.prototype.hasOwnProperty;
      function define() {} function sendStorage() {} var dirty = false, local = {};
      ${idb}
      return { factory: factory, flush: flushIdb, ack: function (data) {
        var d = { userId: 1, kind: 'idb', data: data }; switch ('renplay:storage-kept') { ${ack} }
      } };
    `)(window, post, setTimeout, clearTimeout, (fn: () => void) => retries.push(fn), { addEventListener() {} })
    const write = (value: string) => new Promise<void>((resolve, reject) => {
      const open = runtime.factory.open('saves', 1)
      open.onupgradeneeded = () => open.result.createObjectStore('slots')
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('slots', 'readwrite')
        tx.objectStore('slots').put(value, 'progress')
        tx.oncomplete = () => { db.close(); resolve() }
      }
    })
    await write('first'); await runtime.flush()
    const first = post.mock.calls.at(-1)![1].data
    expect(first).toContain('first')
    await runtime.flush() // Missing durable acknowledgement: a failed parent transaction must retry.
    expect(post).toHaveBeenCalledTimes(2)
    await write('second'); runtime.ack(first); await runtime.flush()
    const second = post.mock.calls.at(-1)![1].data
    expect(second).toContain('second')
    runtime.ack(first); await runtime.flush()
    expect(post).toHaveBeenCalledTimes(4)
    runtime.ack(second); await runtime.flush()
    expect(post).toHaveBeenCalledTimes(4)
    expect(retries).toHaveLength(1)
    await write('third'); retries[0]!()
    await vi.waitFor(() => expect(post.mock.calls.at(-1)![1].data).toContain('third'))
  })
  it('retains A’s offline writes through B playing and restores them only when A returns; keeps ambiguous legacy entries', async () => {
    const window: any = {}
    runInNewContext(vendor, { window, structuredClone, setTimeout, clearTimeout, console, DOMException })
    const indexedDB = new window.__renplayIDB.IDBFactory()
    window.indexedDB = indexedDB
    const post = vi.fn()
    const mirror = (id: number, legacySaveOwner: number | null = null) => new Function('window', 'indexedDB', 'cfg', 'post', 'console', section('  var dbPromise = null', '  // ---------------------------------------------------------------- helpers') + '\nreturn { idbPut, idbAll, idbMarkSynced, idbTx };')(window, indexedDB, { id: 'game', userId: id, legacySaveOwner }, post, { warn: vi.fn() })
    const a = mirror(1)
    await a.idbPut('Game/persistent', new Uint8Array([1]), 10, false)
    expect(await a.idbAll()).toMatchObject([{ key: '1:Game/persistent', userId: 1, synced: 0 }])
    await a.idbTx('readwrite', (store: any) => store.put({ key: 'legacy/path', path: 'legacy/path', synced: 0 }))
    const b = mirror(2)
    expect(await b.idbAll()).toEqual([])
    await b.idbPut('Game/persistent', new Uint8Array([2]), 11, false)
    expect(await b.idbAll()).toMatchObject([{ key: '2:Game/persistent', userId: 2, synced: 0 }])
    await b.idbMarkSynced('Game/persistent', 11)
    expect(await b.idbAll()).toMatchObject([{ synced: 1 }])
    expect(await mirror(1).idbAll()).toMatchObject([{ key: '1:Game/persistent', data: new Uint8Array([1]), synced: 0 }])
    const all = await a.idbTx('readonly', (store: any) => store.getAll())
    expect(all.some((entry: any) => entry.key === 'legacy/path')).toBe(true)
    expect(post).toHaveBeenCalledWith('legacy-saves', expect.objectContaining({ message: expect.stringContaining('kept') }))
    // A migrated single-user installation knows the legacy owner is 1, not the first arbitrary player.
    expect(await mirror(2, 1).idbAll()).toHaveLength(1)
    expect(await mirror(1, 1).idbAll()).toMatchObject([{ userId: 1 }, { key: '1:legacy/path', userId: 1, synced: 0 }])
    await a.idbTx('readwrite', (store: any) => store.put({ key: 'Game/persistent', path: 'Game/persistent', data: new Uint8Array([3]), synced: 0 }))
    expect((await mirror(1, 1).idbAll())[0].data).toEqual(new Uint8Array([1]))
    const conflicting = await a.idbTx('readonly', (store: any) => store.get('Game/persistent'))
    expect(conflicting).toMatchObject({ data: new Uint8Array([3]), synced: 0 })
    expect(post).toHaveBeenCalledWith('legacy-saves', expect.objectContaining({ message: expect.stringContaining('separately') }))
  })
  it('treats 401 as signed out, keeps the failed upload under that user, and stops retries rather than uploading into another account', async () => {
    const post = vi.fn(), fetch = vi.fn(async (_input: unknown, _init: any) => new Response('{}', { status: 401 })), put = vi.fn(), mark = vi.fn()
    const state = { inflight: false, queue: new Map([['Game/persistent', { data: new Uint8Array([1]), mtime: 1 }]]), base: new Map(), unanswered: new Map(), online: true, failures: 0 }
    const fn = new Function('window', 'cfg', 'post', 'state', 'status', 'idbPut', 'idbMarkSynced', 'Headers', 'Response', 'URL', 'location', 'currentBase', 'hash', `
      var API = '/api/saves/game';
      ${section('  var signedOut = false', "  var HOME = ")}
      ${section('  var nativeFetch = window.fetch.bind(window)', '  /**')}
      var fetch = origFetch;
      ${section('  function pump()', '  function flush(')}
      return { pump: pump, signedOut: function () { return signedOut } };
    `)
    const runtime = fn({ fetch }, { id: 'game', userId: 1 }, post, state, () => {}, put, mark, Headers, Response, URL, { href: 'http://renplay.test/g/game/b1/' }, () => null, () => 'h')
    runtime.pump()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(runtime.signedOut()).toBe(true)
    expect(state.queue.size).toBe(1)
    expect(post).toHaveBeenCalledWith('signed-out', { userId: 1 })
    expect(fetch.mock.calls[0]![1].headers.get('x-renplay-user')).toBe('1')
    runtime.pump()
    expect(fetch).toHaveBeenCalledTimes(1); expect(mark).not.toHaveBeenCalled()
  })
})
