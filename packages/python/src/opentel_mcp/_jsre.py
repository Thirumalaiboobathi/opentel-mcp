"""JavaScript-compatible regex and string helpers (ADR 028, Finding 5 translation rules).

The fingerprint pipeline must be byte-identical with core's, so every pattern is
kept as its *JavaScript source* (the same text ``conformance/patterns.json``
pins) and translated here:

* ``\\d \\w \\b`` are ASCII in JS (no ``u`` flag): every pattern gets ``re.ASCII``.
* ``\\s`` is the full JS whitespace set, which ``re.ASCII`` would shrink: it is
  expanded to an explicit class.
* ``.`` excludes ``\\n \\r U+2028 U+2029``; ``$`` (no ``m`` flag) is end of input
  only, i.e. ``\\Z``.
* The ``i`` flag is ASCII-only case folding: ``re.IGNORECASE | re.ASCII``.
* ``$1`` in a replacement becomes ``\\g<1>``.

JS strings are UTF-16: ``slice`` counts code units and a negated class consumes
a lone surrogate per unit. :func:`to_u16` / :func:`from_u16` give the regexes the
same view by representing astral characters as surrogate pairs.
"""

from __future__ import annotations

import re

# Characters matched by JS `\s` and trimmed by `String.prototype.trim`.
JS_WHITESPACE = (
    "\t\n\v\f\r \u00a0\u1680"
    + "".join(chr(c) for c in range(0x2000, 0x200B))
    + "\u2028\u2029\u202f\u205f\u3000\ufeff"
)
# The same set as the inside of a regex character class.
_WS_BODY = "\\t\\n\\x0b\\x0c\\r \\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
_ANY_SENTINEL = "\ue000"
_DOT = "[^\\n\\r\\u2028\\u2029]"

_ASTRAL = re.compile("[\U00010000-\U0010ffff]")
_SURROGATE = re.compile("[\ud800-\udfff]")


def js_source_to_python(src: str) -> str:
    """Translate the source of a JS regex literal (no ``u``/``m``/``s`` flag) to Python ``re`` syntax."""
    src = src.replace("[\\s\\S]", _ANY_SENTINEL)
    out: list[str] = []
    in_class = False
    i = 0
    n = len(src)
    while i < n:
        c = src[i]
        if c == "\\":
            nxt = src[i + 1]
            if nxt == "s":
                out.append(_WS_BODY if in_class else f"[{_WS_BODY}]")
            elif nxt == "S":
                if in_class:
                    raise ValueError("\\S inside a character class is not supported")
                out.append(f"[^{_WS_BODY}]")
            elif nxt == "/":
                out.append("/")
            else:
                out.append(c + nxt)
            i += 2
            continue
        if in_class:
            if c == "]":
                in_class = False
            out.append(c)
        elif c == "[":
            in_class = True
            out.append(c)
            if src[i + 1 : i + 2] == "^":
                out.append("^")
                i += 1
        elif c == ".":
            out.append(_DOT)
        elif c == "$":
            out.append("\\Z")
        else:
            out.append(c)
        i += 1
    return "".join(out).replace(_ANY_SENTINEL, "(?s:.)")


def compile_js(source: str, flags: str = "") -> re.Pattern[str]:
    """Compile a JS regex source with JS semantics (ASCII classes, ASCII case folding)."""
    py_flags = re.ASCII
    if "i" in flags:
        py_flags |= re.IGNORECASE
    return re.compile(js_source_to_python(source), py_flags)


def js_replacement_to_python(rep: str) -> str:
    """``$1`` -> ``\\g<1>`` (JS replacement templates; only ``$n`` is used by core)."""
    return re.sub(r"\$(\d)", r"\\g<\1>", rep)


def to_u16(s: str) -> str:
    """Represent astral characters as surrogate pairs so slicing and regexes count UTF-16 code units."""
    if not _ASTRAL.search(s):
        return s

    def split(m: re.Match[str]) -> str:
        cp = ord(m.group(0)) - 0x10000
        return chr(0xD800 + (cp >> 10)) + chr(0xDC00 + (cp & 0x3FF))

    return _ASTRAL.sub(split, s)


def from_u16(s: str) -> str:
    """Inverse of :func:`to_u16`. Lone surrogates are kept, exactly as JS keeps them."""
    if not _SURROGATE.search(s):
        return s
    return s.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")


def utf16_slice(s: str, n: int) -> str:
    """``s.slice(0, n)`` with JS UTF-16 code-unit semantics (may leave a lone high surrogate)."""
    return from_u16(to_u16(s)[:n])


def utf16_len(s: str) -> int:
    return len(to_u16(s))


def js_trim(s: str) -> str:
    return s.strip(JS_WHITESPACE)


def replace_lone_surrogates(s: str) -> str:
    """What ``hash.update(s, 'utf8')`` does to lone surrogates: U+FFFD."""
    return _SURROGATE.sub("\ufffd", s)
