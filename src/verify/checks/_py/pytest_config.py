"""Resolve the pytest configuration a test run would use, with pytest's own code.

Usage: pytest_config.py            (one JSON object on stdin)

Input:

    {"root": "<repo root>", "args": ["-q", ...], "env_addopts": "<PYTEST_ADDOPTS>" | null}

`args` is the argv pytest receives (everything after `pytest` / `-m pytest`);
`env_addopts` is prepended the way pytest prepends PYTEST_ADDOPTS.

Output, one JSON object on stdout, exit 0:

    {"ok": true, "pytest": "8.4.1", "resolver": "pytest" | "fallback",
     "config_file": "<path relative to root>" | null,
     "addopts": [...] | null, "testpaths": [...] | null, "python_files": [...] | null}

    {"ok": false, "config_file": "<path>" | null, "error": "<reason>"}

A value is null when the key is not set. `addopts`, `testpaths` and
`python_files` are pytest "args" options, returned exactly as pytest's getini
returns them: a TOML list as-is, an ini string through shlex.split.

WHY THIS EXISTS (#174). A line reader cannot reproduce how pytest reads its
config; it missed narrowing shapes (false SAFE) and misread neighbouring tables
(over-flooring). This asks pytest: `_pytest.config.findpaths.determine_setup`
chooses the file and parses it with pytest's own iniconfig/tomllib calls. When
that API is not recognised, a fallback built on iniconfig + tomllib/tomli applies
pytest's documented precedence and refuses when pytest versions would disagree.

FAIL CLOSED. Every failure is `ok: false` with a reason; the caller floors the
verdict on it. An empty answer must never stand in for "no narrowing".

Nothing here imports project code: no conftest, no entry-point plugins. The
caller spawns this with -E from a neutral cwd, and PYTHONPATH-derived sys.path
entries are dropped before anything else is imported, so a module in the
repository cannot shadow ours.
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

# pytest 9 formats, relevant when the installed pytest predates them.
PYTEST9_FILES = ("pytest.toml", ".pytest.toml")


class Refusal(Exception):
    """A reason the config cannot be read with certainty."""

    def __init__(self, message, path=None):
        super().__init__(message)
        self.path = path


# The config file being read when a failure happens, so the error can name it.
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
    # which is the resolved root, and a symlink is the shadow copy's business.
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
        return str(path)


def relative(message, root):
    return message.replace(str(root) + os.sep, "")


def version_tuple(text):
    out = []
    for part in text.split(".")[:2]:
        digits = "".join(ch for ch in part if ch.isdigit())
        out.append(int(digits) if digits else 0)
    return tuple(out)


def as_args(key, value):
    """pytest's getini coercion for an "args" option."""
    if isinstance(value, str):
        try:
            return shlex.split(value)
        except ValueError as exc:
            raise Refusal("{} cannot be split into arguments: {}".format(key, exc))
    if isinstance(value, list) and all(isinstance(v, str) for v in value):
        return list(value)
    raise Refusal("{} is not a string or a list of strings".format(key))


def apply_overrides(values, overrides):
    """-o/--override-ini for pytest < 9, where getini applies them itself."""
    for item in overrides or ():
        if "=" not in item:
            raise Refusal("-o/--override-ini expects option=value (got {!r})".format(item))
        key, value = item.split("=", 1)
        if key in KEYS:
            values[key] = value


def native_toml_table(path, toml):
    """Does this pyproject.toml carry a pytest 9 native [tool.pytest] table?"""
    data = toml.loads(path.read_text(encoding="utf-8"))
    tool_pytest = data.get("tool", {}).get("pytest", {})
    return isinstance(tool_pytest, dict) and any(k != "ini_options" for k in tool_pytest)


def refuse_pytest9_formats(version, dirs, toml):
    """A pytest older than 9 ignores pytest.toml and native [tool.pytest]. Their
    presence means the project expects a pytest this interpreter does not have."""
    if version_tuple(version) >= (9, 0):
        return
    for d in dirs:
        for name in PYTEST9_FILES:
            if (d / name).is_file():
                raise Refusal(
                    "{} is a pytest 9 config file and this interpreter has pytest {}, "
                    "which does not read it".format(name, version),
                    d / name,
                )
        pyproject = d / "pyproject.toml"
        if toml is not None and pyproject.is_file():
            try:
                native = native_toml_table(pyproject, toml)
            except Exception:
                continue  # pytest reports the parse error itself
            if native:
                raise Refusal(
                    "pyproject.toml has a pytest 9 [tool.pytest] table and this "
                    "interpreter has pytest {}, which does not read it".format(version),
                    pyproject,
                )


