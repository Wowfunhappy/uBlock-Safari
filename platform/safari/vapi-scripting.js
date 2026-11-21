/*******************************************************************************

    uBlock Origin - a comprehensive, efficient content blocker
    Copyright (C) 2026-present Raymond Hill

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

/* global browser */

import { hostnameFromURI } from './uri-utils.js';

/******************************************************************************/

// Scriptlets reach a document two ways. A content script registered for the
// document's hostname runs before any of the page's own code; Safari applies a
// registration to documents which load after it. tabs.executeScript covers the
// documents a registration cannot: the one being committed when its hostname is
// first seen, and those without a network URL, which take their scriptlets
// from the nearest ancestor with one. The wrapper runs once per document.
//
// Main-world scriptlets run from an inline script the content script inserts;
// WebKit exempts it from the page's Content Security Policy, as a content
// script's other requests are.

function uBO_isolatedCode(mainCode) {
    if ( self.vapiScripting ) { return 0; }
    self.vapiScripting = true;

    (function isolatedCode(){})();

    if ( mainCode ) {
        const doc = document;
        const container = doc.createElement('div');
        const shadowRoot = container.attachShadow({ mode: 'closed' });
        try {
            const script = doc.createElement('script');
            script.appendChild(doc.createTextNode(mainCode));
            shadowRoot.append(script);
            (doc.head || doc.documentElement).appendChild(container);
        } catch {
        }
        container.remove();
    }

    return 0;
}

function uBO_assembleIsolatedCode(details) {
    const { isolatedCode = '', mainCode = '' } = details;
    if ( Boolean(isolatedCode) === false ) {
        if ( Boolean(mainCode) === false ) { return; }
    }
    let code = [
        `// ${details.hostname}`,
        '(function uBO_isolatedWorldWrapper() {',
    ];
    if ( details.earlyBailoutCode ) {
        code.push(details.earlyBailoutCode);
    }
    code.push(
        `(${uBO_isolatedCode.toString()})(`,
        JSON.stringify(`// ${details.hostname}\n${mainCode}`),
        `);`
    );
    code.push('})();');
    code = code.join('\n');
    const match = /\(function isolatedCode\(\)\{\}\)\(\);/.exec(code);
    return code.slice(0, match.index) +
        isolatedCode +
        code.slice(match.index + match[0].length);
}

/******************************************************************************/

const CONTENTSCRIPT_DICT_MAX_LOW = 128;
const CONTENTSCRIPT_DICT_MAX_HIGH = CONTENTSCRIPT_DICT_MAX_LOW +
    (CONTENTSCRIPT_DICT_MAX_LOW >>> 3);
const reIsHTTP = /^https?:\/\//;
const tabDict = new Map();
const contentScriptDict = new Map();
let getContentScripts;

function getEffectiveURL(tabId, frameId) {
    const tabData = tabDict.get(tabId);
    if ( tabData === undefined ) { return; }
    const { frameDict } = tabData;
    let frameData = frameDict.get(frameId);
    for (;;) {
        if ( Boolean(frameData) === false ) { return; }
        if ( reIsHTTP.test(frameData.url) ) { break; }
        frameId = frameData.parentId;
        if ( frameId === -1 ) { break; }
        frameData = frameDict.get(frameId);
    }
    return frameData.url;
}

function prepareContentScript(url) {
    const hostname = hostnameFromURI(url);
    if ( hostname === '' ) { return; }
    let entry = contentScriptDict.get(hostname);
    if ( entry !== undefined ) { return entry; }
    const code = uBO_assembleIsolatedCode(getContentScripts(url)) ?? null;
    entry = { code, t: Date.now() };
    if ( code !== null ) {
        entry.handle = browser.contentScripts.register({
            js: [ { code } ],
            matches: [ `http://${hostname}/*`, `https://${hostname}/*` ],
            runAt: 'document_start',
        }).catch(( ) => {
        });
    }
    contentScriptDict.set(hostname, entry);
    return entry;
}

function unregisterContentScript(hostname) {
    const entry = contentScriptDict.get(hostname);
    if ( entry === undefined ) { return; }
    contentScriptDict.delete(hostname);
    entry.handle?.then(handle => handle?.unregister());
}

