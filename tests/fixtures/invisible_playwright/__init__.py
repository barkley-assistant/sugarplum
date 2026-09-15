"""Fake invisible_playwright for tests.

The real invisible_playwright spawns Xvfb and Firefox. We don't want that in
unit tests — tests just need the InvisiblePlaywright context manager to
exist and behave predictably. This module provides several constructor
variants selected by SUGARPLUM_FAKE_INVISIBLE_PLAYWRIGHT_MODE:

  - "wedge"  : __enter__ returns immediately; __exit__ sleeps for
    SUGARPLUM_FAKE_INVISIBLE_PLAYWRIGHT_WEDGE_SECONDS (default 30s).
    Proves the SIGTERM handler bypasses __exit__ via os._exit(3) (the
    BLOCKING-2 round-2 fix).
  - "goto-wedge": __enter__ returns immediately; page.goto() sleeps for
    SUGARPLUM_FAKE_INVISIBLE_PLAYWRIGHT_WEDGE_SECONDS. The helper is
    alive but stuck mid-scrape — the SIGTERM ladder fires from the
    parent. (Same end-state as "wedge" but exercises a different
    helper-state path.)
  - "ok"     : happy-path stub. __enter__ returns a stub context; the
    stub page returns a small HTML body on goto(). __exit__ is a no-op.
  - "raise"  : __enter__ raises RuntimeError. Proves the helper handles
    invisible_playwright launch failures cleanly.

The fake NEVER touches Xvfb / Firefox — process listing in tests is safe.
"""

from __future__ import annotations

import os
import time


class _StubPage:
    def __init__(self, mode: str, wedge_seconds: float):
        self._mode = mode
        self._wedge_seconds = wedge_seconds

    def goto(self, url, wait_until=None, timeout=None):
        if self._mode == "goto-wedge":
            # Honor the playwright-level timeout if the helper set one,
            # otherwise wedge for the full configured duration. The
            # helper's goto timeout is typically the budget minus a
            # safety margin (e.g. timeout_ms=60000 → goto_timeout=57000).
            if timeout and timeout > 0:
                time.sleep(min(timeout / 1000.0, self._wedge_seconds))
            else:
                time.sleep(self._wedge_seconds)
            # If we hit the timeout, raise the same TimeoutError the real
            # playwright driver raises — keeps the helper's error path
            # exercised.
            raise TimeoutError(
                f"fake goto-wedge: simulated timeout after {timeout}ms"
            )

        class _Resp:
            status = 200

        return _Resp()

    def content(self):
        return "<html><head></head><body>stub</body></html>"

    @property
    def url(self):
        return "https://example.invalid/"


class _StubCtx:
    def __init__(self, mode: str, wedge_seconds: float):
        self._mode = mode
        self._wedge_seconds = wedge_seconds

    def new_page(self):
        return _StubPage(self._mode, self._wedge_seconds)


def _wedge_seconds() -> float:
    return float(
        os.environ.get("SUGARPLUM_FAKE_INVISIBLE_PLAYWRIGHT_WEDGE_SECONDS", "30")
    )


class _OkInvisiblePlaywright:
    def __init__(self, **kwargs):
        pass

    def __enter__(self):
        return _StubCtx("ok", 0.0)

    def __exit__(self, exc_type, exc, tb):
        return False


class _WedgeInvisiblePlaywright:
    """__exit__ sleeps; the BLOCKING-2 fix is "os._exit(3) bypasses this"."""

    def __init__(self, **kwargs):
        self._wedge = _wedge_seconds()

    def __enter__(self):
        return _StubCtx("wedge", self._wedge)

    def __exit__(self, exc_type, exc, tb):
        time.sleep(self._wedge)
        return False


class _GotoWedgeInvisiblePlaywright:
    """page.goto() sleeps until playwright's own timeout fires."""

    def __init__(self, **kwargs):
        self._wedge = _wedge_seconds()

    def __enter__(self):
        return _StubCtx("goto-wedge", self._wedge)

    def __exit__(self, exc_type, exc, tb):
        return False


class _RaiseInvisiblePlaywright:
    def __init__(self, **kwargs):
        pass

    def __enter__(self):
        raise RuntimeError("fake invisible_playwright: launch failed")

    def __exit__(self, exc_type, exc, tb):
        return False


_MODE = os.environ.get("SUGARPLUM_FAKE_INVISIBLE_PLAYWRIGHT_MODE", "wedge")

if _MODE == "ok":
    InvisiblePlaywright = _OkInvisiblePlaywright
elif _MODE == "raise":
    InvisiblePlaywright = _RaiseInvisiblePlaywright
elif _MODE == "goto-wedge":
    InvisiblePlaywright = _GotoWedgeInvisiblePlaywright
else:
    InvisiblePlaywright = _WedgeInvisiblePlaywright
