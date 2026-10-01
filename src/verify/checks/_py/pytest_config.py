"""Resolve the pytest configuration a test run would use, with pytest's own code.

Usage: pytest_config.py            (one JSON object on stdin)

Input:

    {"root": "<absolute root>", "args": ["-q", ...], "env_addopts": "<PYTEST_ADDOPTS>" | null}

`args` is the argv pytest receives (everything after `pytest` / `-m pytest`);
`env_addopts` is prepended the way pytest prepends PYTEST_ADDOPTS.

Output, one JSON object on stdout:

    {"ok": true, "pytest": "8.4.1", "resolver": "pytest" | "fallback",
     "config_file": "<path relative to root>" | null,
     "addopts": [...] | null, "testpaths": [...] | null, "python_files": [...] | null}

    {"ok": false, "config_file": "<path>" | null, "error": "<reason class>"}

A value is null when the key is not set. `addopts`, `testpaths` and
`python_files` are pytest "args" options, returned exactly as pytest's getini
returns them: a TOML list as-is, an ini string through shlex.split.

`error` is one of REASONS, never exception text: a parser error echoes the
offending config line, which can hold a secret. `config_file` never carries a
path outside the root.

WHY THIS EXISTS (#174). A line reader cannot reproduce how pytest reads its
config. This asks pytest: `_pytest.config.findpaths.determine_setup` chooses the
file and parses it. Because the interpreter running the tests can only be found
on a best-effort basis, the answer is also computed for every pytest generation
(6, 7-8, 9) and refused when a generation that might be running would read
different values. When pytest's API is not recognised, a fallback built on
iniconfig + tomllib/tomli applies the same per-generation precedence.

FAIL CLOSED. Every failure is `ok: false`; the caller floors the verdict on it.

Nothing here imports project code: no conftest, no entry-point plugins. The
caller spawns this with -E -B from a neutral cwd, and PYTHONPATH-derived
sys.path entries are dropped before anything else is imported.
Stdlib only apart from pytest and its own dependencies; Python 3.8 floor.
"""
import os
import sys

# Before any other import: PYTHONPATH precedes the stdlib, so a repository on it
# could shadow json or iniconfig. Python absolutises these entries itself.
_ENV_PATHS = {os.path.abspath(p) for p in os.environ.get("PYTHONPATH", "").split(os.pathsep) if p}
sys.path[:] = [p for p in sys.path if p and os.path.isabs(p) and p not in _ENV_PATHS]

import argparse  # noqa: E402
import copy  # noqa: E402
import inspect  # noqa: E402
import json  # noqa: E402
import shlex  # noqa: E402
from pathlib import Path  # noqa: E402

KEYS = ("addopts", "testpaths", "python_files")

PYTEST9_FILES = ("pytest.toml", ".pytest.toml")

REASONS = frozenset(
    (
        "bad-request",
        "relative-root",
        "not-a-directory",
        "pytest-not-importable",
        "unsupported-pytest",
        "config-syntax",
        "pytest9-format",
        "version-dependent",
        "bad-option",
        "argument-file",
        "bad-value",
        "internal-error",
    )
)


class Refusal(Exception):
    def __init__(self, reason, path=None):
        assert reason in REASONS
        super().__init__(reason)
        self.reason = reason
        self.path = path


# The config file being read when a failure happens, so the refusal can name it.
READING = {"path": None}


def emit(obj, code=0):
    sys.stdout.buffer.write(json.dumps(obj).encode("utf-8", "surrogateescape"))
    sys.stdout.buffer.flush()
    sys.exit(code)


def load_toml_module():
    if sys.version_info >= (3, 11):
        import tomllib

        return tomllib
    try:
        import tomli

        return tomli
    except ImportError:
        return None


def inside(path, root):
    # Lexical, against the resolved root: pytest builds every path from the cwd,
    # which is the resolved root.
    try:
        Path(os.path.abspath(str(path))).relative_to(root)
        return True
    except ValueError:
        return False


def display(path, root):
    if path is None:
        return None
    try:
        return Path(os.path.abspath(str(path))).relative_to(root).as_posix()
    except ValueError:
        return Path(str(path)).name


def version_tuple(text):
    out = []
    for part in text.split(".")[:2]:
        digits = "".join(ch for ch in part if ch.isdigit())
        out.append(int(digits) if digits else 0)
    return tuple(out)


