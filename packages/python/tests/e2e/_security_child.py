"""Child process for the security e2e test: a Python server with all four v0.18 features on, exporting to the real
dashboard at EXPORTER_URL. Key-shaped text is assembled at runtime; no credential-looking literal exists in source.

Environment: EXPORTER_URL, FLAVOUR (default: the newest flavour for the installed mcp), SDK_TRACING.
"""

from __future__ import annotations

import os

import anyio

from opentel_mcp import force_flush, instrument_mcp_server
from tests import harness

WRONG_PIN = "sha256:" + "0" * 64


def key_shaped() -> str:
    return "AKIA" + "IOSFODNN7" + "EXAMPLE"


async def main() -> None:
    flavour = os.environ.get("FLAVOUR") or "lowlevel"
    # PIN_ALL=1 pins every tool to a wrong hash (the cross-language test compares the reported actual hashes).
    pins = (
        {n: WRONG_PIN for n in harness.TOOL_NAMES} if os.environ.get("PIN_ALL") == "1" else {"ok": WRONG_PIN}
    )
    server, lowlevel = harness.build(
        flavour,
        lambda s: instrument_mcp_server(
            s,
            setup_sdk=True,
            service_name="py-security-e2e",
            exporter_url=os.environ["EXPORTER_URL"],
            flush_on_exit={"timeout_ms": 60000},
            sdk_tracing=os.environ.get("SDK_TRACING", "replace"),  # type: ignore[arg-type]
            sensitive_tools=["auth_*", "emit"],
            secret_leak_detection={"enabled": True},
            tool_integrity={"enabled": True, "pins": pins},
        ),
    )
    async with harness.connect(server, lowlevel) as client:
        await client.list_tools()
        await client.call("emit", {"text": f"debug dump: {key_shaped()}"})
        await client.call("auth_silent", {})
        await client.call("ok", {"a": 1})
    force_flush()


if __name__ == "__main__":
    anyio.run(main)
