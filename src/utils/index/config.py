import os
from dataclasses import dataclass


@dataclass(frozen=True)
class IndexConfig:
    releases: tuple[str, ...] = ("qr3",)
    detectors: tuple[int, ...] = (6,)
    # Debug option: index only the N newest half-week folders per release.
    # A partial scope must not deprecate files outside it, so sweep is skipped when set.
    last_weeks: int | None = None

    dsn: str = os.getenv("SPHEREX_DSN", "postgresql://spherex:spherex@localhost:5435/spherex")
    bucket: str = "nasa-irsa-spherex"
    header_bytes: int = 30536

    workers: int = 128
    in_flight: int = 400    # > workers, so threads never wait for new tasks
    write_batch: int = 1000

    @property
    def is_full_scope(self) -> bool:
        return self.last_weeks is None

    @property
    def scope(self) -> str:
        return (f"releases={','.join(self.releases)}; "
                f"detectors={','.join(map(str, self.detectors))}; "
                f"last_weeks={self.last_weeks}")