def resolve_with_pytest(root, argv):
    """Returns (version, inipath, values) using pytest's own resolution, or None
    when this pytest's API is not one we recognise."""
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
    parser = config._parser
    ns, unknown = parser.parse_known_and_unknown_args(argv, namespace=copy.copy(config.option))
    inifile = getattr(ns, "inifilename", None)
    rootdir_arg = getattr(ns, "rootdir", None) or None
    overrides = getattr(ns, "override_ini", None)

    explicit = None
    if inifile:
        explicit = Path(os.path.abspath(inifile))
        if not os.path.isabs(inifile) and not inside(explicit, root):
            raise Refusal("-c {} lies outside the repository".format(inifile))

    # The suite runs in a copy of the repository whose parents are temp dirs, so
    # a config above the root does not apply to it. Hide such files from the walk.
    def bounded_loader(path):
        path = Path(path)
        if not (explicit is not None and path == explicit) and not inside(path, root):
            return None
        READING["path"] = path
        return loader(path)

    findpaths.load_config_dict_from_file = bounded_loader
    try:
        if "override_ini" in params and "invocation_dir" in params:
            result = determine_setup(
                inifile=inifile,
                override_ini=overrides,
                args=ns.file_or_dir,
                rootdir_cmd_arg=rootdir_arg,
                invocation_dir=Path.cwd(),
            )
            overrides_applied = True
        elif "invocation_dir" in params:
            result = determine_setup(
                inifile=inifile,
                args=ns.file_or_dir + unknown,
                rootdir_cmd_arg=rootdir_arg,
                invocation_dir=Path.cwd(),
            )
            overrides_applied = False
        elif params[:3] == ["inifile", "args", "rootdir_cmd_arg"]:
            result = determine_setup(inifile, ns.file_or_dir + unknown, rootdir_cmd_arg=rootdir_arg)
            overrides_applied = False
        else:
            return None
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
                raise Refusal("{} must be a list in a native TOML pytest table".format(key))
            values[key] = entry.value
        else:
            values[key] = entry
    if not overrides_applied:
        apply_overrides(values, overrides)
    return version, inipath, {k: as_args(k, v) for k, v in values.items()}


# ---------------------------------------------------------------------------
# Fallback: pytest's documented precedence over iniconfig + tomllib/tomli.

# (config names in precedence order, reads pytest 9 TOML formats)
GENERATIONS = (
    (("pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"), False),  # pytest 6
    (("pytest.ini", ".pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"), False),  # 7-8
    (PYTEST9_FILES + ("pytest.ini", ".pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"), True),
)


def fallback_load(path, pytest9, iniconfig, toml):
    READING["path"] = path
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
            raise Refusal("setup.cfg uses a [pytest] section, which pytest rejects", path)
        return None
    if path.suffix == ".toml":
        if toml is None:
            raise Refusal("no TOML parser (tomllib or tomli) is available")
        data = toml.loads(path.read_text(encoding="utf-8"))
        if path.name in PYTEST9_FILES:
            table = data.get("pytest", {})
            return {k: ("toml", v) for k, v in table.items()}
        tool_pytest = data.get("tool", {}).get("pytest", {})
        native = {k: v for k, v in tool_pytest.items() if k != "ini_options"} if pytest9 else {}
        ini = tool_pytest.get("ini_options")
        if native and ini is not None:
            raise Refusal("pyproject.toml uses both [tool.pytest] and [tool.pytest.ini_options]")
        if native:
            return {k: ("toml", v) for k, v in native.items()}
        if ini is not None:
            return {k: (v if isinstance(v, list) else str(v)) for k, v in ini.items()}
    return None


