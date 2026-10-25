"""Message normalization (port of ``fingerprint/normalize/{patterns,message}.js``)."""

from __future__ import annotations

from ._jsre import compile_js, from_u16, js_replacement_to_python, js_trim, to_u16
from ._secrets import scrub_secrets_u16

MAX_INPUT_LENGTH = 2048

# (JS source, JS flags, JS replacement) -- order is load-bearing; pinned by conformance/patterns.json.
NORMALIZE_STEP_SOURCES: tuple[tuple[str, str, str], ...] = (
    (r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b", "g", "<UUID>"),
    (r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", "g", "<EMAIL>"),
    (r"""\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>]+""", "g", "<URL>"),
    (
        r"\b(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}"
        r"|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}"
        r"|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}"
        r"|[0-9a-fA-F]{1,4}:(?:(?::[0-9a-fA-F]{1,4}){1,6})|:(?:(?::[0-9a-fA-F]{1,4}){1,7}|:))\b",
        "g",
        "<IP>",
    ),
    (
        r"\b(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\b",
        "g",
        "<IP>",
    ),
    (r"\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b", "g", "<TS>"),
    (r"\b\d{10}\b|\b\d{13}\b", "g", "<TS>"),
    (r"\/(?:[\w.-]+\/)+[\w.-]*|\b[A-Za-z]:[\\/](?:[^\s\\/]+[\\/])*[^\s\\/]*", "g", "<PATH>"),
    (r"\b[0-9a-fA-F]{8,}\b", "g", "<HEX>"),
    (
        r":(?:102[4-9]|10[3-9]\d|1[1-9]\d{2}|[2-9]\d{3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])\b",
        "g",
        ":<PORT>",
    ),
    (r"\b\d{3,}\b", "g", "<NUM>"),
    (r"""(["'])(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{8,64}\1""", "g", "$1<ID>$1"),
    (r"\s+", "g", " "),
)

NORMALIZE_STEPS = tuple(
    (compile_js(src, flags), js_replacement_to_python(rep)) for src, flags, rep in NORMALIZE_STEP_SOURCES
)


def normalize_message(raw: str) -> str:
    """Truncate (UTF-16 units), scrub credentials, strip high-cardinality values, trim.

    Raises ``TypeError`` for a non-``str`` input, as ``raw.slice`` does in JS for a number.
    """
    if not isinstance(raw, str):
        raise TypeError("message must be a string")
    result = scrub_secrets_u16(to_u16(raw)[:MAX_INPUT_LENGTH])
    for pattern, replacement in NORMALIZE_STEPS:
        result = pattern.sub(replacement, result)
    return from_u16(js_trim(result))
