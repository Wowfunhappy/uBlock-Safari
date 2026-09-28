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

// For content scripts, before vapi.js: what only Safari's own content-script
// API knows, handed to the background.
//
// - The top frame introduces its tab to the background, through WebKit's
//   runtime messaging and through Safari's, with one token: the background
//   then knows which Safari tab a WebKit tab id stands for.
// - A context menu opened in the frame tells Safari what was clicked, which
//   the background reads when it builds uBO's context menu entries.
//
// Everything it defines lives in the content-script world, out of the page's
// sight.

(( ) => {
'use strict';

if ( self.browser instanceof Object === false ) { return; }

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

if ( self.safari instanceof Object === false ) { return; }
const tabProxy = self.safari.self && self.safari.self.tab;
if ( tabProxy instanceof Object === false ) { return; }

if ( self === self.top ) {
    const words = new Uint32Array(4);
    self.crypto.getRandomValues(words);
    const token = Array.from(words, w => w.toString(36)).join('');
    const what = 'uBO:tab-identity';
    self.browser.runtime.sendMessage({ what, token }).catch(( ) => { });
    tabProxy.dispatchMessage(what, token);
}

const mediaTypes = { IMG: 'image', VIDEO: 'video', AUDIO: 'audio' };

self.addEventListener('contextmenu', ev => {
    const target = ev.target instanceof Element ? ev.target : null;
    const inFrame = self !== self.top;
    const contexts = [ inFrame ? 'frame' : 'page' ];
    const info = {
        frameUrl: self.location.href,
        pageUrl: inFrame ? undefined : self.location.href,
    };
    try {
        info.frameId = self.browser.runtime.getFrameId(self);
    } catch {
    }
    const link = target && target.closest('a[href], area[href]');
    if ( link !== null ) {
        contexts.push('link');
        info.linkUrl = link.href;
    }
    if ( target !== null ) {
        const mediaType = mediaTypes[target.tagName];
        if ( mediaType !== undefined ) {
            const src = target.currentSrc || target.src;
            if ( typeof src === 'string' && src !== '' ) {
                contexts.push(mediaType);
                info.mediaType = mediaType;
                info.srcUrl = src;
            }
        }
        if ( target.isContentEditable || /^(?:INPUT|TEXTAREA)$/.test(target.tagName) ) {
            contexts.push('editable');
            info.editable = true;
        }
    }
    const selection = self.getSelection();
    if ( selection !== null && selection.toString() !== '' ) {
        contexts.push('selection');
        info.selectionText = selection.toString();
    }
    info.contexts = contexts;
    tabProxy.setContextMenuEventUserInfo(ev, info);
}, true);

})();

/******************************************************************************/

void 0;
