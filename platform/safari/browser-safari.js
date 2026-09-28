/*******************************************************************************

    uBlock Origin - a comprehensive, efficient content blocker
    Copyright (C) 2014-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

// For every extension page: the background (Safari's global page), the
// toolbar popover, and pages opened in tabs or frames.
//
// WebKit gives Safari 7 extensions the parts of the WebExtensions `browser`
// namespace a browser engine owns: runtime messaging, webRequest,
// webNavigation, and the tab methods that act on a page's content. This file
// completes the namespace uBO expects with Safari's own extension API:
// tabs and windows as Safari shows them, the toolbar button, context menus,
// alarms, localization, and storage.

(( ) => {
'use strict';

const browser = self.browser;
if ( browser instanceof Object === false ) { return; }

const safari = self.safari;

// WebKit does not expose requestIdleCallback to web content; uBO schedules
// its idle-time work with it.
if ( typeof self.requestIdleCallback !== 'function' ) {
    self.requestIdleCallback = (callback, options) => {
        const start = Date.now();
        const timeout = options && options.timeout;
        return self.setTimeout(( ) => {
            callback({
                didTimeout: typeof timeout === 'number' && Date.now() - start >= timeout,
                timeRemaining: ( ) => Math.max(0, 50 - (Date.now() - start)),
            });
        }, 1);
    };
    self.cancelIdleCallback = id => { self.clearTimeout(id); };
}

/******************************************************************************/

class Event {
    constructor() {
        this.listeners = [];
    }
    addListener(callback) {
        if ( typeof callback !== 'function' ) { return; }
        if ( this.listeners.includes(callback) ) { return; }
        this.listeners.push(callback);
    }
    removeListener(callback) {
        const i = this.listeners.indexOf(callback);
        if ( i !== -1 ) { this.listeners.splice(i, 1); }
    }
    hasListener(callback) {
        return this.listeners.includes(callback);
    }
    hasListeners() {
        return this.listeners.length !== 0;
    }
    fire(...args) {
        for ( const callback of this.listeners.slice() ) {
            try {
                callback(...args);
            } catch (ex) {
                console.error(ex);
            }
        }
    }
}

// Methods return promises and also accept a trailing callback, as Chrome's do.
// `inOrder` methods act before returning.
const inOrder = fn => function(...args) {
    const callback = typeof args[args.length - 1] === 'function'
        ? args.pop()
        : undefined;
    let promise;
    try {
        promise = Promise.resolve(fn(...args));
    } catch (error) {
        promise = Promise.reject(error);
    }
    if ( callback === undefined ) { return promise; }
    promise.then(callback, ( ) => { callback(); });
};

const api = fn => function(...args) {
    const callback = typeof args[args.length - 1] === 'function'
        ? args.pop()
        : undefined;
    const promise = Promise.resolve().then(( ) => fn(...args));
    if ( callback === undefined ) { return promise; }
    promise.then(callback, ( ) => { callback(); });
};

/******************************************************************************/

// safari-extension://<extension>/<per-launch token>/

const baseURI = (( ) => {
    const uri = safari && safari.extension && safari.extension.baseURI;
    if ( typeof uri === 'string' && uri !== '' ) { return uri; }
    const match = /^safari-extension:\/\/[^/]+\/[^/]+\//.exec(location.href);
    return match !== null ? match[0] : location.href;
})();

const getURL = path => baseURI + String(path || '').replace(/^\/+/, '');

const readResource = path => {
    const xhr = new XMLHttpRequest();
    xhr.overrideMimeType('text/plain;charset=utf-8');
    xhr.open('GET', getURL(path), false);
    try {
        xhr.send();
    } catch {
        return null;
    }
    return xhr.status === 200 || xhr.status === 0 ? xhr.responseText : null;
};

let manifest;
const getManifest = ( ) => {
    if ( manifest === undefined ) {
        manifest = JSON.parse(readResource('manifest.json') || '{}');
    }
    return manifest;
};

const resolveExtensionURL = url => /^[\w-]{2,}:/.test(url) ? url : getURL(url);

/******************************************************************************/

// runtime

Object.assign(browser.runtime, {
    id: new URL(baseURI).host,
    getURL,
    getManifest,
    onInstalled: new Event(),
    onStartup: new Event(),
    onUpdateAvailable: new Event(),
});

/******************************************************************************/

// i18n
//
// Chrome's lookup: the user's locale, then its language, then the default
// locale; placeholders, then $1..$9 substitutions.

