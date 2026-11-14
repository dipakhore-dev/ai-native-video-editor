from __future__ import annotations

from datetime import datetime, timezone
from threading import Lock
from typing import Any, Literal, Optional


JobState = Literal["queued", "processing", "completed", "failed"]


class InMemoryJobStore:
    """Thread-safe processing status store for Python worker jobs."""

    def __init__(self, max_entries: int = 500) -> None:
        self._lock = Lock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._max_entries = max_entries

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()

    def create(self, job_id: str, operation: str) -> dict[str, Any]:
        now = self._now_iso()
        record = {
            "job_id": job_id,
            "operation": operation,
            "status": "queued",
            "progress": 0,
            "created_at": now,
            "updated_at": now,
            "error": None,
            "result": None,
        }
        with self._lock:
            if len(self._jobs) >= self._max_entries:
                oldest_key = next(iter(self._jobs))
                self._jobs.pop(oldest_key, None)
            self._jobs[job_id] = record
        return dict(record)

    def update(
        self,
        job_id: str,
        *,
        status: Optional[JobState] = None,
        progress: Optional[int] = None,
        error: Optional[str] = None,
        result: Optional[dict[str, Any]] = None,
    ) -> Optional[dict[str, Any]]:
        with self._lock:
            record = self._jobs.get(job_id)
            if not record:
                return None
            if status is not None:
                record["status"] = status
            if progress is not None:
                record["progress"] = max(0, min(100, progress))
            if error is not None:
                record["error"] = error
            if result is not None:
                record["result"] = result
            record["updated_at"] = self._now_iso()
            return dict(record)

    def get(self, job_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            record = self._jobs.get(job_id)
            return dict(record) if record else None


job_store = InMemoryJobStore()
