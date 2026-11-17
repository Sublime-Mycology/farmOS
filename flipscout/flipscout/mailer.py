"""Gmail SMTP (send) and IMAP (read Craigslist relay replies) with an App Password
kept in your OS keychain (or the FLIPSCOUT_GMAIL_APP_PASSWORD env var)."""
from __future__ import annotations

import email
import imaplib
import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import make_msgid, parseaddr
from typing import Optional


def app_password(cfg) -> Optional[str]:
    env = os.environ.get("FLIPSCOUT_GMAIL_APP_PASSWORD")
    if env:
        return env.replace(" ", "")
    try:
        import keyring
        user = cfg.owner.get("report_email") or ""
        pw = keyring.get_password(cfg.get("email.keyring_service", "flipscout-gmail"), user)
        return pw.replace(" ", "") if pw else None
    except Exception:
        return None


def store_app_password(cfg, password: str) -> None:
    import keyring
    keyring.set_password(cfg.get("email.keyring_service", "flipscout-gmail"), cfg.owner.get("report_email") or "",
                         password.replace(" ", ""))


def send_email(cfg, to: str, subject: str, text: str, html: Optional[str] = None,
               in_reply_to: Optional[str] = None) -> str:
    user = cfg.owner.get("report_email")
    pw = app_password(cfg)
    if not user or not pw:
        raise RuntimeError("Gmail not set up: run `flipscout email setup`")
    msg = EmailMessage()
    msg["From"] = user
    msg["To"] = to
    msg["Subject"] = subject
    msg_id = make_msgid(domain="flipscout.local")
    msg["Message-ID"] = msg_id
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = in_reply_to
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    ctx = ssl.create_default_context()
    with smtplib.SMTP_SSL(cfg.get("email.smtp_host", "smtp.gmail.com"), int(cfg.get("email.smtp_port", 465)),
                          context=ctx, timeout=30) as s:
        s.login(user, pw)
        s.send_message(msg)
    return msg_id


def fetch_replies(cfg, message_ids: dict[str, int], since_days: int = 14) -> list[dict]:
    """Find emails replying to our Craigslist messages. message_ids maps our
    Message-ID -> conversation id. Returns [{conversation_id, from, subject, body, message_id, date}]."""
    user = cfg.owner.get("report_email")
    pw = app_password(cfg)
    if not user or not pw or not message_ids:
        return []
    out = []
    import datetime as _dt
    since = (_dt.date.today() - _dt.timedelta(days=since_days)).strftime("%d-%b-%Y")
    with imaplib.IMAP4_SSL(cfg.get("email.imap_host", "imap.gmail.com")) as M:
        M.login(user, pw)
        M.select("INBOX", readonly=True)
        typ, data = M.search(None, f'(SINCE "{since}")')
        if typ != "OK":
            return []
        for num in data[0].split()[-400:]:
            typ, hdr = M.fetch(num, "(BODY.PEEK[HEADER.FIELDS (IN-REPLY-TO REFERENCES MESSAGE-ID FROM SUBJECT DATE)])")
            if typ != "OK" or not hdr or not hdr[0]:
                continue
            h = email.message_from_bytes(hdr[0][1])
            refs = f"{h.get('In-Reply-To', '')} {h.get('References', '')}"
            conv = next((cid for mid, cid in message_ids.items() if mid and mid in refs), None)
            if conv is None:
                continue
            typ, full = M.fetch(num, "(BODY.PEEK[])")
            msg = email.message_from_bytes(full[0][1])
            body = ""
            if msg.is_multipart():
                for part in msg.walk():
                    if part.get_content_type() == "text/plain":
                        body = part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", "replace")
                        break
            else:
                body = msg.get_payload(decode=True).decode(msg.get_content_charset() or "utf-8", "replace")
            out.append({"conversation_id": conv, "from": parseaddr(h.get("From", ""))[1], "subject": h.get("Subject", ""),
                        "body": strip_quoted(body), "message_id": h.get("Message-ID", ""), "date": h.get("Date", "")})
    return out


def strip_quoted(body: str) -> str:
    lines = []
    for ln in (body or "").splitlines():
        if ln.startswith(">") or (ln.startswith("On ") and ln.rstrip().endswith("wrote:")):
            break
        lines.append(ln)
    return "\n".join(lines).strip()