browser.i18n = (( ) => {
    const uiLanguage = navigator.language || 'en';
    const catalogs = [];
    const seen = new Set();
    const addCatalog = locale => {
        if ( seen.has(locale) ) { return; }
        seen.add(locale);
        const text = readResource(`_locales/${locale}/messages.json`);
        if ( text === null ) { return; }
        try {
            const messages = JSON.parse(text);
            const catalog = new Map();
            for ( const [ name, entry ] of Object.entries(messages) ) {
                catalog.set(name.toLowerCase(), entry);
            }
            catalogs.push(catalog);
        } catch {
        }
    };
    // Only the locales the extension has: a missing one would be a failed load.
    const available = new Set(JSON.parse(readResource('_locales/locales.json') || '[]'));
    const locale = uiLanguage.replace('-', '_');
    for ( const candidate of [ locale, locale.split('_')[0], getManifest().default_locale || 'en' ] ) {
        if ( available.has(candidate) ) { addCatalog(candidate); }
    }

    const predefined = {
        '@@extension_id': ( ) => browser.runtime.id,
        '@@ui_locale': ( ) => locale,
        '@@bidi_dir': ( ) => 'ltr',
        '@@bidi_reversed_dir': ( ) => 'rtl',
        '@@bidi_start_edge': ( ) => 'left',
        '@@bidi_end_edge': ( ) => 'right',
    };

    const getMessage = (name, substitutions) => {
        if ( typeof name !== 'string' ) { return ''; }
        if ( Object.hasOwn(predefined, name) ) { return predefined[name](); }
        const key = name.toLowerCase();
        let entry;
        for ( const catalog of catalogs ) {
            entry = catalog.get(key);
            if ( entry !== undefined ) { break; }
        }
        if ( entry === undefined || typeof entry.message !== 'string' ) {
            return '';
        }
        if ( substitutions !== undefined && Array.isArray(substitutions) === false ) {
            substitutions = [ substitutions ];
        }
        const placeholders = entry.placeholders || {};
        let message = entry.message.replace(/\$([a-z0-9_@]+)\$/gi, (s, placeholder) => {
            const p = placeholders[placeholder.toLowerCase()];
            return p && typeof p.content === 'string' ? p.content : s;
        });
        message = message.replace(/\$(\$|[1-9])/g, (s, which) => {
            if ( which === '$' ) { return '$'; }
            const value = substitutions && substitutions[which - 1];
            return value !== undefined ? String(value) : '';
        });
        return message;
    };

    return {
        getMessage,
        getUILanguage: ( ) => uiLanguage,
        getAcceptLanguages: api(( ) => navigator.languages ? Array.from(navigator.languages) : [ uiLanguage ]),
        detectLanguage: api(( ) => ({ isReliable: false, languages: [] })),
    };
})();

/******************************************************************************/

// BroadcastChannel between extension pages. Safari runs the background and
// the toolbar popover in its own process and pages opened in tabs in web
// content processes; a channel reaches the other pages through runtime
// messaging.

{
    const channels = new Map();
    const deliver = (name, data, except) => {
        const set = channels.get(name);
        if ( set === undefined ) { return; }
        for ( const channel of set ) {
            if ( channel === except ) { continue; }
            setTimeout(( ) => {
                if ( channel.closed ) { return; }
                const event = new MessageEvent('message', { data: structuredClone(data) });
                channel.dispatchEvent(event);
                if ( typeof channel.onmessage === 'function' ) {
                    channel.onmessage(event);
                }
            });
        }
    };
    const WHAT = 'uBO:broadcast-channel';
    browser.runtime.onMessage.addListener(message => {
        if ( message instanceof Object === false ) { return; }
        if ( message.what !== WHAT ) { return; }
        deliver(message.name, message.data, null);
    });
    self.BroadcastChannel = class BroadcastChannel extends EventTarget {
        constructor(name) {
            super();
            this.name = String(name);
            this.onmessage = null;
            this.onmessageerror = null;
            this.closed = false;
            let set = channels.get(this.name);
            if ( set === undefined ) {
                set = new Set();
                channels.set(this.name, set);
            }
            set.add(this);
        }
        postMessage(data) {
            if ( this.closed ) {
                throw new DOMException('BroadcastChannel is closed', 'InvalidStateError');
            }
            deliver(this.name, data, this);
            browser.runtime.sendMessage({ what: WHAT, name: this.name, data }).catch(( ) => { });
        }
        close() {
            this.closed = true;
            const set = channels.get(this.name);
            if ( set !== undefined ) { set.delete(this); }
        }
    };
}

/******************************************************************************/

// Toolbar popover: sized to its content's preferred size, as a browser sizes
// an extension popup, and closed by window.close().

if ( safari && safari.self && typeof safari.self.hide === 'function' ) {
    const popover = safari.self;
    self.close = ( ) => { popover.hide(); };
    const resize = ( ) => {
        const root = document.documentElement;
        if ( root === null ) { return; }
        const rect = root.getBoundingClientRect();
        const width = Math.ceil(rect.width);
        const height = Math.ceil(rect.height);
        if ( width !== 0 && popover.width !== width ) { popover.width = width; }
        if ( height !== 0 && popover.height !== height ) { popover.height = height; }
    };
    self.addEventListener('DOMContentLoaded', ( ) => {
        document.documentElement.style.setProperty('width', 'max-content');
        new ResizeObserver(resize).observe(document.documentElement);
        resize();
    }, { once: true });
}

