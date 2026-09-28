/*******************************************************************************

    uBlock Origin - a comprehensive, efficient content blocker
    Copyright (C) 2017-present Raymond Hill

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

/******************************************************************************/

// WebKit's webRequest listeners may answer with a promise, so network requests
// made while uBO is still loading its filters wait for it, as on Firefox.

{
    const extToTypeMap = new Map([
        ['eot','font'],['otf','font'],['ttf','font'],['woff','font'],['woff2','font'],
        ['mp3','media'],['mp4','media'],['webm','media'],
        ['gif','image'],['ico','image'],['jpeg','image'],['jpg','image'],['png','image'],['svg','image'],['webp','image']
    ]);

    const parsedURL = new URL('https://www.example.org/');

    vAPI.Net = class extends vAPI.Net {
        constructor() {
            super();
            this.pendingRequests = [];
        }

        normalizeDetails(details) {
            const type = details.type;
            if ( type !== 'other' ) { return; }
            // Try to map known "extension" part of URL to request type
            if ( details.responseHeaders === undefined ) {
                parsedURL.href = details.url;
                const path = parsedURL.pathname;
                const pos = path.indexOf('.', path.length - 6);
                if ( pos !== -1 ) {
                    details.type = extToTypeMap.get(path.slice(pos + 1)) || type;
                }
                return;
            }
            // Try to extract type from response headers
            const ctype = this.headerValue(details.responseHeaders, 'content-type');
            if ( ctype.startsWith('font/') ) {
                details.type = 'font';
            } else if ( ctype.startsWith('image/') ) {
                details.type = 'image';
            } else if ( ctype.startsWith('audio/') || ctype.startsWith('video/') ) {
                details.type = 'media';
            }
        }

        // Some types can be mapped from 'other', thus include 'other' if and
        // only if the caller is interested in at least one of those types
        denormalizeTypes(types) {
            if ( types.length === 0 ) {
                return Array.from(this.validTypes);
            }
            const out = new Set();
            for ( const type of types ) {
                if ( this.validTypes.has(type) ) {
                    out.add(type);
                }
            }
            if ( out.has('other') === false ) {
                for ( const type of extToTypeMap.values() ) {
                    if ( out.has(type) ) {
                        out.add('other');
                        break;
                    }
                }
            }
            return Array.from(out);
        }

        suspendOneRequest(details) {
            const pending = {
                details: Object.assign({}, details),
                resolve: undefined,
                promise: undefined
            };
            pending.promise = new Promise(resolve => {
                pending.resolve = resolve;
            });
            this.pendingRequests.push(pending);
            return pending.promise;
        }

        unsuspendAllRequests(discard = false) {
            const pendingRequests = this.pendingRequests;
            this.pendingRequests = [];
            for ( const entry of pendingRequests ) {
                entry.resolve(
                    discard !== true
                        ? this.onBeforeSuspendableRequest(entry.details)
                        : undefined
                );
            }
        }

        static canSuspend() {
            return true;
        }
    };
}

/******************************************************************************/

// Scriptlets run in the page's world from an inline script the content script
// inserts; WebKit exempts it from the page's Content Security Policy, as a
// content script's other requests are.

vAPI.scriptletsInjector = (( ) => {
    const parts = [
        '(',
        function(details) {
            if ( self.uBO_scriptletsInjected !== undefined ) { return; }
            const doc = document;
            const { location } = doc;
            if ( location === null ) { return; }
            const { hostname } = location;
            if ( hostname !== '' && details.hostname !== hostname ) { return; }
            let script;
            try {
                script = doc.createElement('script');
                script.appendChild(doc.createTextNode(details.scriptlets));
                (doc.head || doc.documentElement).appendChild(script);
                self.uBO_scriptletsInjected = details.filters;
            } catch {
            }
            if ( script ) {
                script.remove();
                script.textContent = '';
            }
            return 0;
        }.toString(),
        ')(',
            'json-slot',
        ');',
    ];
    const jsonSlot = parts.indexOf('json-slot');
    return (hostname, details) => {
        parts[jsonSlot] = JSON.stringify({
            hostname,
            scriptlets: details.mainWorld,
            filters: details.filters,
        });
        return parts.join('');
    };
})();

/******************************************************************************/

// Safari's Extensions preferences show the extension's settings only: its
// "Open uBlock Origin's dashboard" checkbox opens the dashboard.

{
    const settings = self.safari.extension.settings;
    settings.addEventListener('change', ev => {
        if ( ev.key !== 'open_prefs' || ev.newValue !== true ) { return; }
        settings.open_prefs = false;
        vAPI.tabs.open({ url: 'dashboard.html', select: true, index: -1 });
    });
}

/******************************************************************************/