def as_args(value):
    """pytest's getini coercion for an "args" option."""
    if isinstance(value, str):
        try:
            return shlex.split(value)
        except ValueError:
            raise Refusal("bad-value")
    if isinstance(value, list) and all(isinstance(v, str) for v in value):
        return list(value)
    raise Refusal("bad-value")


def apply_overrides(values, overrides):
    """-o/--override-ini, last one winning, as pytest's getini applies them."""
    for item in overrides or ():
        if "=" not in item:
            raise Refusal("bad-option")
        key, value = item.split("=", 1)
        if key in KEYS:
            values[key] = value


def native_toml_table(path, toml):
    data = toml.loads(path.read_text(encoding="utf-8"))
    tool_pytest = data.get("tool", {}).get("pytest", {})
    return isinstance(tool_pytest, dict) and any(k != "ini_options" for k in tool_pytest)


def refuse_pytest9_formats(version, dirs, toml):
    """A pytest older than 9 ignores pytest.toml and native [tool.pytest]; their
    presence means the project expects a pytest this interpreter does not have."""
    if version_tuple(version) >= (9, 0):
        return
    for d in dirs:
        for name in PYTEST9_FILES:
            if (d / name).is_file():
                raise Refusal("pytest9-format", d / name)
        pyproject = d / "pyproject.toml"
        if toml is not None and pyproject.is_file():
            try:
                native = native_toml_table(pyproject, toml)
            except Exception:
                continue  # a parse error is reported by the resolution itself
            if native:
                raise Refusal("pytest9-format", pyproject)


def resolve_with_pytest(root, argv):
    """Returns (version, inipath, values, request) using pytest's own resolution,
    or None when this pytest's API is not one we recognise. `request` is the
    parsed (inifile, positional, overrides) for the generation check."""
    import _pytest
    from _pytest.config import findpaths, get_config

    version = getattr(_pytest, "__version__", "unknown")
    determine_setup = getattr(findpaths, "determine_setup", None)
    loader = getattr(findpaths, "load_config_dict_from_file", None)
    if determine_setup is None or loader is None:
        return None
    params = list(inspect.signature(determine_setup).parameters)

    # pytest's own command-line parser, with only its builtin options: at config
    # resolution time pytest has not loaded entry-point plugins either.
    config = get_config()
    try:
        ns, unknown = config._parser.parse_known_and_unknown_args(
            argv, namespace=copy.copy(config.option)
        )
    except BaseException as exc:
        if isinstance(exc, KeyboardInterrupt):
            raise
        raise Refusal("bad-option")
    inifile = getattr(ns, "inifilename", None)
    rootdir_arg = getattr(ns, "rootdir", None) or None
    overrides = getattr(ns, "override_ini", None)

    explicit = None
    if inifile:
        explicit = Path(os.path.abspath(inifile))
        if not os.path.isabs(inifile) and not inside(explicit, root):
            raise Refusal("bad-option")

    # Only files inside the root are read; an explicit -c is honoured as given.
    def bounded_loader(path):
        path = Path(path)
        if not (explicit is not None and path == explicit) and not inside(path, root):
            return None
        READING["path"] = path
        try:
            return loader(path)
        except BaseException as exc:  # pytest's fail() is a BaseException
            if isinstance(exc, KeyboardInterrupt):
                raise
            raise Refusal("config-syntax", path)

    if "override_ini" in params and "invocation_dir" in params:
        positional = list(ns.file_or_dir)
        kwargs = dict(
            inifile=inifile,
            override_ini=overrides,
            args=positional,
            rootdir_cmd_arg=rootdir_arg,
            invocation_dir=Path.cwd(),
        )
        call, overrides_applied = (lambda: determine_setup(**kwargs)), True
    elif "invocation_dir" in params:
        positional = list(ns.file_or_dir) + list(unknown)
        kwargs = dict(
            inifile=inifile, args=positional, rootdir_cmd_arg=rootdir_arg, invocation_dir=Path.cwd()
        )
        call, overrides_applied = (lambda: determine_setup(**kwargs)), False
    elif params[:3] == ["inifile", "args", "rootdir_cmd_arg"]:
        positional = list(ns.file_or_dir) + list(unknown)
        call = lambda: determine_setup(inifile, positional, rootdir_cmd_arg=rootdir_arg)  # noqa: E731
        overrides_applied = False
    else:
        return None

    findpaths.load_config_dict_from_file = bounded_loader
    try:
        result = call()
    except Refusal:
        raise
    except BaseException as exc:
        if isinstance(exc, KeyboardInterrupt):
            raise
        # --rootdir that does not exist, a malformed -o (pytest 9), and the like.
        raise Refusal("bad-option")
    finally:
        findpaths.load_config_dict_from_file = loader

    inipath, inicfg = result[1], result[2]
    if inipath is not None and explicit is None and not inside(inipath, root):
        inipath, inicfg = None, {}
    READING["path"] = inipath

    values = {}
    for key in KEYS:
        if key not in inicfg:
            continue
        entry = inicfg[key]
        if hasattr(entry, "mode") and hasattr(entry, "value"):
            # pytest 9 ConfigValue. Native TOML mode takes lists only.
            if entry.mode == "toml" and not isinstance(entry.value, list):
                raise Refusal("bad-value", inipath)
            values[key] = entry.value
        else:
            values[key] = entry
    if not overrides_applied:
        apply_overrides(values, overrides)
    resolved = {k: as_args(v) for k, v in values.items()}
    return version, inipath, resolved, (inifile, positional, overrides)


