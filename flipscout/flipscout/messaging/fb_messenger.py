"""Marketplace messaging through your own logged-in browser profile.

Best effort: Marketplace's page structure changes often. Every step verifies
itself; if anything is off, the caller saves a draft for you to send instead.
"""
from __future__ import annotations

import re
import sys
from typing import Optional


def send_message(page, listing_url: str, text: str) -> tuple[bool, Optional[str], str]:
    """Open the listing and send `text` to the seller. Returns (ok, thread_url, detail)."""
    try:
        page.goto(listing_url, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(3500)
        body = page.inner_text("body")
        if re.search(r"temporarily blocked|checkpoint|log in to continue", body, re.I):
            return False, None, "blocked or logged out"
        # Either an inline "Send seller a message" box, or a "Message" button that opens a chat.
        box = page.locator("textarea, div[role='textbox'][contenteditable='true']").first
        if box.count() == 0 or not box.is_visible():
            btn = page.get_by_role("button", name=re.compile(r"^(Message|Message seller|Send message)$", re.I)).first
            if btn.count() == 0:
                return False, None, "no message button found"
            btn.click(timeout=8000)
            page.wait_for_timeout(2500)
            box = page.locator("div[role='textbox'][contenteditable='true'], textarea").last
        if box.count() == 0:
            return False, None, "no message box found"
        box.click(timeout=8000)
        # clear any prefilled "Is this still available?" text
        page.keyboard.press("Meta+A" if sys.platform == "darwin" else "Control+A")
        page.keyboard.press("Backspace")
        for i, line in enumerate(text.split("\n")):
            if i:
                page.keyboard.press("Shift+Enter")
            if line:
                page.keyboard.type(line, delay=15)
        send = page.get_by_role("button", name=re.compile(r"^(Send|Send message)$", re.I)).first
        if send.count() and send.is_visible():
            send.click(timeout=8000)
        else:
            page.keyboard.press("Enter")
        page.wait_for_timeout(3500)
        probe = text.split("\n")[0][:40]
        if probe and probe not in page.inner_text("body"):
            return False, None, "sent text not visible afterwards; unverified"
        thread = None
        link = page.locator("a[href*='/messages/t/']").last
        if link.count():
            thread = link.get_attribute("href")
            if thread and thread.startswith("/"):
                thread = "https://www.facebook.com" + thread
        return True, thread, "sent"
    except Exception as e:  # pragma: no cover - live page only
        return False, None, f"{e.__class__.__name__}: {str(e)[:160]}"


def read_thread(page, thread_url: str) -> Optional[list[dict]]:
    """Return [{direction, text}] for a Messenger thread, or None if unreadable."""
    try:
        page.goto(thread_url, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(4000)
        rows = page.locator("div[role='row']")
        n = rows.count()
        if n == 0:
            return None
        out = []
        for i in range(max(0, n - 30), n):
            t = rows.nth(i).inner_text().strip()
            if not t:
                continue
            direction = "out" if re.match(r"^(You sent|You:)", t) else "in"
            t = re.sub(r"^(You sent|You:|.+? sent)\s*", "", t).strip()
            out.append({"direction": direction, "text": t})
        return out
    except Exception:  # pragma: no cover - live page only
        return None
