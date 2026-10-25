"""Child process for the dev-mode tests: a tiny instrumented server driven through the SDK's in-memory transport.

Environment: TOOL (default "silent"), EXPORTER_URL, READY_FILE + WAIT=1 (touch READY_FILE, then sleep until signalled),
LIST_TOOLS=1 (also call tools/list), FORCE_FLUSH=1 (call opentel_mcp.force_flush() before returning).
"""

from __future__ import annotations

import os
import pathlib
import time

import anyio

from opentel_mcp import force_flush, instrument_mcp_server
from tests import harness


async def main() -> None:
    flavour = os.environ.get("FLAVOUR") or harness.flavours()[-1]
    url = os.environ.get("EXPORTER_URL") or None
    server, lowlevel = harness.build(
        flavour,
        lambda s: instrument_mcp_server(
            s,
            setup_sdk=True,
            service_name="dev-mode-test",
            exporter_url=url,
            sdk_tracing=os.environ.get("SDK_TRACING", "replace"),  # type: ignore[arg-type]
        ),
        remove_sdk_middleware=os.environ.get("REMOVE_SDK_MIDDLEWARE") == "1",
    )
    async with harness.connect(server, lowlevel) as client:
        await client.call(os.environ.get("TOOL", "silent"), {})
        if os.environ.get("LIST_TOOLS") == "1":
            await client.list_tools()
    if os.environ.get("FORCE_FLUSH") == "1":
        force_flush()
    if os.environ.get("WAIT") == "1":
        pathlib.Path(os.environ["READY_FILE"]).write_text("ready")
        time.sleep(60)


anyio.run(main)