/******************************************************************************/

// Everything below exists in the background only: Safari's global page is
// the one context with the whole Safari application API.

if (
    safari instanceof Object === false ||
    safari.application instanceof Object === false ||
    safari.extension instanceof Object === false ||
    safari.extension.globalPage instanceof Object === false ||
    safari.extension.globalPage.contentWindow !== self
) {
    return;
}

const application = safari.application;
const extension = safari.extension;

browser.runtime.reload = ( ) => { location.reload(); };

/******************************************************************************/

// storage.local
//
// One IndexedDB record per key, so a write touches only what changed, and an
// in-memory image of every value read or written, so writing a value that is
// already stored touches nothing at all.

browser.storage = (( ) => {
    const DB_NAME = 'browser.storage.local';
    const STORE = 'items';
    const cache = new Map();
    let allCached = false;
    let dbPromise;

    const db = ( ) => {
        if ( dbPromise !== undefined ) { return dbPromise; }
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = ( ) => {
                request.result.createObjectStore(STORE);
            };
            request.onsuccess = ( ) => { resolve(request.result); };
            request.onerror = ( ) => { reject(request.error); };
        });
        return dbPromise;
    };

    const transaction = async (mode, work) => {
        const database = await db();
        return new Promise((resolve, reject) => {
            const tx = database.transaction(STORE, mode);
            const store = tx.objectStore(STORE);
            const result = work(store);
            tx.oncomplete = ( ) => { resolve(result); };
            tx.onerror = ( ) => { reject(tx.error); };
            tx.onabort = ( ) => { reject(tx.error); };
        });
    };

    const clone = value => value instanceof Object ? structuredClone(value) : value;

    const sameValue = (a, b) => {
        if ( a === b ) { return true; }
        if ( a instanceof Object === false || b instanceof Object === false ) {
            return false;
        }
        try {
            return JSON.stringify(a) === JSON.stringify(b);
        } catch {
            return false;
        }
    };

    const onChanged = new Event();

    const loadAll = async ( ) => {
        if ( allCached ) { return; }
        await transaction('readonly', store => {
            const request = store.openCursor();
            request.onsuccess = ( ) => {
                const cursor = request.result;
                if ( cursor === null ) { return; }
                if ( cache.has(cursor.key) === false ) {
                    cache.set(cursor.key, cursor.value);
                }
                cursor.continue();
            };
        });
        allCached = true;
    };

    const loadKeys = async keys => {
        const missing = allCached ? [] : keys.filter(k => cache.has(k) === false);
        if ( missing.length === 0 ) { return; }
        const found = new Map();
        await transaction('readonly', store => {
            for ( const key of missing ) {
                const request = store.get(key);
                request.onsuccess = ( ) => {
                    if ( request.result !== undefined ) {
                        found.set(key, request.result);
                    }
                };
            }
        });
        for ( const [ key, value ] of found ) {
            if ( cache.has(key) === false ) { cache.set(key, value); }
        }
    };

    const local = {
        get: api(async keys => {
            const out = {};
            if ( keys === null || keys === undefined ) {
                await loadAll();
                for ( const [ key, value ] of cache ) {
                    out[key] = clone(value);
                }
                return out;
            }
            let defaults = {};
            if ( typeof keys === 'string' ) {
                keys = [ keys ];
            } else if ( Array.isArray(keys) === false ) {
                defaults = keys;
                keys = Object.keys(keys);
            }
            await loadKeys(keys);
            for ( const key of keys ) {
                if ( cache.has(key) ) {
                    out[key] = clone(cache.get(key));
                } else if ( Object.hasOwn(defaults, key) ) {
                    out[key] = defaults[key];
                }
            }
            return out;
        }),
        set: api(async items => {
            const changes = {};
            const writes = [];
            for ( const [ key, value ] of Object.entries(items || {}) ) {
                if ( value === undefined ) { continue; }
                const oldValue = cache.get(key);
                if ( cache.has(key) && sameValue(oldValue, value) ) { continue; }
                const newValue = clone(value);
                cache.set(key, newValue);
                writes.push([ key, newValue ]);
                changes[key] = { oldValue, newValue };
            }
            if ( writes.length === 0 ) { return; }
            await transaction('readwrite', store => {
                for ( const [ key, value ] of writes ) {
                    store.put(value, key);
                }
            });
            onChanged.fire(changes, 'local');
        }),
        remove: api(async keys => {
            if ( typeof keys === 'string' ) { keys = [ keys ]; }
            const changes = {};
            for ( const key of keys ) {
                if ( cache.has(key) ) {
                    changes[key] = { oldValue: cache.get(key) };
                }
                cache.delete(key);
            }
            await transaction('readwrite', store => {
                for ( const key of keys ) { store.delete(key); }
            });
            if ( Object.keys(changes).length !== 0 ) {
                onChanged.fire(changes, 'local');
            }
        }),
        clear: api(async ( ) => {
            cache.clear();
            allCached = true;
            await transaction('readwrite', store => { store.clear(); });
        }),
        getBytesInUse: api(async keys => {
            const bin = await local.get(keys === undefined ? null : keys);
            let bytes = 0;
            for ( const [ key, value ] of Object.entries(bin) ) {
                bytes += key.length;
                bytes += typeof value === 'string'
                    ? value.length
                    : JSON.stringify(value).length;
            }
            return bytes;
        }),
    };

    return { local, onChanged };
})();

