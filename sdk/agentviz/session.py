import asyncio
import json
import subprocess
import socket
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from .relay_client import RelayClient
from .agent import Agent
from .events import AgentMessageEvent, SessionStartEvent, OutcomeEvent, CreditReportEvent, serialize
from typing import Literal

PORT_FILE = Path.home() / ".agentviz" / "relay.json"
DEFAULT_PORT = 3333


def _port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("localhost", port)) == 0


def discover_relay_port() -> int | None:
    """Read the port of a live relay from ~/.agentviz/relay.json, if any."""
    try:
        info = json.loads(PORT_FILE.read_text())
        port = int(info["port"])
        if _port_open(port):
            return port
    except (OSError, ValueError, KeyError):
        pass
    return None


class Session:
    def __init__(self, name: str, port: int | None = None, autostart_relay: bool = True,
                 dry_run: bool = False):
        self.name = name
        # Stable id for this run — stamped on every event; the key the future
        # re-run engine and append-only log are keyed on (Phase E foundation).
        self.run_id: str = str(uuid.uuid4())
        # Mock-side-effects re-run mode: agents created here inherit it; external
        # side-effecting tools are never executed (the safety layer, §6.3).
        self.dry_run: bool = dry_run
        self._explicit_port = port
        self._autostart = autostart_relay
        self._relay_proc: subprocess.Popen | None = None
        self._client: RelayClient | None = None
        self._agents: dict[str, Agent] = {}

    @property
    def client(self) -> RelayClient:
        assert self._client is not None, "Session not connected"
        return self._client

    def _resolve_port(self) -> int:
        if self._explicit_port is not None:
            return self._explicit_port
        return discover_relay_port() or DEFAULT_PORT

    async def connect(self) -> None:
        port = self._resolve_port()
        if self._autostart and not _port_open(port):
            relay_dir = str(Path(__file__).parent.parent.parent / "relay")
            self._relay_proc = subprocess.Popen(
                ["node", "dist/index.js"],
                cwd=relay_dir,
            )
            for _ in range(50):
                discovered = discover_relay_port()
                if discovered is not None:
                    port = discovered
                    break
                if _port_open(port):
                    break
                time.sleep(0.1)

        self._client = RelayClient(port=port)
        self._client.run_id = self.run_id   # stamp run_id on every event, incl. session_start
        self._client.on_command("tool_approve", self._dispatch_tool_approval)
        self._client.on_command("tool_deny", self._dispatch_tool_denial)
        await self._client.connect()
        await self._client.send(serialize(SessionStartEvent(name=self.name, dry_run=self.dry_run)))

    async def close(self) -> None:
        if self._client:
            await self._client.close()
        if self._relay_proc:
            self._relay_proc.terminate()

    @asynccontextmanager
    async def agent(self, name: str, parent_id: str | None = None):
        a = Agent(name=name, relay=self.client, parent_id=parent_id, dry_run=self.dry_run)
        self._agents[a.agent_id] = a
        await a._emit_spawn()
        try:
            yield a
            await a._emit_complete(exit_status="ok")
        except Exception as exc:
            await a._emit_complete(exit_status="error", summary=str(exc))
            raise
        finally:
            self._agents.pop(a.agent_id, None)

    async def send_message(self, from_agent: str, to_agent: str, content: str) -> None:
        from_id = self._name_to_id(from_agent) or from_agent
        to_id = self._name_to_id(to_agent) or to_agent
        await self.client.send(serialize(
            AgentMessageEvent(from_agent_id=from_id, to_agent_id=to_id, content=content)
        ))

    async def report_outcome(
        self,
        value: float,
        channel: str = "reward",
        *,
        scale: Literal["binary", "unit", "score", "delta"] = "binary",
        source: str = "eval_harness",
        measured: bool = True,
        value_min: float | None = None,
        value_max: float | None = None,
        detail: dict | None = None,
    ) -> None:
        """Report the run-level TERMINAL outcome (the sparse end-of-run reward).
        agent_id=None routes it to the _session seq stream. detail may carry
        result_agent_ids to declare the sink set explicitly for credit assignment."""
        await self.client.send(serialize(OutcomeEvent(
            agent_id=None, value=value, channel=channel, scale=scale,
            stage="terminal", source=source, measured=measured,
            value_min=value_min, value_max=value_max, detail=detail or {},
        )))

    async def report_credit(
        self,
        method: Literal["counterfactual", "shapley", "densified"],
        agents: list[dict],
        channel: str = "reward",
    ) -> None:
        """Publish externally-computed per-agent credit (from a re-run / Shapley /
        densification harness) so the UI can surface it. The SDK is only transport —
        the credit values must be measured/axiomatic, never an LLM opinion."""
        await self.client.send(serialize(CreditReportEvent(
            method=method, channel=channel, agents=agents,
        )))

    def _name_to_id(self, name_or_id: str) -> str | None:
        for a in self._agents.values():
            if a.name == name_or_id or a.agent_id == name_or_id:
                return a.agent_id
        return None

    def _dispatch_tool_approval(self, cmd: dict) -> bool:
        agent = self._agents.get(cmd.get("agent_id", ""))
        if agent:
            return agent.resolve_tool_call(cmd["call_id"], approved=True)
        return False

    def _dispatch_tool_denial(self, cmd: dict) -> bool:
        agent = self._agents.get(cmd.get("agent_id", ""))
        if agent:
            return agent.resolve_tool_call(cmd["call_id"], approved=False)
        return False


def session(name: str, port: int | None = None, autostart_relay: bool = True,
            dry_run: bool = False) -> Session:
    return Session(name=name, port=port, autostart_relay=autostart_relay, dry_run=dry_run)
