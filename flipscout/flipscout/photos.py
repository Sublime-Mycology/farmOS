"""Photo download + perceptual hash (dHash) for duplicate / reused-photo checks."""
from __future__ import annotations

import hashlib
import io
import urllib.request
from pathlib import Path
from typing import Optional


def dhash_bytes(data: bytes, size: int = 8) -> Optional[str]:
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(data)).convert("L").resize((size + 1, size))
    except Exception:
        return None
    px = list(img.getdata())
    bits = 0
    for row in range(size):
        for col in range(size):
            left = px[row * (size + 1) + col]
            right = px[row * (size + 1) + col + 1]
            bits = (bits << 1) | (1 if left > right else 0)
    return f"{bits:016x}"


def hamming(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")


def download(url: str, dest_dir: Path, timeout: int = 20) -> Optional[tuple[Path, bytes]]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read(5_000_000)
    except Exception:
        return None
    dest_dir.mkdir(parents=True, exist_ok=True)
    name = hashlib.sha1(url.encode()).hexdigest()[:16] + ".jpg"
    p = dest_dir / name
    p.write_bytes(data)
    return p, data