/******************************************************************************/

// Tabs and windows
//
// WebKit identifies a tab by its page, which is what webRequest, webNavigation
// and runtime messages carry; Safari identifies it by a SafariBrowserTab. The
// top frame of every page with uBO's content scripts introduces itself through
// both channels with the same token, which ties the two together.

const nativeTabs = Object.assign({}, browser.tabs);

const isSafariWindow = target => target instanceof Object && 'activeTab' in target && 'tabs' in target;
const isSafariTab = target => target instanceof Object && 'browserWindow' in target && 'page' in target;

const safariTabByID = new Map();
const idBySafariTab = new Map();
const windowIDs = new Map();
const windowByID = new Map();
let nextWindowID = 1;
const tabStatus = new Map();

const idForWindow = win => {
    if ( win instanceof Object === false ) { return browser.windows.WINDOW_ID_NONE; }
    let id = windowIDs.get(win);
    if ( id === undefined ) {
        id = nextWindowID++;
        windowIDs.set(win, id);
        windowByID.set(id, win);
    }
    return id;
};

const bindTab = (tabID, safariTab) => {
    const previous = idBySafariTab.get(safariTab);
    if ( previous !== undefined && previous !== tabID ) {
        safariTabByID.delete(previous);
    }
    const previousTab = safariTabByID.get(tabID);
    if ( previousTab !== undefined && previousTab !== safariTab ) {
        idBySafariTab.delete(previousTab);
    }
    safariTabByID.set(tabID, safariTab);
    idBySafariTab.set(safariTab, tabID);
};

const unbindTab = tabID => {
    const safariTab = safariTabByID.get(tabID);
    if ( safariTab !== undefined ) { idBySafariTab.delete(safariTab); }
    safariTabByID.delete(tabID);
    tabStatus.delete(tabID);
};

{
    const IDENTITY = 'uBO:tab-identity';
    const fromPage = new Map();
    const fromSafari = new Map();
    const settle = token => {
        const tabID = fromPage.get(token);
        const safariTab = fromSafari.get(token);
        if ( tabID === undefined || safariTab === undefined ) { return; }
        fromPage.delete(token);
        fromSafari.delete(token);
        bindTab(tabID, safariTab);
        browserActionUpdate();
    };
    browser.runtime.onMessage.addListener((message, sender) => {
        if ( message instanceof Object === false ) { return; }
        if ( message.what !== IDENTITY ) { return; }
        if ( sender.tab instanceof Object === false ) { return; }
        fromPage.set(message.token, sender.tab.id);
        settle(message.token);
    });
    application.addEventListener('message', ev => {
        if ( ev.name !== IDENTITY ) { return; }
        fromSafari.set(ev.message, ev.target);
        settle(ev.message);
    }, true);
}

const liveSafariTabs = function*() {
    for ( const win of application.browserWindows ) {
        for ( const tab of win.tabs ) {
            yield tab;
        }
    }
};

const tabFromSafariTab = (safariTab, id) => {
    const win = safariTab.browserWindow;
    const tabs = win ? Array.from(win.tabs) : [];
    return {
        id,
        windowId: idForWindow(win),
        index: tabs.indexOf(safariTab),
        active: win !== undefined && win.activeTab === safariTab,
        highlighted: win !== undefined && win.activeTab === safariTab,
        url: safariTab.url || '',
        title: safariTab.title || '',
        status: tabStatus.get(id) || 'complete',
        incognito: false,
        discarded: false,
        pinned: false,
        audible: false,
    };
};

const tabFromID = async id => {
    const safariTab = safariTabByID.get(id);
    if ( safariTab !== undefined && safariTab.browserWindow ) {
        return tabFromSafariTab(safariTab, id);
    }
    let tab;
    try {
        tab = await nativeTabs.get(id);
    } catch {
    }
    if ( tab instanceof Object === false ) { return; }
    return Object.assign({
        windowId: browser.windows.WINDOW_ID_NONE,
        index: -1,
        active: false,
        highlighted: false,
        discarded: false,
        pinned: false,
        audible: false,
    }, tab);
};

