"""Load config.yaml + config.local.yaml, resolve paths, and track VERIFY items."""
from __future__ import annotations

import copy
import os
import re
from pathlib import Path
from typing import Any

import yaml


def project_root() -> Path:
    env = os.environ.get("FLIPSCOUT_HOME")
    if env:
        return Path(env).expanduser().resolve()
    # Editable install / source checkout: <root>/flipscout/config.py -> <root>
    here = Path(__file__).resolve().parent.parent
    if (here / "config.yaml").exists():
        return here
    cwd = Path.cwd()
    for p in [cwd, *cwd.parents]:
        if (p / "config.yaml").exists() and (p / "flipscout").is_dir():
            return p
    return here


def _deep_merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def find_verify_keys(yaml_text: str) -> list[str]:
    """Return dotted key paths of lines tagged with '# VERIFY' (indent-tracked)."""
    stack: list[tuple[int, str]] = []
    found: list[str] = []
    for raw in yaml_text.splitlines():
        line = raw.rstrip()
        stripped = line.lstrip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(stripped)
        m = re.match(r"(-\s+)?([A-Za-z0-9_\-]+)\s*:", stripped)
        if stripped.startswith("- ") and not m:
            # list item under current key
            if "VERIFY" in line and stack:
                found.append(".".join(k for _, k in stack))
            continue
        if not m:
            continue
        key = m.group(2)
        while stack and stack[-1][0] >= indent:
            stack.pop()
        stack.append((indent, key))
        if "# VERIFY" in line or "VERIFY" in line.split("#", 1)[-1] and "#" in line:
            found.append(".".join(k for _, k in stack))
    # de-dup preserving order
    seen, out = set(), []
    for k in found:
        if k not in seen:
            seen.add(k)
            out.append(k)
    return out


class Config:
    def __init__(self, data: dict, root: Path, verify_keys: list[str]):
        self.data = data
        self.root = root
        self._verify_keys = verify_keys

    # dotted access: cfg.get("profit.min_net_profit")
    def get(self, dotted: str, default: Any = None) -> Any:
        cur: Any = self.data
        for part in dotted.split("."):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            else:
                return default
        return cur

    def __getitem__(self, key: str) -> Any:
        return self.data[key]

    def path(self, dotted: str, default: str = "") -> Path:
        raw = self.get(dotted, default) or default
        p = Path(os.path.expanduser(str(raw)))
        return p if p.is_absolute() else (self.root / p)

    @property
    def dry_run(self) -> bool:
        return bool(self.get("mode.dry_run", True))

    @property
    def owner(self) -> dict:
        return self.get("owner", {}) or {}

    @property
    def needs_label(self) -> str:
        label = self.owner.get("needs_owner_label") or ""
        if label:
            return label
        name = (self.owner.get("first_name") or "").strip()
        return f"NEEDS {name.upper()}" if name else "NEEDS YOU"

    def unverified(self) -> list[str]:
        verified = set(self.get("verified_keys", []) or [])
        return [k for k in self._verify_keys if k not in verified]

    def home(self) -> tuple[float, float] | None:
        lat, lon = self.owner.get("home_lat"), self.owner.get("home_lon")
        if lat in (None, 0, 0.0) or lon in (None, 0, 0.0):
            return None
        return float(lat), float(lon)


def load_config(root: Path | None = None, overrides: dict | None = None) -> Config:
    root = Path(root) if root else project_root()
    main = root / "config.yaml"
    if not main.exists():
        raise FileNotFoundError(f"config.yaml not found in {root}")
    text = main.read_text(encoding="utf-8")
    data = yaml.safe_load(text) or {}
    verify = find_verify_keys(text)
    local = root / "config.local.yaml"
    if local.exists():
        ltext = local.read_text(encoding="utf-8")
        data = _deep_merge(data, yaml.safe_load(ltext) or {})
        verify += [k for k in find_verify_keys(ltext) if k not in verify]
    if overrides:
        data = _deep_merge(data, overrides)
    return Config(data, root, verify)
