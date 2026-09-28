#!/usr/bin/env python3

import json
import os
import re
import sys
import time

if len(sys.argv) == 1 or not sys.argv[1]:
    raise SystemExit('Build dir missing.')

proj_dir = os.path.join(os.path.split(os.path.abspath(__file__))[0], '..')
build_dir = os.path.abspath(sys.argv[1])

version = ''
with open(os.path.join(proj_dir, 'dist', 'version')) as f:
    version = f.read().strip()

manifest_out_file = os.path.join(build_dir, 'manifest.json')
with open(manifest_out_file) as f:
    manifest = json.load(f)

manifest['version'] = version

# Development build? If so, modify name accordingly.
match = re.search(r'^\d+\.\d+\.\d+\.\d+$', version)
if match:
    manifest['name'] += ' development build'
    manifest['short_name'] += ' dev build'
    manifest['browser_action']['default_title'] += ' dev build'

with open(manifest_out_file, 'w') as f:
    json.dump(manifest, f, indent=2, separators=(',', ': '), sort_keys=True)
    f.write('\n')

# Localized values the manifest names by message key.
messages_file = os.path.join(build_dir, '_locales', manifest['default_locale'], 'messages.json')
with open(messages_file, encoding='utf-8') as f:
    messages = json.load(f)

def localized(value):
    match = re.match(r'^__MSG_(.+)__$', value)
    return messages[match.group(1)]['message'] if match else value

def escape(value):
    return value.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

info_plist_file = os.path.join(build_dir, 'Info.plist')
with open(info_plist_file, encoding='utf-8') as f:
    info_plist = f.read()

info_plist = info_plist.format(
    author=escape(manifest['author']),
    name=escape(manifest['name']),
    description=escape(localized(manifest['description'])),
    version=escape(version),
    buildNumber=int(time.time()),
)

with open(info_plist_file, 'w', encoding='utf-8') as f:
    f.write(info_plist)
