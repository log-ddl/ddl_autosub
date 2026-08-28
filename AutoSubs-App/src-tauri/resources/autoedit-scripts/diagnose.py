"""Diagnostic: report exactly where the Resolve scripting connection breaks.

Prints the Python interpreter, architecture, the Resolve env vars, whether the
fusionscript library is present, whether the import works, and the result of
scriptapp(). Read-only.
"""
import os
import sys


def main() -> int:
    print("=== Python ===")
    print("executable:", sys.executable)
    print("version:", sys.version.replace("\n", " "))
    print("64-bit:", sys.maxsize > 2**32)
    print()

    print("=== Resolve env vars ===")
    api = os.environ.get("RESOLVE_SCRIPT_API", "(unset)")
    lib = os.environ.get("RESOLVE_SCRIPT_LIB", "(unset)")
    pp = os.environ.get("PYTHONPATH", "(unset)")
    print("RESOLVE_SCRIPT_API:", api)
    print("RESOLVE_SCRIPT_LIB:", lib)
    print("PYTHONPATH:", pp)
    print("lib exists:", os.path.exists(lib) if lib != "(unset)" else "n/a")
    print()

    print("=== Import DaVinciResolveScript ===")
    try:
        import DaVinciResolveScript as dvr
        print("import: OK")
        print("module file:", getattr(dvr, "__file__", "(builtin/native)"))
    except Exception as exc:
        print("import: FAILED —", repr(exc))
        return 1
    print()

    print("=== scriptapp('Resolve') ===")
    try:
        resolve = dvr.scriptapp("Resolve")
    except Exception as exc:
        print("scriptapp raised:", repr(exc))
        return 1

    if resolve is None:
        print("scriptapp returned: None")
        print()
        print("The native library loaded but could NOT connect to the running")
        print("Resolve process. This is the connection layer, not Python.")
        return 1

    print("scriptapp returned:", resolve)
    try:
        print("Resolve version:", resolve.GetVersionString())
    except Exception as exc:
        print("GetVersionString failed:", repr(exc))
    return 0


if __name__ == "__main__":
    sys.exit(main())