# ---------------------------------------------------------------------------
# Per-generation resolution over iniconfig + tomllib/tomli: the fallback when
# pytest cannot be asked, and the agreement check when it can.

# (config names in precedence order, reads pytest 9 TOML formats, knows --config-file)
GENERATIONS = (
    (("pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"), False, False),  # pytest 6
    (("pytest.ini", ".pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"), False, True),  # 7-8
    (PYTEST9_FILES + ("pytest.ini", ".pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"), True, True),
)


def generation_load(path, pytest9, iniconfig, toml):
    READING["path"] = path
    try:
        return _generation_load(path, pytest9, iniconfig, toml)
    except Refusal:
        raise
    except Exception:
        raise Refusal("config-syntax", path)


def _generation_load(path, pytest9, iniconfig, toml):
    if path.suffix == ".ini":
        cfg = iniconfig.IniConfig(str(path))
        if "pytest" in cfg:
            return dict(cfg["pytest"].items())
        return {} if path.name in ("pytest.ini", ".pytest.ini") else None
    if path.suffix == ".cfg":
        cfg = iniconfig.IniConfig(str(path))
        if "tool:pytest" in cfg.sections:
            return dict(cfg["tool:pytest"].items())
        if "pytest" in cfg.sections:
            raise Refusal("config-syntax", path)
        return None
    if path.suffix == ".toml":
        if toml is None:
            raise Refusal("pytest-not-importable")
        data = toml.loads(path.read_text(encoding="utf-8"))
        if path.name in PYTEST9_FILES:
            return {k: ("toml", v) for k, v in data.get("pytest", {}).items()}
        tool_pytest = data.get("tool", {}).get("pytest", {})
        native = {k: v for k, v in tool_pytest.items() if k != "ini_options"} if pytest9 else {}
        ini = tool_pytest.get("ini_options")
        if native and ini is not None:
            raise Refusal("config-syntax", path)
        if native:
            return {k: ("toml", v) for k, v in native.items()}
        if ini is not None:
            return {k: (v if isinstance(v, list) else str(v)) for k, v in ini.items()}
    return None


def generation_resolve(root, request, generation, iniconfig, toml):
    names, pytest9, knows_config_file = GENERATIONS[generation]
    inifile, positional, overrides, via_config_file = request
    if via_config_file and not knows_config_file:
        inifile = None

    inipath, inicfg = None, {}
    if inifile:
        inipath = Path(os.path.abspath(inifile))
        if not os.path.isabs(inifile) and not inside(inipath, root):
            raise Refusal("bad-option")
        inicfg = generation_load(inipath, pytest9, iniconfig, toml) or {}
    else:
        candidates = [
            Path(os.path.abspath(a.split("::")[0])) for a in positional if not a.startswith("-")
        ]
        existing = [p if p.is_dir() else p.parent for p in candidates if p.exists()]
        start = Path(os.path.commonpath([str(p) for p in existing])) if existing else Path.cwd()
        found = False
        for base in (start, *start.parents):
            if not inside(base, root):
                break
            for name in names:
                p = base / name
                if p.is_file():
                    loaded = generation_load(p, pytest9, iniconfig, toml)
                    if loaded is not None:
                        inipath, inicfg, found = p, loaded, True
                        break
            if found:
                break

    values = {}
    for key in KEYS:
        if key in inicfg:
            v = inicfg[key]
            if isinstance(v, tuple):
                if not isinstance(v[1], list):
                    raise Refusal("bad-value", inipath)
                v = v[1]
            values[key] = v
    apply_overrides(values, overrides)
    return inipath, {k: as_args(v) for k, v in values.items()}


