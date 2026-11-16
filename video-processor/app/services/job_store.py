from __future__ import annotations

import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from threading import Event, Lock
from typing import Any, Literal, Optional


JobState = Literal["queued", "processing", "completed", "failed", "cancelled"]


class InMemoryJobStore:
    """Thread-safe processing status & cancellation store for Python worker jobs."""

    def __init__(self, max_entries: int = 500) -> None:
        self._lock = Lock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._runtimes: dict[str, dict[str, Any]] = {}
        self._max_entries = max_entries

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()

    def create(
        self,
        job_id: str,
        operation: str,
        *,
        stage: str = "queued",
        stage_label: str = "Queued",
        measurable: bool = False,
    ) -> dict[str, Any]:
        now = self._now_iso()
        record = {
            "job_id": job_id,
            "operation": operation,
            "status": "queued",
            "progress": 0,
            "stage": stage,
            "stage_label": stage_label,
            "measurable": measurable,
            "elapsed_ms": 0,
            "cancelled": False,
            "created_at": now,
            "updated_at": now,
            "error": None,
            "result": None,
        }
        runtime = {
            "cancel_event": Event(),
            "process": None,
            "job_dir": None,
            "created_mono": time.monotonic(),
            "finished_mono": None,
        }
        with self._lock:
            if len(self._jobs) >= self._max_entries:
                oldest_key = next(iter(self._jobs))
                self._jobs.pop(oldest_key, None)
                self._runtimes.pop(oldest_key, None)
            self._jobs[job_id] = record
            self._runtimes[job_id] = runtime
        return dict(record)

    def _compute_elapsed_ms(self, runtime: Optional[dict[str, Any]]) -> int:
        if not runtime:
            return 0
        end_mono = runtime.get("finished_mono") or time.monotonic()
        return max(0, int(round((end_mono - runtime["created_mono"]) * 1000)))

    def update(
        self,
        job_id: str,
        *,
        status: Optional[JobState] = None,
        progress: Optional[int] = None,
        stage: Optional[str] = None,
        stage_label: Optional[str] = None,
        measurable: Optional[bool] = None,
        cancelled: Optional[bool] = None,
        error: Optional[str] = None,
        result: Optional[dict[str, Any]] = None,
    ) -> Optional[dict[str, Any]]:
        with self._lock:
            record = self._jobs.get(job_id)
            if not record:
                return None
            runtime = self._runtimes.get(job_id)

            # Avoid overwriting a cancelled state back to processing during teardown
            if record.get("cancelled") and status == "processing":
                return dict(record)

            if status is not None:
                record["status"] = status
                if status in ("completed", "failed", "cancelled") and runtime is not None:
                    if runtime.get("finished_mono") is None:
                        runtime["finished_mono"] = time.monotonic()
            if progress is not None:
                record["progress"] = max(0, min(100, int(progress)))
            if stage is not None:
                record["stage"] = stage
            if stage_label is not None:
                record["stage_label"] = stage_label
            if measurable is not None:
                record["measurable"] = bool(measurable)
            if cancelled is not None:
                record["cancelled"] = bool(cancelled)
            if error is not None:
                record["error"] = error
            if result is not None:
                record["result"] = result
            record["elapsed_ms"] = self._compute_elapsed_ms(runtime)
            record["updated_at"] = self._now_iso()
            return dict(record)

    def get(self, job_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            record = self._jobs.get(job_id)
            if not record:
                return None
            runtime = self._runtimes.get(job_id)
            out = dict(record)
            if record.get("status") in ("queued", "processing"):
                out["elapsed_ms"] = self._compute_elapsed_ms(runtime)
            return out

    def get_cancel_event(self, job_id: str) -> Optional[Event]:
        with self._lock:
            runtime = self._runtimes.get(job_id)
            return runtime["cancel_event"] if runtime else None

    def register_job_dir(self, job_id: str, job_dir: Path) -> None:
        with self._lock:
            runtime = self._runtimes.get(job_id)
            if runtime is not None:
                runtime["job_dir"] = job_dir

    def attach_process(self, job_id: str, proc: Optional[subprocess.Popen[str]]) -> None:
        with self._lock:
            runtime = self._runtimes.get(job_id)
            if runtime is not None:
                runtime["process"] = proc

    def request_cancel(self, job_id: str) -> Optional[dict[str, Any]]:
        proc: Optional[subprocess.Popen[str]] = None
        job_dir: Optional[Path] = None

        with self._lock:
            record = self._jobs.get(job_id)
            runtime = self._runtimes.get(job_id)
            if not record:
                return None

            if runtime is not None:
                runtime["cancel_event"].set()
                proc = runtime.get("process")
                job_dir = runtime.get("job_dir")
                if runtime.get("finished_mono") is None:
                    runtime["finished_mono"] = time.monotonic()

            if record.get("status") in ("completed", "failed"):
                return dict(record)

            record["status"] = "cancelled"
            record["cancelled"] = True
            record["stage"] = "cancelled"
            record["stage_label"] = "Export cancelled"
            record["measurable"] = False
            record["error"] = "Export cancelled by user."
            record["elapsed_ms"] = self._compute_elapsed_ms(runtime)
            record["updated_at"] = self._now_iso()
            snapshot = dict(record)

        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=1.5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass

        if job_dir is not None and job_dir.exists() and (proc is None or proc.poll() is not None):
            shutil.rmtree(job_dir, ignore_errors=True)

        return snapshot


job_store = InMemoryJobStore()
