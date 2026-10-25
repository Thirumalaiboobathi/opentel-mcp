"""Python stack signatures (ADR 028, "Python stack signature (thrown path only)").

Same *output* as ``fingerprint/normalize/stack.js`` (``fn@file:line`` joined with
``|``, at most 5 user frames, falling back to dependency frames) with Python
traceback input.
"""

from __future__ import annotations

import os
import re
import sysconfig
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from types import TracebackType

DEFAULT_MAX_FRAMES = 5
_SITE_MARKERS = ("site-packages/", "dist-packages/")
_PKG_DIR = os.path.dirname(os.path.abspath(__file__)).replace("\\", "/")
_TRACEBACK_FILE_LINE = re.compile(r'^\s*File "(.*)", line (\d+), in (.*?)\s*$')

#: (filename, lineno, function) -- ``FrameSummary.name`` is ``co_name``; ``co_qualname`` is 3.11+ only and unstable.
RawFrame = tuple[str, "int | None", str]


@dataclass(frozen=True)
class NormalizedFrame:
    fn: str
    file: str
    line: int | None
    is_native: bool
    is_user_code: bool


def stdlib_dirs() -> tuple[str, ...]:
    dirs: list[str] = []
    for key in ("stdlib", "platstdlib"):
        try:
            p = sysconfig.get_paths().get(key)
        except Exception:
            p = None
        if p:
            p = p.replace("\\", "/").rstrip("/")
            if p not in dirs:
                dirs.append(p)
    return tuple(dirs)


def _slashes(p: str) -> str:
    return p.replace("\\", "/")


def _under(file: str, directory: str) -> bool:
    """``file`` is inside ``directory`` (both ``/``-separated). Windows paths compare case-insensitively (``C:`` vs ``c:``)."""
    prefix = directory + "/"
    if os.name == "nt":
        return file.casefold().startswith(prefix.casefold())
    return file.startswith(prefix)


def _site_index(file: str) -> tuple[int, str] | None:
    best: tuple[int, str] | None = None
    for marker in _SITE_MARKERS:
        idx = file.rfind(marker)
        if idx != -1 and (idx == 0 or file[idx - 1] == "/") and (best is None or idx > best[0]):
            best = (idx, marker)
    return best


def normalize_frame(raw: RawFrame, cwd: str, stdlib: tuple[str, ...]) -> NormalizedFrame:
    filename, lineno, fn = raw
    file = _slashes(filename)
    site = _site_index(file)

    is_native = False
    if (
        (file.startswith("<") and file.endswith(">"))
        or _under(file, _PKG_DIR)
        or (site is None and any(_under(file, d) for d in stdlib))
    ):
        is_native = True

    if is_native:
        return NormalizedFrame(fn, file, lineno, True, False)
    if site is not None:
        idx, marker = site
        return NormalizedFrame(fn, "site-packages/" + file[idx + len(marker) :], lineno, False, False)
    if cwd and _under(file, cwd):
        file = file[len(cwd) + 1 :]
    return NormalizedFrame(fn, file, lineno, False, True)


def iter_tb_frames(tb: TracebackType | None) -> Iterator[RawFrame]:
    """Frames outermost-first, read structurally (no ``linecache`` lookups)."""
    while tb is not None:
        code = tb.tb_frame.f_code
        yield (code.co_filename, tb.tb_lineno, code.co_name)
        tb = tb.tb_next


def parse_traceback_text(text: str | None) -> list[RawFrame]:
    """Parse ``File "x", line N, in fn`` lines (outermost first). Used for redactor output, which is text."""
    frames: list[RawFrame] = []
    if not text:
        return frames
    for line in text.split("\n"):
        m = _TRACEBACK_FILE_LINE.match(line)
        if m:
            frames.append((m.group(1), int(m.group(2)), m.group(3)))
    return frames


def normalize_frames(
    raw_outermost_first: Iterable[RawFrame],
    *,
    cwd: str,
    max_frames: int = DEFAULT_MAX_FRAMES,
    stdlib: tuple[str, ...] | None = None,
) -> tuple[list[NormalizedFrame], str]:
    """``(frames, signature)``; frames are innermost-first, like V8 order."""
    try:
        std = stdlib_dirs() if stdlib is None else stdlib
        cwd = _slashes(cwd).rstrip("/") if cwd else ""
        user: list[NormalizedFrame] = []
        other: list[NormalizedFrame] = []
        for raw in reversed(list(raw_outermost_first)):
            frame = normalize_frame(raw, cwd, std)
            if frame.is_native:
                continue
            if frame.is_user_code:
                if len(user) < max_frames:
                    user.append(frame)
            elif len(other) < max_frames:
                other.append(frame)
        frames = user or other
        signature = "|".join(f"{f.fn}@{f.file}:{'?' if f.line is None else f.line}" for f in frames)
        return frames, signature
    except Exception:
        return [], ""