def fallback_resolve(root, argv, names, pytest9, iniconfig, toml):
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument("-c", "--config-file", dest="inifilename")
    parser.add_argument("--rootdir")
    parser.add_argument("-o", "--override-ini", dest="override_ini", action="append")
    parser.add_argument("file_or_dir", nargs="*")
    ns, _ = parser.parse_known_args(argv)

    inipath, inicfg = None, {}
    if ns.inifilename:
        inipath = Path(os.path.abspath(ns.inifilename))
        if not os.path.isabs(ns.inifilename) and not inside(inipath, root):
            raise Refusal("-c {} lies outside the repository".format(ns.inifilename))
        inicfg = fallback_load(inipath, pytest9, iniconfig, toml) or {}
    else:
        existing = [Path(os.path.abspath(a.split("::")[0])) for a in ns.file_or_dir]
        existing = [p if p.is_dir() else p.parent for p in existing if p.exists()]
        start = Path(os.path.commonpath([str(p) for p in existing])) if existing else Path.cwd()
        found = False
        for base in (start, *start.parents):
            if not inside(base, root):
                break
            for name in names:
                p = base / name
                if p.is_file():
                    loaded = fallback_load(p, pytest9, iniconfig, toml)
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
                    raise Refusal("{} must be a list in a native TOML pytest table".format(key))
                v = v[1]
            values[key] = v
    apply_overrides(values, ns.override_ini)
    READING["path"] = inipath
    return inipath, {k: as_args(k, v) for k, v in values.items()}


def generation_for(version):
    if version == "unknown":
        return None
    v = version_tuple(version)
    return 2 if v >= (9, 0) else 1 if v >= (7, 0) else 0


def resolve_fallback(root, argv, version):
    try:
        import iniconfig
    except ImportError:
        raise Refusal("neither pytest's config code nor iniconfig is importable")
    toml = load_toml_module()
    known = generation_for(version)
    if known is not None:
        names, pytest9 = GENERATIONS[known]
        return fallback_resolve(root, argv, names, pytest9, iniconfig, toml)
    # No pytest to ask: answer only if every pytest generation would agree.
    answers = [fallback_resolve(root, argv, n, p9, iniconfig, toml) for n, p9 in GENERATIONS]
    if any(a != answers[0] for a in answers[1:]):
        raise Refusal("which config pytest reads depends on its version, which is unknown")
    return answers[0]


def main():
    try:
        request = json.loads(sys.stdin.buffer.read().decode("utf-8", "surrogateescape"))
        root = Path(request["root"]).resolve()
        argv = [str(a) for a in request.get("args") or []]
        env_addopts = request.get("env_addopts")
    except Exception as exc:
        emit({"ok": False, "config_file": None, "error": "bad request: {}".format(exc)}, 2)
        return

    if not root.is_dir():
        emit({"ok": False, "config_file": None, "error": "root is not a directory"})
        return

    try:
        if env_addopts:
            argv = shlex.split(env_addopts) + argv
    except ValueError as exc:
        emit({"ok": False, "config_file": None, "error": "PYTEST_ADDOPTS: {}".format(exc)})
        return

    version = "unknown"
    try:
        try:
            import _pytest
            import _pytest.config.findpaths  # noqa: F401

            version = getattr(_pytest, "__version__", "unknown")
            importable = True
        except Exception:
            importable = False
        os.chdir(str(root))
        resolved = resolve_with_pytest(root, argv) if importable else None
        if resolved is not None:
            version, inipath, values = resolved
            resolver = "pytest"
        else:
            inipath, values = resolve_fallback(root, argv, version)
            resolver = "fallback"
        dirs = [root]
        if inipath is not None and inipath.parent != root:
            dirs.append(inipath.parent)
        if version != "unknown":
            refuse_pytest9_formats(version, dirs, load_toml_module())
    except Refusal as exc:
        path = exc.path if exc.path is not None else READING["path"]
        emit({"ok": False, "config_file": display(path, root), "error": relative(str(exc), root)})
        return
    except BaseException as exc:  # pytest's fail() raises a BaseException subclass
        if isinstance(exc, KeyboardInterrupt):
            raise
        message = relative(str(exc).strip(), root) or type(exc).__name__
        emit(
            {
                "ok": False,
                "config_file": display(READING["path"], root),
                "error": "{}: {}".format(type(exc).__name__, message),
            }
        )
        return

    out = {"ok": True, "pytest": version, "resolver": resolver, "config_file": display(inipath, root)}
    for key in KEYS:
        out[key] = values.get(key)
    emit(out)


if __name__ == "__main__":
    main()
