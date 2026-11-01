# Kontrola kompatibility kodeku k2 s modulem pro KCD:MP: kresby_png.lua (Lua 5.4 v lupa) zakóduje a dekóduje
# stejnou kresbu jako TS kodek. Volá ho test/codec.test.ts.
#   stdin: {"encode": <kresba>} nebo {"decode": "k2...."}   stdout: {"k2": "..."} nebo {"drawing": {...}}
import json
import os
import sys

import lupa

here = os.path.dirname(os.path.abspath(__file__))
lua = lupa.LuaRuntime(unpack_returned_tuples=True)
try:
    lua = lupa.lua54.LuaRuntime(unpack_returned_tuples=True)
except AttributeError:
    pass
server = os.path.join(here, "..", "..", "server")
lua.execute(f"package.path = {json.dumps(server.replace(os.sep, '/') + '/?.lua;')} .. package.path")
P = lua.eval('require("kresby_png")')
if isinstance(P, tuple):
    P = P[0]
req = json.loads(sys.stdin.read())


def to_lua(v):
    if isinstance(v, dict):
        t = lua.table()
        for k, x in v.items():
            t[k] = to_lua(x)
        return t
    if isinstance(v, list):
        t = lua.table()
        for i, x in enumerate(v):
            t[i + 1] = to_lua(x)
        return t
    return v


def from_lua(t):
    if type(t).__name__ != "_LuaTable":
        return t
    keys = list(t.keys())
    if keys and all(isinstance(k, int) for k in keys):
        return [from_lua(t[i]) for i in range(1, len(keys) + 1)]
    return {k: from_lua(t[k]) for k in keys}


if "encode" in req:
    print(json.dumps({"k2": P.encode(to_lua(req["encode"]))}))
else:
    print(json.dumps({"drawing": from_lua(P.decode(req["decode"]))}))
