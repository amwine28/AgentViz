class ToolCallDenied(Exception):
    def __init__(self, call_id: str, tool_name: str):
        self.call_id = call_id
        self.tool_name = tool_name
        super().__init__(f"Tool call '{tool_name}' (id={call_id}) was denied by the user")

class AgentStopped(Exception):
    def __init__(self, agent_id: str):
        self.agent_id = agent_id
        super().__init__(f"Agent '{agent_id}' was stopped by the user")
