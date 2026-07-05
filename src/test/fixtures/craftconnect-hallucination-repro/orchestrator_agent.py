"""
LEGACY ORCHESTRATOR REMOVED

This file is a safety guard to prevent accidental imports of the legacy OrchestratorAgent.

The system has been migrated to MissionOrchestratorAgent (ViT + RAG + Local LLM).

If you see this error, update your imports to:
    from app.agents.mission_orchestrator import MissionOrchestratorAgent
"""

class OrchestratorAgent:
    def __init__(self, *args, **kwargs):
        raise RuntimeError(
            "Legacy OrchestratorAgent has been removed. "
            "Use MissionOrchestratorAgent instead: "
            "from app.agents.mission_orchestrator import MissionOrchestratorAgent"
        )

def run_mission(*args, **kwargs):
    raise RuntimeError(
        "Legacy run_mission() from OrchestratorAgent has been removed. "
        "Use MissionOrchestratorAgent.run_mission() instead."
    )
