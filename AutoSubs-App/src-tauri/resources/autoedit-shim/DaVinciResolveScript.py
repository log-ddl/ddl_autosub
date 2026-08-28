"""Drop-in replacement for DaVinci Resolve's own `DaVinciResolveScript` module.

Resolve's real module talks to Resolve through `fusionscript`, which the **free
edition refuses to serve to any out-of-process caller** — `scriptapp("Resolve")`
just returns None no matter how the environment is configured. Only Studio
accepts external scripting connections.

AutoSubs already runs a small HTTP server *inside* Resolve (the Lua bridge in
`resources/modules/autosubs_core.lua`), and code running there has full access
to the API. So instead of connecting directly, this module forwards every
attribute call to that server and returns proxies for the objects it hands
back. Scripts written against the normal Resolve API work unmodified:

    import DaVinciResolveScript as dvr
    resolve = dvr.scriptapp("Resolve")
    project = resolve.GetProjectManager().GetCurrentProject()

Each call is one HTTP round trip, so prefer holding on to objects rather than
re-fetching them in a loop.
"""

import http.client
import json
import os
import urllib.error
import urllib.request

# Everything a dropped or refused connection can surface as. The bridge answers
# with `Connection: close`, so a Resolve that quits mid-script shows up here as
# RemoteDisconnected rather than as a URLError.
_TRANSPORT_ERRORS = (urllib.error.URLError, http.client.HTTPException, OSError)

__all__ = ["scriptapp", "Resolve", "ResolveBridgeError"]

# Matches PORT in autosubs_core.lua. Overridable mainly for tests.
ENDPOINT = os.environ.get("AUTOSUBS_BRIDGE_URL", "http://127.0.0.1:56002/")

# Object id the Lua side always maps to the root `resolve` object.
_ROOT_ID = 0

# Marker used in both directions for a value that is a Resolve API object
# rather than plain data.
_OBJ_KEY = "__resolve_obj"


class ResolveBridgeError(RuntimeError):
    """Raised when the Resolve-side call fails or the bridge is unreachable."""


def _post(payload, timeout):
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        ENDPOINT,
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read().decode("utf-8", errors="replace")
    if not raw:
        raise ResolveBridgeError("Empty response from the AutoSubs bridge")
    try:
        return json.loads(raw)
    except ValueError as exc:
        raise ResolveBridgeError(
            "Invalid response from the AutoSubs bridge: %s" % raw[:200]
        ) from exc


def _encode(value):
    if isinstance(value, _ResolveObject):
        return {_OBJ_KEY: value._resolve_id}
    if isinstance(value, dict):
        return {key: _encode(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_encode(item) for item in value]
    return value


def _decode_data(value):
    if isinstance(value, dict):
        if _OBJ_KEY in value:
            return _ResolveObject(value[_OBJ_KEY])
        return {key: _decode_data(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_decode_data(item) for item in value]
    return value


def _decode_result(encoded):
    if not isinstance(encoded, dict):
        return encoded
    kind = encoded.get("kind")
    if kind == "object":
        return _ResolveObject(encoded.get("id"))
    if kind == "value":
        return encoded.get("value")
    if kind == "data":
        return _decode_data(encoded.get("value"))
    # "nil" and anything unrecognised
    return None


def _invoke(object_id, method, args, timeout=600):
    encoded = [_encode(arg) for arg in args]
    try:
        response = _post(
            {
                "func": "ResolveRpc",
                "objectId": object_id,
                "method": method,
                # argCount travels separately so a None argument (JSON null)
                # doesn't silently truncate the list on the Lua side.
                "args": encoded,
                "argCount": len(encoded),
            },
            timeout,
        )
    except _TRANSPORT_ERRORS as exc:
        raise ResolveBridgeError(
            "Lost the connection to DaVinci Resolve while calling %s(). Is "
            "Resolve still open with the AutoSubs script running? (%s)"
            % (method, exc)
        ) from exc

    if response.get("error"):
        detail = response.get("detail") or ""
        raise ResolveBridgeError(
            "%s() failed in Resolve: %s%s"
            % (method, response["error"], (" - " + detail) if detail else "")
        )
    if "result" not in response:
        # An AutoSubs Lua server older than the AutoEdit bridge answers any
        # command it doesn't recognise with a generic OK, which would otherwise
        # turn every API call into a silent None.
        raise ResolveBridgeError(
            "The AutoSubs script running inside DaVinci Resolve is out of date "
            "and does not support AutoEdit. In Resolve, run Workspace > Scripts "
            "> AutoSubs again to restart it, then re-run this script."
        )
    return _decode_result(response["result"])


class _ResolveObject(object):
    """Stand-in for a Resolve API object living inside Resolve."""

    __slots__ = ("_resolve_id",)

    def __init__(self, object_id):
        object.__setattr__(self, "_resolve_id", object_id)

    def __getattr__(self, name):
        # Never proxy dunder lookups; Python probes plenty of those internally
        # and each one would cost a pointless round trip.
        if name.startswith("__"):
            raise AttributeError(name)

        def call(*args):
            return _invoke(self._resolve_id, name, args)

        call.__name__ = str(name)
        return call

    def __repr__(self):
        return "<Resolve object #%s (via AutoSubs bridge)>" % self._resolve_id


def scriptapp(name="Resolve"):
    """Return the Resolve application object, or None if it isn't reachable.

    Mirrors the real module: callers check for None rather than catching.
    """
    if name != "Resolve":
        return None
    try:
        _post({"func": "Ping"}, timeout=10)
    except Exception:
        # Bridge unreachable: Resolve is closed, or the AutoSubs script inside
        # it was never started. Returning None matches the real module, and
        # callers already handle it.
        return None

    root = _ResolveObject(_ROOT_ID)
    # Probe a real call so a stale bridge fails loudly here rather than making
    # every later call quietly return None.
    root.GetVersionString()
    return root


def Resolve():
    """Convenience alias matching the `Resolve()` helper some scripts expect."""
    return scriptapp("Resolve")
