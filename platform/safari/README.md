(Note: This readme was largely written by Claude Opus 5.5. I have done a quick edit pass.)

# UBlock Origin Legacy Safari Port

uBlock Origin for Safari 7 on OS X Mavericks, running [wowfunhappy/webkit](https://github.com/wowfunhappy/webkit). Notably, this backport gives legacy safari extensions parts of the WebExtensions `browser` namespace needed by UBlock:

- `runtime.connect`, `runtime.sendMessage`, `runtime.onConnect`, `runtime.onMessage`, `tabs.connect`, `tabs.sendMessage`, and, in content scripts, `runtime.getFrameId` and `dom.openOrClosedShadowRoot`;
- `webRequest`, with blocking `onBeforeRequest` and `onHeadersReceived` listeners, for every request a page makes: documents, subresources, XMLHttpRequest and fetch, WebSockets, pings and beacons;
- `webNavigation.onCommitted`, `onDOMContentLoaded` and `onCreatedNavigationTarget`, `getFrame` and `getAllFrames`;
- `tabs.executeScript`, and `tabs.insertCSS`/`removeCSS`, which add a style sheet to one document that the page cannot see;
- `tabs.get`, `update`, `reload`, `remove`, `onCreated`, `onUpdated` and `onRemoved`, for the tab ids the rest of the namespace reports.

Tabs are identified as WebKit identifies them, frames as the WebExtensions API does (0 is a tab's top frame). An inline script a content script inserts is not
subject to the page's Content Security Policy. The extension's own pages reach its files from the origin's root (`/js/...`), as a WebExtension's pages do.

`browser-safari.js` completes the namespace with Safari's own extension API: tabs and windows as Safari shows them, the toolbar button, context menus,
alarms, localization, `contentScripts.register`, and `storage.local`, which keeps each value in IndexedDB and never writes a value that is already stored.
`vapi-client-safari.js` is the one content script it needs: it ties Safari's tabs to WebKit's tab ids and describes context-menu targets.

Safari 7 cannot serve an extension file whose name has no extension, so `make-safari.sh` gives one to every file uBO loads.

## Building

    tools/pull-assets.sh
    tools/make-safari.sh

`dist/build/uBlock0.safariextension` can be installed from Safari's Extension Builder (Develop > Show Extension Builder), with a Safari Developer certificate whose team matches `DeveloperIdentifier` in `Info.plist`. `tools/make-safari.sh all` also signs a `.safariextz` (see `tools/make-safari-sign.sh`). Since Apple no longer issues Safari Developer certificates, it is not obvious how much this matters; you are expected to use this extension alongside a patch to allow self-signed extensions.