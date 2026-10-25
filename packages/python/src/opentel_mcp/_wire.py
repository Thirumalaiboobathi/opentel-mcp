"""Reading the parts of a ``tools/call`` result we need, without importing the mcp SDK.

Both SDK majors are handled by duck typing; nothing here ever touches argument values.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def unwrap(result: Any) -> Any:
    """mcp 1.x wraps a handler result in ``ServerResult(root=CallToolResult)``."""
    root = getattr(result, "root", None)
    return result if root is None else root


def is_tool_error(result: Any) -> bool:
    """``result.isError === true`` -- literal ``True`` only, exactly as core and the 2.x SDK middleware."""
    r = unwrap(result)
    if isinstance(r, Mapping):
        return r.get("isError") is True
    value = getattr(r, "is_error", None)
    if value is None:
        value = getattr(r, "isError", None)
    return value is True


def to_wire(result: Any) -> dict[str, Any]:
    """The camelCase wire dict (``model_dump(by_alias=True, mode='json', exclude_none=True)`` for models)."""
    r = unwrap(result)
    if isinstance(r, Mapping):
        return dict(r)
    dump = getattr(r, "model_dump", None)
    if callable(dump):
        out = dump(by_alias=True, mode="json", exclude_none=True)
        return out if isinstance(out, dict) else {}
    return {}