function rememberFrame(details) {
    const { tabId } = details;
    const tabData = tabDict.get(tabId) ?? { tabId };
    if ( tabData.frameDict === undefined ) {
        tabData.frameDict = new Map();
        tabDict.set(tabId, tabData);
    }
    const { frameDict } = tabData;
    const { frameId, url } = details;
    if ( frameId === 0 ) {
        frameDict.clear();
    }
    frameDict.set(frameId, { frameId, parentId: details.parentFrameId, url });
    // Every 64 frames, we rebuild to ensure no unbound growth as there is no
    // API listener for removed frames
    if ( (frameDict.size & 0b111111) !== 0 ) { return; }
    const key = self.crypto.randomUUID();
    tabData.gettingFrames = key;
    browser.webNavigation.getAllFrames({ tabId }).then(frames => {
        if ( tabData.gettingFrames !== key ) { return; }
        if ( tabDict.has(tabId) === false ) { return; }
        frameDict.clear();
        for ( const { frameId, parentFrameId, url } of frames ) {
            frameDict.set(frameId, { frameId, parentId: parentFrameId, url });
        }
    });
}

function onCommitted(details) {
    const { tabId, frameId } = details;
    if ( tabId < 0 ) { return; }
    rememberFrame(details);
    let { url } = details;
    if ( frameId !== 0 && reIsHTTP.test(url) === false ) {
        url = getEffectiveURL(tabId, frameId);
        if ( url === undefined ) { return; }
    }
    if ( reIsHTTP.test(url) === false ) { return; }
    const entry = prepareContentScript(url);
    if ( Boolean(entry?.code) === false ) { return; }
    browser.tabs.executeScript(tabId, {
        frameId,
        matchAboutBlank: true,
        runAt: 'document_start',
        code: entry.code,
    }).catch(( ) => {
    });
    entry.t = Date.now();
    if ( contentScriptDict.size <= CONTENTSCRIPT_DICT_MAX_HIGH ) { return; }
    const sortedKeys = Array.from(contentScriptDict.keys()).toSorted((a, b) =>
        contentScriptDict.get(a).t - contentScriptDict.get(b).t
    ).slice(0, -CONTENTSCRIPT_DICT_MAX_LOW);
    for ( const key of sortedKeys ) {
        unregisterContentScript(key);
    }
}

function onTabRemoved(tabId) {
    tabDict.delete(tabId);
}

/******************************************************************************/

export async function start(fn) {
    const initialized = Boolean(getContentScripts);
    getContentScripts = fn;
    if ( initialized ) { return; }

    // https://github.com/chrisaljoudi/uBlock/issues/129
    //  Find out whether content scripts need to be injected
    //  programmatically. This may be necessary for web pages which
    //  were loaded before uBO launched.
    const manifest = browser.runtime.getManifest();
    const injectDeclarativeContentScripts = tabId => {
        browser.tabs.executeScript(tabId, {
            file: 'js/scriptlets/should-inject-contentscript.js'
        }).then(result => {
            if ( Array.isArray(result) ) { result = result[0]; }
            if ( result !== true ) { return; }
            for ( const contentScript of manifest.content_scripts ) {
                for ( const file of contentScript.js ) {
                    browser.tabs.executeScript(tabId, {
                        file,
                        allFrames: contentScript.all_frames,
                        runAt: contentScript.run_at,
                    });
                }
            }
        }).catch(( ) => {
        });
    };

    const tabs = await browser.tabs.query({ url: [ 'http://*/*', 'https://*/*' ] });
    for ( const tab of tabs ) {
        const { id, url } = tab;
        rememberFrame({ tabId: id, frameId: 0, parentFrameId: -1, url });
        const entry = prepareContentScript(url);
        if ( entry?.code ) {
            browser.tabs.executeScript(id, {
                allFrames: true,
                matchAboutBlank: true,
                runAt: 'document_start',
                code: entry.code,
            }).catch(( ) => {
            });
        }
        injectDeclarativeContentScripts(id);
    }

    browser.webNavigation.onCommitted.addListener(onCommitted);
    browser.tabs.onRemoved.addListener(onTabRemoved);
}

export function reset() {
    for ( const hostname of Array.from(contentScriptDict.keys()) ) {
        unregisterContentScript(hostname);
    }
}
