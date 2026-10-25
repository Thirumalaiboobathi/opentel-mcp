"""Credential scrubbing (port of ``fingerprint/normalize/secrets.js``)."""

from __future__ import annotations

from ._jsre import compile_js, from_u16, js_replacement_to_python, to_u16

SECRET_PLACEHOLDER = "<SECRET>"

_SECRET_KEY_NAMES = (
    "(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|x-api-key|api[_-]?key|apikey|"
    "client[_-]?secret|secret[_-]?key|secret|password|passwd|pwd|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key|"
    "credentials?|signature|sig)"
)

# (JS source, JS flags, JS replacement) -- the exact triples pinned by conformance/patterns.json.
SECRET_STEP_SOURCES: tuple[tuple[str, str, str], ...] = (
    (
        r"""\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/?#@"'<>:]+:[^\s/?#@"'<>]+@""",
        "g",
        f"$1{SECRET_PLACEHOLDER}@",
    ),
    (r"\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}", "g", SECRET_PLACEHOLDER),
    (r"\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]{16,}=*", "gi", f"$1 {SECRET_PLACEHOLDER}"),
    (r"\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b", "g", SECRET_PLACEHOLDER),
    (
        r"\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{30,}"
        r"|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})",
        "g",
        SECRET_PLACEHOLDER,
    ),
    (rf"""\b({_SECRET_KEY_NAMES})(=)(["']?)[^\s&"',;)]+""", "gi", f"$1$2$3{SECRET_PLACEHOLDER}"),
    (rf"""\b({_SECRET_KEY_NAMES})(["']?\s*:\s*)(["'])[^"'\n]+\3""", "gi", f"$1$2$3{SECRET_PLACEHOLDER}$3"),
    (rf"\b({_SECRET_KEY_NAMES})(\s*:\s*)(?=[^\s,;]*\d)[^\s,;]{{4,}}", "gi", f"$1$2{SECRET_PLACEHOLDER}"),
)

SECRET_STEPS = tuple(
    (compile_js(src, flags), js_replacement_to_python(rep)) for src, flags, rep in SECRET_STEP_SOURCES
)


def scrub_secrets_u16(text: str) -> str:
    """:func:`scrub_secrets` on a string already in the UTF-16 representation."""
    for pattern, replacement in SECRET_STEPS:
        text = pattern.sub(replacement, text)
    return text


def scrub_secrets(text: str) -> str:
    """Replace recognizable credentials with ``<SECRET>``; everything else is left exactly as it was."""
    return from_u16(scrub_secrets_u16(to_u16(text)))
