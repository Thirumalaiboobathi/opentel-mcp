"""Fingerprint composition (ports of ``fingerprint/{compose,hash}.js`` and ``attributes.js``)."""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from typing import Any

from ._classify import run_classifiers
from ._coerce import Coerced, coerce_error
from ._jsre import from_u16, replace_lone_surrogates, to_u16
from ._normalize import normalize_message
from ._stack import (
    DEFAULT_MAX_FRAMES,
    NormalizedFrame,
    RawFrame,
    iter_tb_frames,
    normalize_frames,
    parse_traceback_text,
)

HASH_INPUT_VERSION = "v1"
DEFAULT_STACK_FRAMES = DEFAULT_MAX_FRAMES
MAX_ERROR_CLASS_LENGTH = 128
SIGNATURE_MAX_LENGTH = 60
FALLBACK_FINGERPRINT = "0000000000000000"
FALLBACK_SIGNATURE = "unfingerprintable"

ATTR_FINGERPRINT = "mcp.failure.fingerprint"
ATTR_SIGNATURE = "mcp.failure.signature"
ATTR_CATEGORY = "mcp.failure.category"
ATTR_ORIGIN = "mcp.failure.origin"
ATTR_ERROR_CLASS = "mcp.failure.error_class"
ATTR_CHANNEL = "mcp.failure.channel"


def hash_inputs(text: str) -> str:
    """SHA-256 over UTF-8 (lone surrogates -> U+FFFD), hex, first 16 characters."""
    data = replace_lone_surrogates(text).encode("utf-8")
    return hashlib.sha256(data).hexdigest()[:16]


@dataclass(frozen=True)
class Fingerprint:
    fingerprint: str
    signature: str
    category: str
    origin: str
    error_class: str
    normalized_message: str
    stack_signature: str
    top_frame_file: str | None = None

    def span_attributes(self) -> dict[str, str]:
        """``toSpanAttributes`` (the channel is added by the caller)."""
        return {
            ATTR_FINGERPRINT: self.fingerprint,
            ATTR_SIGNATURE: self.signature,
            ATTR_CATEGORY: self.category,
            ATTR_ORIGIN: self.origin,
            ATTR_ERROR_CLASS: self.error_class,
        }


def _fallback(origin: str) -> Fingerprint:
    return Fingerprint(FALLBACK_FINGERPRINT, FALLBACK_SIGNATURE, "unknown", origin, "", "", "")


def _frames_for(coerced: Coerced) -> list[RawFrame]:
    if coerced.frames is not None:
        return list(coerced.frames)
    if coerced.tb is not None:
        return list(iter_tb_frames(coerced.tb))
    return parse_traceback_text(coerced.stack)


@dataclass
class NormalizedException:
    coerced: Coerced
    normalized_message: str
    frames: list[NormalizedFrame]
    stack_signature: str


def normalize_exception(
    err: Any, *, cwd: str, max_frames: int = DEFAULT_MAX_FRAMES, stdlib: tuple[str, ...] | None = None
) -> NormalizedException:
    """The single coercion + normalization step shared by the fingerprint and ``normalized`` recording."""
    coerced = err if isinstance(err, Coerced) else coerce_error(err)
    message = normalize_message(
        coerced.message if coerced.fingerprint_message is None else coerced.fingerprint_message
    )
    frames, signature = normalize_frames(_frames_for(coerced), cwd=cwd, max_frames=max_frames, stdlib=stdlib)
    return NormalizedException(coerced, message, frames, signature)


def compute_fingerprint(
    err: Any,
    *,
    tool_name: str | None,
    origin: str,
    cwd: str | None = None,
    stack_frames: int = DEFAULT_STACK_FRAMES,
    stdlib: tuple[str, ...] | None = None,
) -> Fingerprint:
    """Stable identity for a failure. Never raises: any problem yields the fallback fingerprint."""
    try:
        if err is None:
            return _fallback(origin)
        norm = normalize_exception(
            err, cwd=os.getcwd() if cwd is None else cwd, max_frames=stack_frames, stdlib=stdlib
        )
        coerced = norm.coerced
        category = run_classifiers(coerced)
        if category == "internal" and norm.frames and norm.frames[0].file.startswith("site-packages/"):
            category = "dependency"
        raw_class = coerced.name if isinstance(coerced.name, str) else str(coerced.name)
        error_class = from_u16(to_u16(raw_class)[:MAX_ERROR_CLASS_LENGTH])
        digest = hash_inputs(
            f"{HASH_INPUT_VERSION}|{error_class}|{category}|{origin}|{tool_name or ''}|"
            f"{norm.normalized_message}|{norm.stack_signature}"
        )
        top = norm.frames[0] if norm.frames else None
        signature = f"{error_class}@{(top.fn if top else '') or 'anon'}:{'?' if top is None or top.line is None else top.line}"
        signature = from_u16(to_u16(signature)[:SIGNATURE_MAX_LENGTH])
        return Fingerprint(
            digest,
            signature,
            category,
            origin,
            error_class,
            norm.normalized_message,
            norm.stack_signature,
            top.file if top else None,
        )
    except Exception:
        return _fallback(origin)