const compilePatterns = patterns => {
    if ( patterns === undefined ) { return; }
    if ( Array.isArray(patterns) === false ) { patterns = [ patterns ]; }
    return patterns.map(pattern => {
        if ( pattern === '<all_urls>' ) { return /^[a-z-]+:/; }
        const match = /^(\*|[a-z][a-z0-9+.-]*):\/\/(\*|\*\.[^/*]+|[^/*]+)?(\/.*)$/.exec(pattern);
        if ( match === null ) { return /(?!)/; }
        const [ , scheme, host = '', path ] = match;
        const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const schemeSource = scheme === '*' ? 'https?' : escape(scheme);
        const hostSource = host === '*'
            ? '[^/]*'
            : host.startsWith('*.')
                ? `(?:[^/]*\\.)?${escape(host.slice(2))}`
                : escape(host);
        const pathSource = path.split('*').map(escape).join('.*');
        return new RegExp(`^${schemeSource}://${hostSource}(?::\\d+)?${pathSource}$`);
    });
};

browser.windows = {
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,
    onCreated: new Event(),
    onRemoved: new Event(),
    onFocusChanged: new Event(),
};

const windowFromSafariWindow = win => ({
    id: idForWindow(win),
    focused: application.activeBrowserWindow === win,
    alwaysOnTop: false,
    incognito: false,
    state: 'normal',
    type: 'normal',
});

const safariWindowFromID = id => {
    if ( id === browser.windows.WINDOW_ID_CURRENT ) {
        return application.activeBrowserWindow;
    }
    return windowByID.get(id);
};

Object.assign(browser.windows, {
    get: api(id => {
        const win = safariWindowFromID(id);
        if ( win === undefined ) { throw new Error(`No window with id: ${id}.`); }
        return windowFromSafariWindow(win);
    }),
    getCurrent: api(( ) => windowFromSafariWindow(application.activeBrowserWindow)),
    getLastFocused: api(( ) => windowFromSafariWindow(application.activeBrowserWindow)),
    getAll: api(( ) => Array.from(application.browserWindows).map(windowFromSafariWindow)),
    create: api((details = {}) => {
        const win = application.openBrowserWindow();
        const urls = Array.isArray(details.url) ? details.url : [ details.url ];
        urls.filter(url => typeof url === 'string').forEach((url, i) => {
            const tab = i === 0 ? win.activeTab : win.openTab('background');
            tab.url = resolveExtensionURL(url);
        });
        if ( details.focused !== false ) { win.activate(); }
        return windowFromSafariWindow(win);
    }),
    update: api((id, details = {}) => {
        const win = safariWindowFromID(id);
        if ( win === undefined ) { throw new Error(`No window with id: ${id}.`); }
        if ( details.focused ) { win.activate(); }
        return windowFromSafariWindow(win);
    }),
    remove: api(id => {
        const win = safariWindowFromID(id);
        if ( win !== undefined ) { win.close(); }
    }),
});

const tabsQuery = queryInfo => {
    const q = queryInfo || {};
    const urlPatterns = compilePatterns(q.url);
    const currentWindow = application.activeBrowserWindow;
    const out = [];
    for ( const safariTab of liveSafariTabs() ) {
        const id = idBySafariTab.get(safariTab);
        if ( id === undefined ) { continue; }
        const tab = tabFromSafariTab(safariTab, id);
        const win = safariTab.browserWindow;
        if ( typeof q.active === 'boolean' && tab.active !== q.active ) { continue; }
        if ( typeof q.highlighted === 'boolean' && tab.highlighted !== q.highlighted ) { continue; }
        if ( q.currentWindow === true && win !== currentWindow ) { continue; }
        if ( q.currentWindow === false && win === currentWindow ) { continue; }
        if ( q.lastFocusedWindow === true && win !== currentWindow ) { continue; }
        if ( typeof q.windowId === 'number' ) {
            const wanted = q.windowId === browser.windows.WINDOW_ID_CURRENT
                ? idForWindow(currentWindow)
                : q.windowId;
            if ( tab.windowId !== wanted ) { continue; }
        }
        if ( typeof q.status === 'string' && tab.status !== q.status ) { continue; }
        if ( q.discarded === true ) { continue; }
        if ( typeof q.index === 'number' && tab.index !== q.index ) { continue; }
        if ( typeof q.title === 'string' && tab.title !== q.title ) { continue; }
        if ( urlPatterns !== undefined && urlPatterns.some(re => re.test(tab.url)) === false ) {
            continue;
        }
        out.push(tab);
    }
    return out;
};

Object.assign(browser.tabs, {
    TAB_ID_NONE: -1,
    get: api(async id => {
        const tab = await tabFromID(id);
        if ( tab === undefined ) { throw new Error(`No tab with id: ${id}.`); }
        return tab;
    }),
    getCurrent: api(( ) => undefined),
    query: api(tabsQuery),
    create: api((details = {}) => {
        let win = safariWindowFromID(details.windowId);
        if ( win === undefined ) { win = application.activeBrowserWindow; }
        if ( win === undefined || win === null ) { win = application.openBrowserWindow(); }
        const active = details.active !== false;
        const tabCount = win.tabs.length;
        const index = typeof details.index === 'number' && details.index >= 0 && details.index < tabCount
            ? details.index
            : undefined;
        const safariTab = index !== undefined
            ? win.openTab(active ? 'foreground' : 'background', index)
            : win.openTab(active ? 'foreground' : 'background');
        if ( typeof details.url === 'string' ) {
            safariTab.url = resolveExtensionURL(details.url);
        }
        return {
            windowId: idForWindow(win),
            index: Array.from(win.tabs).indexOf(safariTab),
            active,
            highlighted: active,
            url: safariTab.url || '',
            title: '',
            status: 'loading',
            incognito: false,
            discarded: false,
            pinned: false,
        };
    }),
    update: api(async (id, details = {}) => {
        if ( typeof id !== 'number' ) {
            const current = tabsQuery({ active: true, currentWindow: true });
            if ( current.length === 0 ) { throw new Error('No current tab.'); }
            id = current[0].id;
        }
        const safariTab = safariTabByID.get(id);
        if ( typeof details.url === 'string' ) {
            const url = resolveExtensionURL(details.url);
            if ( safariTab !== undefined ) {
                safariTab.url = url;
            } else {
                await nativeTabs.update(id, { url });
            }
        }
        if ( details.active === true || details.highlighted === true ) {
            if ( safariTab !== undefined ) { safariTab.activate(); }
        }
        return tabFromID(id);
    }),
    remove: api(async ids => {
        if ( Array.isArray(ids) === false ) { ids = [ ids ]; }
        const remaining = [];
        for ( const id of ids ) {
            const safariTab = safariTabByID.get(id);
            if ( safariTab !== undefined ) {
                safariTab.close();
            } else {
                remaining.push(id);
            }
        }
        if ( remaining.length !== 0 ) {
            await nativeTabs.remove(remaining);
        }
    }),
    move: api((ids, details = {}) => {
        const single = Array.isArray(ids) === false;
        if ( single ) { ids = [ ids ]; }
        const moved = [];
        for ( const id of ids ) {
            const safariTab = safariTabByID.get(id);
            if ( safariTab === undefined ) { continue; }
            const win = safariWindowFromID(details.windowId) || safariTab.browserWindow;
            const tabs = Array.from(win.tabs);
            const index = typeof details.index === 'number' && details.index >= 0
                ? details.index
                : tabs.length;
            win.insertTab(safariTab, index);
            moved.push(tabFromSafariTab(safariTab, id));
        }
        return single ? moved[0] : moved;
    }),
    onActivated: new Event(),
});

browser.tabs.onRemoved.addListener(tabID => {
    unbindTab(tabID);
});

browser.tabs.onUpdated.addListener((tabID, changeInfo) => {
    if ( typeof changeInfo.status === 'string' ) {
        tabStatus.set(tabID, changeInfo.status);
    }
});

application.addEventListener('activate', ev => {
    const target = ev.target;
    if ( isSafariWindow(target) ) {
        browser.windows.onFocusChanged.fire(idForWindow(target));
        const tabID = idBySafariTab.get(target.activeTab);
        if ( tabID !== undefined ) {
            browser.tabs.onActivated.fire({ tabId: tabID, windowId: idForWindow(target) });
        }
    } else if ( isSafariTab(target) ) {
        const tabID = idBySafariTab.get(target);
        if ( tabID !== undefined ) {
            browser.tabs.onActivated.fire({ tabId: tabID, windowId: idForWindow(target.browserWindow) });
        }
    }
    browserActionUpdate();
}, true);

application.addEventListener('open', ev => {
    if ( isSafariWindow(ev.target) ) {
        browser.windows.onCreated.fire(windowFromSafariWindow(ev.target));
    }
}, true);

application.addEventListener('close', ev => {
    const target = ev.target;
    if ( isSafariWindow(target) ) {
        const id = windowIDs.get(target);
        if ( id !== undefined ) {
            windowIDs.delete(target);
            windowByID.delete(id);
            browser.windows.onRemoved.fire(id);
        }
    } else if ( isSafariTab(target) ) {
        const id = idBySafariTab.get(target);
        if ( id !== undefined ) { idBySafariTab.delete(target); safariTabByID.delete(id); }
    }
}, true);

/******************************************************************************/

// browserAction
//
// Safari 7 has one toolbar button per window, a numeric badge, and template
// icons; the state shown is that of the window's active tab.

const browserActionUpdate = (( ) => {
    const defaults = {
        title: '',
        badgeText: '',
        enabled: true,
    };
    const perTab = new Map();

    const iconForPath = path => {
        const value = path instanceof Object
            ? path[Object.keys(path)[0]]
            : path;
        return typeof value === 'string' && /-off\b|off\./.test(value)
            ? 'img/browsericons/safari-icon16-off.png'
            : 'img/browsericons/safari-icon16.png';
    };

    const badgeNumber = text => {
        if ( typeof text !== 'string' || text === '' ) { return 0; }
        const match = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(text.trim());
        if ( match === null ) { return 0; }
        const scale = match[2] === '' ? 1 : /k/i.test(match[2]) ? 1000 : 1000000;
        return Math.round(parseFloat(match[1]) * scale);
    };

    const stateFor = tabID => Object.assign({}, defaults, perTab.get(tabID));

    const update = ( ) => {
        for ( const item of extension.toolbarItems ) {
            const win = item.browserWindow;
            const tabID = win && win.activeTab
                ? idBySafariTab.get(win.activeTab)
                : undefined;
            const state = stateFor(tabID);
            const image = getURL(state.icon || defaults.icon || iconForPath());
            if ( item.image !== image ) { item.image = image; }
            const badge = badgeNumber(state.badgeText);
            if ( item.badge !== badge ) { item.badge = badge; }
            if ( item.toolTip !== state.title ) { item.toolTip = state.title; }
            if ( item.disabled !== (state.enabled === false) ) {
                item.disabled = state.enabled === false;
            }
        }
    };

    const setter = mutate => api((details = {}) => {
        const target = typeof details.tabId === 'number'
            ? (perTab.get(details.tabId) || perTab.set(details.tabId, {}).get(details.tabId))
            : defaults;
        mutate(target, details);
        update();
    });

    browser.tabs.onRemoved.addListener(tabID => { perTab.delete(tabID); });
    application.addEventListener('validate', update, true);

    browser.browserAction = {
        setTitle: setter((state, details) => { state.title = details.title || ''; }),
        setBadgeText: setter((state, details) => { state.badgeText = details.text || ''; }),
        setBadgeBackgroundColor: setter(( ) => { }),
        setBadgeTextColor: setter(( ) => { }),
        setIcon: setter((state, details) => { state.icon = iconForPath(details.path); }),
        enable: api(tabID => {
            const state = typeof tabID === 'number' ? (perTab.get(tabID) || perTab.set(tabID, {}).get(tabID)) : defaults;
            state.enabled = true;
            update();
        }),
        disable: api(tabID => {
            const state = typeof tabID === 'number' ? (perTab.get(tabID) || perTab.set(tabID, {}).get(tabID)) : defaults;
            state.enabled = false;
            update();
        }),
        onClicked: new Event(),
    };

    return update;
})();

// The popover shows the tab it opens over: reload it each time it opens.
application.addEventListener('popover', ev => {
    const popover = ev.target;
    if ( popover && popover.contentWindow ) {
        popover.contentWindow.location.reload();
    }
}, true);

/******************************************************************************/

// Context menus
//
// The content script tells Safari what was clicked (vapi-client-safari.js);
// Safari asks the global page which items to show for it.

browser.menus = browser.contextMenus = (( ) => {
    const PREFIX = 'uBO-menu:';
    const entries = new Map();
    const onClicked = new Event();
    let nextID = 1;

    const matches = (entry, info) => {
        const contexts = entry.contexts || [ 'page' ];
        const infoContexts = info.contexts || [ 'page' ];
        if (
            contexts.includes('all') === false &&
            contexts.some(c => infoContexts.includes(c)) === false
        ) {
            return false;
        }
        const docPatterns = compilePatterns(entry.documentUrlPatterns);
        if ( docPatterns !== undefined ) {
            const url = info.frameUrl || info.pageUrl || '';
            if ( docPatterns.some(re => re.test(url)) === false ) { return false; }
        }
        const targetPatterns = compilePatterns(entry.targetUrlPatterns);
        if ( targetPatterns !== undefined ) {
            const url = info.srcUrl || info.linkUrl || '';
            if ( targetPatterns.some(re => re.test(url)) === false ) { return false; }
        }
        return true;
    };

    application.addEventListener('contextmenu', ev => {
        const info = ev.userInfo || {};
        for ( const [ id, entry ] of entries ) {
            if ( entry.visible === false ) { continue; }
            if ( matches(entry, info) === false ) { continue; }
            ev.contextMenu.appendContextMenuItem(PREFIX + id, entry.title || '');
        }
    }, false);

    application.addEventListener('command', ev => {
        if ( typeof ev.command !== 'string' ) { return; }
        if ( ev.command.startsWith(PREFIX) === false ) { return; }
        const id = ev.command.slice(PREFIX.length);
        const entry = entries.get(id) || entries.get(Number(id));
        if ( entry === undefined ) { return; }
        const info = Object.assign({}, ev.userInfo || {}, {
            menuItemId: entry.id,
            editable: (ev.userInfo || {}).editable === true,
        });
        delete info.contexts;
        const win = application.activeBrowserWindow;
        const safariTab = win && win.activeTab;
        const tabID = safariTab ? idBySafariTab.get(safariTab) : undefined;
        const tab = tabID !== undefined ? tabFromSafariTab(safariTab, tabID) : undefined;
        onClicked.fire(info, tab);
    }, false);

    return {
        create(properties, callback) {
            const id = properties.id !== undefined ? properties.id : nextID++;
            entries.set(String(id), Object.assign({}, properties, { id }));
            if ( typeof callback === 'function' ) { callback(); }
            return id;
        },
        // Menu changes take effect in the order they are made, as a browser
        // applies them: removeAll() then create() leaves the new items.
        update: inOrder((id, properties) => {
            const entry = entries.get(String(id));
            if ( entry !== undefined ) { Object.assign(entry, properties); }
        }),
        remove: inOrder(id => { entries.delete(String(id)); }),
        removeAll: inOrder(( ) => { entries.clear(); }),
        onClicked,
    };
})();

/******************************************************************************/

// Alarms

browser.alarms = (( ) => {
    const alarms = new Map();
    const onAlarm = new Event();

    const clear = name => {
        const alarm = alarms.get(name);
        if ( alarm === undefined ) { return false; }
        clearTimeout(alarm.timer);
        alarms.delete(name);
        return true;
    };

    const schedule = alarm => {
        const delay = Math.max(0, alarm.scheduledTime - Date.now());
        alarm.timer = setTimeout(( ) => {
            if ( alarm.periodInMinutes !== undefined ) {
                alarm.scheduledTime = Date.now() + alarm.periodInMinutes * 60000;
                schedule(alarm);
            } else {
                alarms.delete(alarm.name);
            }
            onAlarm.fire(describe(alarm));
        }, Math.min(delay, 0x7FFFFFFF));
    };

    const describe = alarm => {
        const out = { name: alarm.name, scheduledTime: alarm.scheduledTime };
        if ( alarm.periodInMinutes !== undefined ) {
            out.periodInMinutes = alarm.periodInMinutes;
        }
        return out;
    };

    return {
        create: api((name, info) => {
            if ( typeof name !== 'string' ) { info = name; name = ''; }
            info = info || {};
            clear(name);
            const alarm = { name, periodInMinutes: info.periodInMinutes };
            if ( typeof info.when === 'number' ) {
                alarm.scheduledTime = info.when;
            } else {
                const minutes = info.delayInMinutes !== undefined
                    ? info.delayInMinutes
                    : info.periodInMinutes || 0;
                alarm.scheduledTime = Date.now() + minutes * 60000;
            }
            alarms.set(name, alarm);
            schedule(alarm);
        }),
        get: api((name = '') => {
            const alarm = alarms.get(name);
            return alarm !== undefined ? describe(alarm) : undefined;
        }),
        getAll: api(( ) => Array.from(alarms.values()).map(describe)),
        clear: api((name = '') => clear(name)),
        clearAll: api(( ) => {
            const had = alarms.size !== 0;
            for ( const name of Array.from(alarms.keys()) ) { clear(name); }
            return had;
        }),
        onAlarm,
    };
})();

/******************************************************************************/

// contentScripts.register (Firefox's API): Safari's own dynamic content
// scripts, which run in the extension's content-script world at the time
// asked for, from the first document a matching page loads.

const safariPatterns = patterns => {
    const out = [];
    for ( const pattern of patterns || [] ) {
        if ( pattern === '<all_urls>' ) {
            out.push('http://*/*', 'https://*/*');
        } else if ( pattern.startsWith('*://') ) {
            out.push(`http${pattern.slice(1)}`, `https${pattern.slice(1)}`);
        } else {
            out.push(pattern);
        }
    }
    return out;
};

browser.contentScripts = {
    register: api(options => {
        const sources = [];
        for ( const script of options.js || [] ) {
            if ( typeof script.code === 'string' ) {
                sources.push(script.code);
            } else if ( typeof script.file === 'string' ) {
                sources.push(readResource(script.file) || '');
            }
        }
        const runAtEnd = options.runAt === 'document_end' || options.runAt === 'document_idle';
        const url = extension.addContentScript(
            sources.join('\n'),
            safariPatterns(options.matches),
            safariPatterns(options.excludeMatches),
            runAtEnd
        );
        return {
            unregister: api(( ) => { extension.removeContentScript(url); }),
        };
    }),
};

/******************************************************************************/

// uBO's content scripts which run on some sites only, which Safari's manifest
// cannot express.

for ( const script of getManifest().content_scripts || [] ) {
    const js = script.js || [];
    if ( js.length === 0 ) { continue; }
    const matches = script.matches || [];
    if ( matches.includes('http://*/*') && matches.includes('https://*/*') ) {
        continue;
    }
    const runAtEnd = script.run_at !== 'document_start';
    for ( const path of js ) {
        extension.addContentScriptFromURL(getURL(path), safariPatterns(matches), [], runAtEnd);
    }
}

})();