def generation_for(version):
    if version == "unknown":
        return None
    v = version_tuple(version)
    if v[0] > 9:
        raise Refusal("unsupported-pytest")  # no adapter for its precedence yet
    return 2 if v >= (9, 0) else 1 if v >= (7, 0) else 0


def require_agreement(ours, answers):
    """An answer with no values cannot narrow, so it never conflicts. Any two
    different non-empty answers, or an empty one of ours facing a non-empty one,
    mean the reading depends on which pytest runs: refuse."""
    seen = {json.dumps(v, sort_keys=True) for v in [ours] + answers if v}
    if len(seen) > 1 or (seen and not ours):
        raise Refusal("version-dependent")


def fallback_request(argv):
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument("-c", "--config-file", dest="inifilename")
    parser.add_argument("--rootdir")
    parser.add_argument("-o", "--override-ini", dest="override_ini", action="append")
    parser.add_argument("file_or_dir", nargs="*")
    ns, unknown = parser.parse_known_args(argv)
    return ns.inifilename, list(ns.file_or_dir) + list(unknown), ns.override_ini


def uses_config_file_flag(argv):
    return any(a == "--config-file" or a.startswith("--config-file=") for a in argv)


def main():
    try:
        request = json.loads(sys.stdin.buffer.read().decode("utf-8", "surrogateescape"))
        raw_root = request["root"]
        argv = [str(a) for a in request.get("args") or []]
        env_addopts = request.get("env_addopts")
    except Exception:
        emit({"ok": False, "config_file": None, "error": "bad-request"}, 2)
        return
    if not isinstance(raw_root, str) or not os.path.isabs(raw_root):
        emit({"ok": False, "config_file": None, "error": "relative-root"}, 2)
        return
    root = Path(raw_root).resolve()
    if not root.is_dir():
        emit({"ok": False, "config_file": None, "error": "not-a-directory"})
        return

    version = "unknown"
    try:
        if env_addopts:
            try:
                argv = shlex.split(env_addopts) + argv
            except ValueError:
                raise Refusal("bad-option")
        # pytest >= 8.2 reads more arguments from an @file; we do not follow it.
        if any(a.startswith("@") for a in argv):
            raise Refusal("argument-file")
        try:
            import _pytest
            import _pytest.config.findpaths  # noqa: F401

            version = getattr(_pytest, "__version__", "unknown")
            importable = True
        except Exception:
            importable = False
        try:
            import iniconfig
        except ImportError:
            iniconfig = None
        toml = load_toml_module()
        os.chdir(str(root))

        resolved = resolve_with_pytest(root, argv) if importable else None
        if resolved is not None:
            version, inipath, values, (inifile, positional, overrides) = resolved
            resolver = "pytest"
        else:
            inifile, positional, overrides = fallback_request(argv)
            resolver = "fallback"
        if iniconfig is None:
            raise Refusal("pytest-not-importable")

        gen_request = (inifile, positional, overrides, uses_config_file_flag(argv))
        answers = [generation_resolve(root, gen_request, g, iniconfig, toml) for g in range(3)]
        if resolved is None:
            known = generation_for(version)
            inipath, values = answers[known if known is not None else 0]
        require_agreement(values, [a[1] for a in answers])

        dirs = [root]
        if inipath is not None and inipath.parent != root:
            dirs.append(inipath.parent)
        if version != "unknown":
            refuse_pytest9_formats(version, dirs, toml)
    except Refusal as exc:
        path = exc.path if exc.path is not None else READING["path"]
        emit({"ok": False, "config_file": display(path, root), "error": exc.reason})
        return
    except BaseException as exc:
        if isinstance(exc, KeyboardInterrupt):
            raise
        emit({"ok": False, "config_file": display(READING["path"], root), "error": "internal-error"})
        return

    out = {"ok": True, "pytest": version, "resolver": resolver, "config_file": display(inipath, root)}
    for key in KEYS:
        out[key] = values.get(key)
    emit(out)


if __name__ == "__main__":
    main()
