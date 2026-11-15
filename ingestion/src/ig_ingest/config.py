"""Settings from environment variables, with an optional .env file in the working folder."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def load_dotenv(path: Path = Path(".env")) -> None:
    """Minimal .env reader: KEY=VALUE lines; real environment variables win."""
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


@dataclass
class Settings:
    apify_token: str | None
    data_dir: Path
    monthly_cap_usd: float
    run_budget_usd: float

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        return cls(
            apify_token=os.environ.get("APIFY_TOKEN") or None,
            data_dir=Path(os.environ.get("IG_DATA_DIR", "data")),
            # Apify's free plan gives $5 of credit a month; stay under it by default.
            monthly_cap_usd=float(os.environ.get("IG_MONTHLY_CAP_USD", "5")),
            run_budget_usd=float(os.environ.get("IG_RUN_BUDGET_USD", "1")),
        )

    @property
    def db_path(self) -> Path:
        return self.data_dir / "ig.db"
