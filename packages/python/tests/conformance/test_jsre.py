"""The translation rules from ADR 028 Finding 5, each pinned on its own."""

from __future__ import annotations

import pytest

from opentel_mcp._jsre import (
    JS_WHITESPACE,
    compile_js,
    from_u16,
    js_source_to_python,
    js_trim,
    replace_lone_surrogates,
    to_u16,
    utf16_slice,
)


def test_ascii_word_and_digit_classes() -> None:
    # JS \w is ASCII: "\u00e9" is a non-word character, so a \b exists before the digits (Unicode \w would drop it).
    assert compile_js(r"\b\d{3,}\b").search("caf\u00e91700000000")
    assert compile_js(r"\d").search("٣") is None  # Arabic-Indic digit


def test_dot_excludes_all_four_line_terminators() -> None:
    rx = compile_js(r"a.b")
    for sep in ("\n", "\r", " ", " "):
        assert rx.search(f"a{sep}b") is None
    assert rx.search("a b")


def test_dollar_is_end_of_input_only() -> None:
    assert compile_js(r"^x$").search("x\n") is None


def test_ignorecase_is_ascii_only() -> None:
    assert compile_js(r"key", "i").search("Key") is None  # Kelvin sign
    assert compile_js(r"key", "i").search("KEY")


def test_whitespace_class_is_the_js_set() -> None:
    rx = compile_js(r"\s")
    for ch in JS_WHITESPACE:
        assert rx.fullmatch(ch), hex(ord(ch))
    for ch in ("\u0085", "᠎", "\x1c", "\x1f"):
        assert rx.fullmatch(ch) is None, hex(ord(ch))
    assert compile_js(r"[^\s]").fullmatch(" ") is None


def test_negated_class_inside_a_class_is_rejected_loudly() -> None:
    with pytest.raises(ValueError):
        js_source_to_python(r"[\S]")


def test_trim_matches_js_not_python_strip() -> None:
    assert js_trim("\x1ca\x1c") == "\x1ca\x1c"  # str.strip() would remove U+001C
    assert js_trim("﻿a﻿") == "a"  # str.strip() keeps U+FEFF
    assert js_trim("\u0085a") == "\u0085a"


def test_utf16_slice_can_split_a_surrogate_pair_like_js() -> None:
    s = "x" * 2047 + "\U0001f600" + "tail"
    cut = utf16_slice(s, 2048)
    assert cut == "x" * 2047 + "\ud83d"
    assert replace_lone_surrogates(cut).endswith("�")


def test_u16_roundtrip() -> None:
    s = "a\U0001f600b\ud800c"
    assert from_u16(to_u16(s)) == s
    assert len(to_u16("\U0001f600")) == 2
