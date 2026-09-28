#!/usr/bin/env bash
#
# Packages and signs a .safariextension folder as a .safariextz, with the
# Safari Developer certificate whose team the Info.plist's DeveloperIdentifier
# names.
#
# dist/certs/key.pem is the certificate's private key, exported from the
# keychain (Keychain Access > export the "Safari Developer" identity as .p12,
# then `openssl pkcs12 -in identity.p12 -nocerts -nodes -out key.pem`). The
# certificate and Apple's intermediate and root certificates are read from the
# keychain when dist/certs does not have them.

set -e

CERT=dist/certs
SRC="${1%/}"
DES="${SRC/safariextension/safariextz}"

mkdir -p "$CERT"
if [ ! -f "$CERT/key.pem" ]; then
    echo "*** Missing $CERT/key.pem: cannot sign."
    exit 1
fi

TEAM=$(/usr/libexec/PlistBuddy -c 'Print :DeveloperIdentifier' "$SRC/Info.plist")
exportCertificate() {
    local name="$1" file="$2"
    [ -f "$CERT/$file" ] && return
    security find-certificate -c "$name" -p | openssl x509 -outform der -out "$CERT/$file"
}
exportCertificate "Safari Developer: ($TEAM)" SafariDeveloper.cer
exportCertificate "Apple Worldwide Developer Relations Certification Authority" AppleWWDRCA.cer
exportCertificate "Apple Root CA" AppleIncRootCertificate.cer

# Apple's xar cannot sign; mackyle's fork can.
if command -v xar-mackyle > /dev/null 2>&1; then
    xar='xar-mackyle'
else
    xar="$(pwd)/tools/xar-mackyle"
    if [ ! -x "$xar" ]; then
        echo "*** Building mackyle's xar into tools/xar-mackyle"
        work=$(mktemp -d)
        curl -fsSL https://github.com/mackyle/xar/archive/xar-1.6.1.tar.gz | tar -xz -C "$work"
        (
            cd "$work"/xar-xar-1.6.1/xar
            ./autogen.sh --noconfigure > /dev/null
            CFLAGS=-w CPPFLAGS=-w ./configure --disable-shared > /dev/null
            make > /dev/null
        )
        mv "$work"/xar-xar-1.6.1/xar/src/xar "$xar"
        rm -rf "$work"
    fi
fi

siglen=$(openssl dgst -sign "$CERT/key.pem" -binary < "$CERT/key.pem" | wc -c | tr -d ' ')

rm -f "$DES"
"$xar" -czf "$DES" --distribution --directory "$(dirname "$SRC")" "$(basename "$SRC")"
"$xar" --sign -f "$DES" --digestinfo-to-sign "$CERT/digestinfo.dat" \
    --sig-size "$siglen" \
    --cert-loc "$CERT/SafariDeveloper.cer" \
    --cert-loc "$CERT/AppleWWDRCA.cer" \
    --cert-loc "$CERT/AppleIncRootCertificate.cer"
openssl rsautl -sign -inkey "$CERT/key.pem" -in "$CERT/digestinfo.dat" -out "$CERT/signature.dat"
"$xar" --inject-sig "$CERT/signature.dat" -f "$DES"
rm -f "$CERT/signature.dat" "$CERT/digestinfo.dat"

echo "*** Signed $DES"
