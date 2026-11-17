"""Install the daily jobs in your OS scheduler (launchd / Task Scheduler / cron)."""
from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from datetime import date, datetime, time as dtime
from pathlib import Path
from zoneinfo import ZoneInfo

LABEL = "com.flipscout"
JOBS = {"run": "scan_time", "outreach": "outreach_time"}


def local_time_for(cfg, hhmm: str) -> tuple[int, int, str]:
    """Convert an America/New_York HH:MM to this computer's local time (today's offset)."""
    tz = ZoneInfo(cfg.get("schedule.timezone", "America/New_York"))
    h, m = map(int, hhmm.split(":"))
    et = datetime.combine(date.today(), dtime(h, m), tz)
    loc = et.astimezone()
    note = ""
    if loc.utcoffset() != et.utcoffset():
        note = (f"Your computer's time zone differs from {tz.key}; scheduled at local {loc:%H:%M}. "
                f"Re-run `flipscout schedule install` after daylight-saving changes.")
    return loc.hour, loc.minute, note


def job_times(cfg) -> dict[str, str]:
    times = {name: str(cfg.get(f"schedule.{key}")) for name, key in JOBS.items()}
    for i, t in enumerate(cfg.get("schedule.followup_inbox_passes", []) or []):
        times[f"inbox{i + 1}"] = str(t)
    return times


def _cmd(job: str) -> list[str]:
    return [sys.executable, "-m", "flipscout", "outreach" if job.startswith("inbox") else job]


# ---- macOS -----------------------------------------------------------------------------
def _plist(cfg, job: str, hh: int, mm: int, root: Path) -> str:
    logs = cfg.path("storage.log_dir", "data/logs")
    logs.mkdir(parents=True, exist_ok=True)
    args = "".join(f"<string>{a}</string>" for a in _cmd(job))
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>{LABEL}.{job}</string>
  <key>ProgramArguments</key><array>{args}</array>
  <key>WorkingDirectory</key><string>{root}</string>
  <key>EnvironmentVariables</key><dict><key>FLIPSCOUT_HOME</key><string>{root}</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>{hh}</integer><key>Minute</key><integer>{mm}</integer></dict>
  <key>StandardOutPath</key><string>{logs / f'{job}.out.log'}</string>
  <key>StandardErrorPath</key><string>{logs / f'{job}.err.log'}</string>
