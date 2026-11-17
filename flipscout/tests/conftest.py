import os
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures" / "demo"


@pytest.fixture
def cfg(tmp_path):
    from flipscout.config import load_config
    return load_config(ROOT, overrides={
        "owner": {"first_name": "Sam", "needs_owner_label": "NEEDS SAM", "report_email": "sam@example.invalid",
                  "home_zip": "00000", "home_lat": 38.4857, "home_lon": -78.6239},
        "llm": {"enabled": False},
        "storage": {"db_path": str(tmp_path / "t.db"), "reports_dir": str(tmp_path / "reports"),
                    "photos_dir": str(tmp_path / "photos"), "log_dir": str(tmp_path / "logs")},
        "virginia": {"insurance_cost_per_day": 3.0},
    })


@pytest.fixture
def db(cfg):
    from flipscout.db import DB
    return DB(cfg.path("storage.db_path"))
