from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from threading import Event, Lock
from typing import Any, Literal, Optional


JobState = Literal["queued", "processing", "completed", "failed", "cancelled"]


def terminate_subprocess_tree(proc: Optional[subprocess.Popen[Any]], *, wait_sec: float = 1.5) -> None:
    """Safely terminate an FFmpeg subprocess and any child processes across Windows and POSIX."""
    if proc is None:
        return
    try:
        if proc.poll() is not None:
            try:
                proc.wait(timeout=0.5)
            except Exception:
                pass
            return

        if sys.platform == "win32" or os.name == "nt":
            try:
                proc.terminate()
                proc.wait(timeout=min(0.8, wait_sec))
            except Exception:
                pass
            if proc.poll() is None:
                try:
                    subprocess.run(
                        ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                        capture_output=True,
                        timeout=3,
                        check=False,
                    )
                except Exception:
                    pass
            if proc.poll() is None:
                try:
                    proc.kill()
                except Exception:
                    pass
            try:
                proc.wait(timeout=1.5)
            except Exception:
                pass
        else:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except Exception:
                try:
                    proc.terminate()
                except Exception:
                    pass
            try:
                proc.wait(timeout=wait_sec)
            except Exception:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                try:
                    proc.wait(timeout=1.5)
                except Exception:
                    pass
    except Exception:
        pass


def _safe_rmtree(target: Path, retries: int = 3) -> None:
    for attempt in range(retries):
        if not target.exists():
            return
        try:
            shutil.rmtree(target, ignore_errors=(attempt < retries - 1))
            if not target.exists():
                return
        except OSError:
            pass
        time.sleep(0.05 * (attempt + 1))
    shutil.rmtree(target, ignore_errors=True)


class InMemoryJobStore:
    """Thread-safe processing status & cancellation store for Python worker jobs."""

    def __init__(self, max_entries: int = 500) -> None:
        self._lock = Lock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._runtimes: dict[str, dict[str, Any]] = {}
        self._pre_cancelled: dict[str, float] = {}
        self._max_entries = max_entries

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()

    def _prune_tombstones_locked(self) -> None:
        cutoff = time.monotonic() - 600.0
        stale = [k for k, ts in self._pre_cancelled.items() if ts < cutoff]
        for k in stale:
            self._pre_cancelled.pop(k, None)

    def create(
        self,
        job_id: str,
        operation: str,
        *,
        stage: str = "queued",
        stage_label: str = "Queued",
        measurable: bool = False,
        if_missing: bool = False,
    ) -> dict[str, Any]:
        now = self._now_iso()
        with self._lock:
            self._prune_tombstones_locked()
            existing = self._jobs.get(job_id)
            if if_missing and existing is not None:
                return dict(existing)

            was_pre_cancelled = self._pre_cancelled.pop(job_id, None) is not None
            cancel_event = Event()
            if was_pre_cancelled:
                cancel_event.set()

            record = {
                "job_id": job_id,
                "operation": operation,
                "status": "cancelled" if was_pre_cancelled else "queued",
                "progress": 0,
                "stage": "cancelled" if was_pre_cancelled else stage,
                "stage_label": "Export cancelled" if was_pre_cancelled else stage_label,
                "measurable": False if was_pre_cancelled else measurable,
                "elapsed_ms": 0,
                "cancelled": was_pre_cancelled,
                "created_at": now,
                "updated_at": now,
                "error": "Export cancelled by user." if was_pre_cancelled else None,
                "result": None,
            }
            runtime = {
                "cancel_event": cancel_event,
                "process": None,
                "job_dir": None,
                "worker_active": False,
                "cleanup_pending": False,
                "created_mono": time.monotonic(),
                "finished_mono": time.monotonic() if was_pre_cancelled else None,
            }
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

    def is_cancelled(self, job_id: str) -> bool:
        with self._lock:
            if job_id in self._pre_cancelled:
                return True
            record = self._jobs.get(job_id)
            runtime = self._runtimes.get(job_id)
            if record and (record.get("cancelled") or record.get("status") == "cancelled"):
                return True
            if runtime and runtime["cancel_event"].is_set():
                return True
            return False

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

            # Enforce strict terminal state immutability: cancelled cannot revert to processing/completed/failed
            if record.get("cancelled") or record.get("status") == "cancelled":
                if status in ("queued", "processing", "completed", "failed"):
                    return dict(record)
            if record.get("status") == "completed" and status == "cancelled":
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

    def mark_worker_started(self, job_id: str) -> None:
        with self._lock:
            runtime = self._runtimes.get(job_id)
            if runtime is not None:
                runtime["worker_active"] = True

    def mark_worker_finished(self, job_id: str) -> None:
        job_dir_to_clean: Optional[Path] = None
        with self._lock:
            runtime = self._runtimes.get(job_id)
            if runtime is not None:
                runtime["worker_active"] = False
                if runtime.get("cleanup_pending") and runtime.get("job_dir") is not None:
                    job_dir_to_clean = runtime["job_dir"]
                    runtime["cleanup_pending"] = False
        if job_dir_to_clean is not None:
            _safe_rmtree(job_dir_to_clean)

    def attach_process(self, job_id: str, proc: Optional[subprocess.Popen[Any]]) -> None:
        should_kill = False
        with self._lock:
            runtime = self._runtimes.get(job_id)
            if runtime is not None:
                runtime["process"] = proc
                if proc is not None and runtime["cancel_event"].is_set():
                    should_kill = True
        if should_kill and proc is not None:
            terminate_subprocess_tree(proc)

    def request_cancel(
        self,
        job_id: str,
        *,
        allow_precreate: bool = False,
    ) -> Optional[dict[str, Any]]:
        proc: Optional[subprocess.Popen[Any]] = None
        job_dir: Optional[Path] = None
        worker_active = False

        with self._lock:
            self._prune_tombstones_locked()
            record = self._jobs.get(job_id)
            runtime = self._runtimes.get(job_id)
            if not record:
                if not allow_precreate:
                    return None
                self._pre_cancelled[job_id] = time.monotonic()
                now = self._now_iso()
                return {
                    "job_id": job_id,
                    "operation": "export_mp4",
                    "status": "cancelled",
                    "progress": 0,
                    "stage": "cancelled",
                    "stage_label": "Export cancelled",
                    "measurable": False,
                    "elapsed_ms": 0,
                    "cancelled": True,
                    "created_at": now,
                    "updated_at": now,
                    "error": "Export cancelled by user.",
                    "result": None,
                }

            if record.get("status") in ("completed", "failed"):
                return dict(record)

            if runtime is not None:
                runtime["cancel_event"].set()
                proc = runtime.get("process")
                job_dir = runtime.get("job_dir")
                worker_active = bool(runtime.get("worker_active"))
                if runtime.get("finished_mono") is None:
                    runtime["finished_mono"] = time.monotonic()

            record["status"] = "cancelled"
            record["cancelled"] = True
            record["stage"] = "cancelled"
            record["stage_label"] = "Export cancelled"
            record["measurable"] = False
            record["error"] = "Export cancelled by user."
            record["elapsed_ms"] = self._compute_elapsed_ms(runtime)
            record["updated_at"] = self._now_iso()
            snapshot = dict(record)

            if worker_active and job_dir is not None:
                runtime["cleanup_pending"] = True  # type: ignore[index]

        if proc is not None:
            terminate_subprocess_tree(proc)

        if job_dir is not None and not worker_active and (proc is None or proc.poll() is not None):
            _safe_rmtree(job_dir)

        return snapshot


job_store = InMemoryJobStore()