</dict></plist>
"""


def install(cfg) -> list[str]:
    root = cfg.root
    msgs = []
    system = platform.system()
    times = job_times(cfg)
    if system == "Darwin":
        agents = Path.home() / "Library" / "LaunchAgents"
        agents.mkdir(parents=True, exist_ok=True)
        for job, hhmm in times.items():
            hh, mm, note = local_time_for(cfg, hhmm)
            p = agents / f"{LABEL}.{job}.plist"
            subprocess.run(["launchctl", "unload", str(p)], capture_output=True)
            p.write_text(_plist(cfg, job, hh, mm, root))
            r = subprocess.run(["launchctl", "load", "-w", str(p)], capture_output=True, text=True)
            msgs.append(f"{job}: daily at {hh:02d}:{mm:02d} local ({'loaded' if r.returncode == 0 else 'load failed: ' + r.stderr.strip()})")
            if note:
                msgs.append(note)
        msgs.append("To wake the Mac before the 6:00 run, run this once (asks for your password):\n"
                    "    sudo pmset repeat wakeorpoweron MTWRFSU 05:55:00")
    elif system == "Windows":
        import tempfile
        for job, hhmm in times.items():
            hh, mm, note = local_time_for(cfg, hhmm)
            cmd = _cmd(job)
            xml = f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><CalendarTrigger><StartBoundary>{date.today().isoformat()}T{hh:02d}:{mm:02d}:00</StartBoundary>
    <Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>
  <Settings><WakeToRun>true</WakeToRun><StartWhenAvailable>true</StartWhenAvailable>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit><Enabled>true</Enabled></Settings>
  <Actions><Exec><Command>{cmd[0]}</Command><Arguments>{' '.join(cmd[1:])}</Arguments>
    <WorkingDirectory>{root}</WorkingDirectory></Exec></Actions>
</Task>"""
            f = Path(tempfile.gettempdir()) / f"flipscout-{job}.xml"
            f.write_text(xml, encoding="utf-16")
            r = subprocess.run(["schtasks", "/Create", "/TN", f"flipscout {job}", "/XML", str(f), "/F"], capture_output=True, text=True)
            msgs.append(f"{job}: daily at {hh:02d}:{mm:02d} local, wakes the PC ({'created' if r.returncode == 0 else 'failed: ' + (r.stderr or r.stdout).strip()})")
            if note:
                msgs.append(note)
        msgs.append("Windows only wakes for tasks if 'Allow wake timers' is enabled in Power Options (Sleep settings).")
    else:
        if not shutil.which("crontab"):
            return ["crontab not found; install cron or schedule `python -m flipscout run` yourself."]
        cur = subprocess.run(["crontab", "-l"], capture_output=True, text=True).stdout
        kept = [ln for ln in cur.splitlines() if "flipscout" not in ln]
        tz = cfg.get("schedule.timezone", "America/New_York")
        new = [f"CRON_TZ={tz}"]
        for job, hhmm in times.items():
            hh, mm = map(int, hhmm.split(":"))
            new.append(f"{mm} {hh} * * * cd {root} && FLIPSCOUT_HOME={root} {' '.join(_cmd(job))} >> {root}/data/logs/{job}.log 2>&1  # flipscout")
        subprocess.run(["crontab", "-"], input="\n".join(kept + new) + "\n", text=True)
        msgs += [f"{job}: daily at {hhmm} {tz}" for job, hhmm in times.items()]
    return msgs


def remove(cfg) -> list[str]:
    system = platform.system()
    msgs = []
    if system == "Darwin":
        for p in (Path.home() / "Library" / "LaunchAgents").glob(f"{LABEL}.*.plist"):
            subprocess.run(["launchctl", "unload", "-w", str(p)], capture_output=True)
            p.unlink()
            msgs.append(f"removed {p.name}")
    elif system == "Windows":
        for job in job_times(cfg):
            r = subprocess.run(["schtasks", "/Delete", "/TN", f"flipscout {job}", "/F"], capture_output=True, text=True)
            msgs.append(f"flipscout {job}: {'removed' if r.returncode == 0 else 'not found'}")
    else:
        if not shutil.which("crontab"):
            return ["crontab not installed on this machine"]
        cur = subprocess.run(["crontab", "-l"], capture_output=True, text=True).stdout
        kept = [ln for ln in cur.splitlines() if "flipscout" not in ln and not ln.startswith("CRON_TZ=")]
        subprocess.run(["crontab", "-"], input="\n".join(kept) + "\n", text=True)
        msgs.append("removed flipscout cron lines")
    return msgs or ["nothing to remove"]


def status(cfg) -> list[str]:
    system = platform.system()
    if system == "Darwin":
        r = subprocess.run(["launchctl", "list"], capture_output=True, text=True).stdout
        found = [ln for ln in r.splitlines() if LABEL in ln]
        return found or ["no flipscout jobs loaded"]
    if system == "Windows":
        out = []
        for job in job_times(cfg):
            r = subprocess.run(["schtasks", "/Query", "/TN", f"flipscout {job}"], capture_output=True, text=True)
            out.append(f"flipscout {job}: {'installed' if r.returncode == 0 else 'not installed'}")
        return out
    if not shutil.which("crontab"):
        return ["crontab not installed on this machine"]
    r = subprocess.run(["crontab", "-l"], capture_output=True, text=True).stdout
    return [ln for ln in r.splitlines() if "flipscout" in ln] or ["no flipscout cron lines"]
