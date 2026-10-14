#!/usr/bin/env python3
"""POST a JS expression to the relay's /js endpoint (or /worker-js) from a file.

Usage: js.py <expr-file> [--path /js] [--frame SUBSTR]
Avoids shell quoting hell when the expression contains quotes.
"""
import json
import sys
import urllib.request

path = '/js'
frame = ''
args = sys.argv[1:]
i = 0
pos = []
while i < len(args):
    if args[i] == '--path':
        path = args[i + 1]
        i += 2
    elif args[i] == '--frame':
        frame = args[i + 1]
        i += 2
    else:
        pos.append(args[i])
        i += 1

expr = open(pos[0]).read()
body = {'expr': expr}
if frame:
    body['frame'] = frame
req = urllib.request.Request(
    'http://127.0.0.1:8888' + path,
    data=json.dumps(body).encode(),
    headers={'content-type': 'application/json'},
    method='POST',
)
print(json.dumps(json.load(urllib.request.urlopen(req, timeout=180)), ensure_ascii=False, indent=1))
