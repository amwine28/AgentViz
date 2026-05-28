import asyncio
import subprocess
import socket
import time
from contextlib import asynccontextmanager
from .relay_client import RelayClient
from .agent import Agent
from .events import AgentMessageEvent, serialize


def _relay_is_running(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("localhost", port)) == 0


class Session:
    def __init__(self, name: str, port: int = 3333, autostart_relay: bool = True):
        self.name = name
        self._port = port
        self._autostart = autostart_relay
        self._relay_proc: subprocess.Popen | None = None
        self._client = RelayClient(port=port)
        self._agents: dict[str, Agent] = {}

    async def connect(self) -> None:
        if self._autostart and not _relay_is_running(self._port):
            relay_dir = str(__import__("pathlib").Path(__file__).parent.parent.parent / "relay")
            self._relay_proc = subprocess.Popen(
                ["node", "dist/index.js"],
                cwd=relay_dir,
            )
            for _ in range(30):
                if _relay_is_running(self._port):
                    break
                time.sleep(0.1)

        self._client.on_command("tool_approve", self._dispatch_tool_approval)
        self._client.on_command("tool_deny", self._dispatch_tool_denial)
        await self._client.connect()

    async def close(self) -> None:
        await self._client.close()
        if self._relay_proc:
            self._relay_proc.terminate()

    @asynccontextmanager
    async def agent(self, name: str, parent_id: str | None = None):
        a = Agent(name=name, relay=self._client, parent_id=parent_id)
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
        await self._client.send(serialize(
            AgentMessageEvent(from_agent_id=from_id, to_agent_id=to_id, content=content)
        ))

    def _name_to_id(self, name_or_id: str) -> str | None:
        for a in self._agents.values():
            if a.name == name_or_id or a.agent_id == name_or_id:
                return a.agent_id
        return None

    def _dispatch_tool_approval(self, cmd: dict) -> None:
        agent = self._agents.get(cmd.get("agent_id", ""))
        if agent:
            agent.resolve_tool_call(cmd["call_id"], approved=True)

    def _dispatch_tool_denial(self, cmd: dict) -> None:
        agent = self._agents.get(cmd.get("agent_id", ""))
        if agent:
            agent.resolve_tool_call(cmd["call_id"], approved=False)


def session(name: str, port: int = 3333, autostart_relay: bool = True) -> Session:
    return Session(name=name, port=port, autostart_relay=autostart_relay)
