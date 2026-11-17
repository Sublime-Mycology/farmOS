"""Page fetching. A real browser (your profile) in production; HTML files in tests.

No proxies, no stealth/fingerprint plugins, no CAPTCHA solving. If a page looks
like a block, login wall or challenge, we raise SourceBlocked and the caller
stops that source for the day.
"""
from __future__ import annotations

import json
import random
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from bs4 import BeautifulSoup


class SourceBlocked(Exception):
    """The site showed a block, login wall, checkpoint or CAPTCHA."""


@dataclass
class Snapshot:
    url: str
    html: str
    text: str
    links: list = field(default_factory=list)    # [(href, inner_text)]
    images: list = field(default_factory=list)   # [(src, alt)]
    status: Optional[int] = None


BLOCK_TEXT = [
    (r"you(?:'|’)re temporarily blocked", "Facebook: temporarily blocked"),
    (r"we limit how often you can post, comment or do other things", "Facebook: rate limited"),
    (r"confirm (?:your|it'?s) (?:identity|you)", "Facebook: identity checkpoint"),
    (r"this ip has been automatically blocked", "Craigslist: IP blocked"),
    (r"your request has been blocked", "Site: request blocked"),
    (r"verify (?:that )?you are (?:a )?human", "CAPTCHA / human check"),
    (r"are you a robot", "CAPTCHA / robot check"),
    (r"unusual traffic", "Site: unusual traffic notice"),
    (r"access denied", "Site: access denied"),
]


def detect_block(snap: Snapshot, source: str) -> Optional[str]:
    if snap.status in (403, 429):
        return f"HTTP {snap.status} from {source}"
    low = (snap.text or "").lower()[:20000]
    for pat, label in BLOCK_TEXT:
        if re.search(pat, low):
            return label
    url = (snap.url or "").lower()
    if source == "facebook":
        if "/checkpoint" in url:
            return "Facebook: checkpoint page"
        if "/login" in url or ('name="pass"' in snap.html and 'name="email"' in snap.html):
            return "Facebook: not logged in (run `flipscout login`)"
    if "captcha" in url:
        return "CAPTCHA page"
    return None


def _soup_snapshot(url: str, html: str, status: Optional[int] = 200) -> Snapshot:
    soup = BeautifulSoup(html, "html.parser")
    for s in soup(["script", "style", "noscript", "template"]):
        s.decompose()
    links = [(a.get("href", ""), a.get_text("\n", strip=True)) for a in soup.find_all("a")]
    images = [(i.get("src", ""), i.get("alt", "")) for i in soup.find_all("img")]
    text = soup.get_text("\n", strip=True)
    return Snapshot(url=url, html=html, text=text, links=links, images=images, status=status)


class FixtureFetcher:
    """Serves saved HTML files. manifest.json maps URL -> filename."""

    def __init__(self, directory: Path):
        self.dir = Path(directory)
        mf = self.dir / "manifest.json"
        self.manifest = json.loads(mf.read_text()) if mf.exists() else {}
        self.requests: list[str] = []

    def get(self, url: str, scrolls: int = 0, source: str = "") -> Snapshot:
        self.requests.append(url)
        fname = self.manifest.get(url)
        if fname is None:
            for pattern, f in self.manifest.items():
                if pattern.endswith("*") and url.startswith(pattern[:-1]):
                    fname = f
                    break
        if fname is None:
            return Snapshot(url=url, html="", text="", status=404)
        html = (self.dir / fname).read_text(encoding="utf-8")
        snap = _soup_snapshot(url, html)
        block = detect_block(snap, source)
        if block:
            raise SourceBlocked(block)
        return snap

    def polite_pause(self) -> None:
        pass

    def close(self) -> None:
        pass


_SNAPSHOT_JS = """
() => {
  const links = Array.from(document.querySelectorAll('a[href]')).map(a => [a.href, a.innerText || '']);
  const images = Array.from(document.querySelectorAll('img')).map(i => [i.currentSrc || i.src || '', i.alt || '']);
  return {text: document.body ? document.body.innerText : '', links, images};
}
"""


class BrowserFetcher:
    """Playwright Chromium with a persistent profile you log into yourself."""

    def __init__(self, profile_dir: Path, headless: bool = False, min_delay: float = 4.0,
                 max_delay: float = 9.0, executable_path: Optional[str] = None,
                 log: Callable[[str], None] = print):
        from playwright.sync_api import sync_playwright

        self.min_delay, self.max_delay = min_delay, max_delay
        self.log = log
        profile_dir = Path(profile_dir).expanduser()
        profile_dir.mkdir(parents=True, exist_ok=True)
        self._pw = sync_playwright().start()
        kwargs = dict(user_data_dir=str(profile_dir), headless=headless,
                      viewport={"width": 1280, "height": 900}, locale="en-US",
                      timezone_id="America/New_York")
        if executable_path:
            kwargs["executable_path"] = executable_path
        self.context = self._pw.chromium.launch_persistent_context(**kwargs)
        self.page = self.context.pages[0] if self.context.pages else self.context.new_page()
        self._last = 0.0

    def polite_pause(self) -> None:
        wait = random.uniform(self.min_delay, self.max_delay)
        elapsed = time.monotonic() - self._last
        if elapsed < wait:
            time.sleep(wait - elapsed)
        self._last = time.monotonic()

    def get(self, url: str, scrolls: int = 0, source: str = "") -> Snapshot:
        self.polite_pause()
        resp = self.page.goto(url, wait_until="domcontentloaded", timeout=45000)
        try:
            self.page.wait_for_load_state("networkidle", timeout=8000)
        except Exception:
            pass
        for _ in range(max(0, scrolls)):
            self.page.mouse.wheel(0, 2200)
            time.sleep(random.uniform(1.5, 3.0))
        data = self.page.evaluate(_SNAPSHOT_JS)
        snap = Snapshot(url=self.page.url, html=self.page.content(), text=data["text"],
                        links=[tuple(x) for x in data["links"]], images=[tuple(x) for x in data["images"]],
                        status=resp.status if resp else None)
        block = detect_block(snap, source)
        if block:
            raise SourceBlocked(block)
        return snap

    def close(self) -> None:
        try:
            self.context.close()
        finally:
            self._pw.stop()
