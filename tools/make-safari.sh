#!/usr/bin/env bash
#
# This script assumes a macOS environment

set -e

echo "*** uBlock0.safariextension: Creating extension"

DES=dist/build/uBlock0.safariextension
rm -rf $DES
mkdir -p $DES

echo "*** uBlock0.safariextension: Copying common files"
bash ./tools/copy-common-files.sh $DES

# Safari-specific
echo "*** uBlock0.safariextension: Copying safari-specific files"
cp platform/safari/*.js           $DES/js/
cp -R platform/safari/img         $DES/
cp platform/safari/Info.plist     $DES/
cp platform/safari/Settings.plist $DES/
cp platform/chromium/manifest.json $DES/
cp $DES/img/icon_128.png          $DES/Icon.png
cp $DES/img/icon_64.png           $DES/Icon-64.png
cp $DES/img/icon_32.png           $DES/Icon-32.png

# browser-safari.js completes the `browser` namespace every extension page
# uses: it runs before vapi.js.
echo "*** uBlock0.safariextension: Loading browser-safari.js in extension pages"
for page in $DES/*.html $DES/web_accessible_resources/*.html; do
    perl -0pi -e 's#(<script src="((?:\.\./)?)js/vapi\.js"></script>)#<script src="$2js/browser-safari.js"></script>\n$1#' "$page"
done

# Safari 7 serves an extension file only when its name has an extension, and
# packages a zero-byte file as a directory it cannot read.
# - assets.json lists serverlist.txt ahead of serverlist.
# - The `empty` redirect resource is empty.txt, with `empty` its alias, holding
#   a comment the redirect engine strips to empty text.
echo "*** uBlock0.safariextension: Giving every loaded file a name extension and content"
mv $DES/assets/thirdparties/pgl.yoyo.org/as/serverlist $DES/assets/thirdparties/pgl.yoyo.org/as/serverlist.txt
rm $DES/web_accessible_resources/empty
printf '/* */\n' > $DES/web_accessible_resources/empty.txt
perl -0pi -e "s#\[ 'empty', \{\n#[ 'empty.txt', {\n        alias: 'empty',\n# or die 'redirect-resources.js: no empty resource'" $DES/js/redirect-resources.js
if find $DES/assets $DES/web_accessible_resources -type f \( ! -name '*.*' -o -size 0 \) | grep -q .; then
    echo "*** uBlock0.safariextension: files without an extension or content remain" >&2
    exit 1
fi

# The locales the extension has, for browser-safari.js's i18n.
(cd $DES/_locales && ls -d */ | sed 's#/$##' | python3 -c 'import json, sys; print(json.dumps(sys.stdin.read().split()))' > locales.json)

echo "*** uBlock0.safariextension: Generating meta..."
python3 tools/make-safari-meta.py $DES/

if [ "$1" = all ]; then
    echo "*** uBlock0.safariextension: Creating signed package..."
    bash ./tools/make-safari-sign.sh $DES
fi

echo "*** uBlock0.safariextension: Package done."
