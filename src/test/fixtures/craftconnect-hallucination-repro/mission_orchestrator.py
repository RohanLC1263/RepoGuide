
"""
Mission Orchestrator Agent - Phase 7 (Hardened & Modular)

Coordinates the end-to-end pipeline:
Image -> Classification -> RAG Retrieval -> Story Generation -> Mission Report

Refactored to use MissionCoordinator, separating concerns into:
- AgentContainer (Dependency Injection)
- MissionCoordinator (Workflow Logic)
- AuditLogger (State & Logging)
- TTSService (Audio Generation)
"""

import logging
import os
from typing import Dict, Any, Optional, Tuple

from app.agents.base_agent import BaseAgent
from app.agents.mission_report_schema import MissionReport
from app.agents.schemas import MissionInput

# New Modular Components
from app.agents.orchestrator.agent_container import AgentContainer
from app.agents.orchestrator.mission_coordinator import MissionCoordinator
from app.agents.artifact_manager import get_artifact_manager

logger = logging.getLogger(__name__)

# Data directory - Configurable via env var
DATA_DIR = os.getenv("CRAFTCONNECT_DATA_DIR", "data")

class MissionOrchestratorAgent(BaseAgent):
    AGENT_NAME = "MissionOrchestratorAgent"
    AGENT_VERSION = "v2.1" # Bumped for Strict Typing
    
    def __init__(
        self, 
        classifier_agent, 
        rag_agent, 
        story_agent,
        packager_agent,
        auth_validator_agent,
        image_quality_agent=None,
        artisan_trust_agent=None,
        listing_assistant=None,
        marketplace_agent=None, 
        market_agent=None,
        visual_grounding_agent=None,
        **kwargs
    ):
        super().__init__(**kwargs)
        
        # 1. Initialize Dependency Container
        self.container = AgentContainer(
            classifier_agent=classifier_agent,
            rag_agent=rag_agent,
            story_agent=story_agent,
            packager_agent=packager_agent,
            auth_validator_agent=auth_validator_agent,
            image_quality_agent=image_quality_agent,
            artisan_trust_agent=artisan_trust_agent,
            listing_assistant=listing_assistant,
            marketplace_agent=marketplace_agent,
            market_agent=market_agent,
            visual_grounding_agent=visual_grounding_agent
        )
        self.container.validate_dependencies()
        
        # 2. Initialize Services
        self.artifact_manager = get_artifact_manager()
        
        # 3. Initialize Coordinator
        self.coordinator = MissionCoordinator(
            container=self.container,
            artifact_manager=self.artifact_manager,
            data_dir=DATA_DIR
        )

        self.logger.info(f"{self.AGENT_NAME} Initialized (Modular Architecture v2.0)")

    def get_agent_name(self) -> str:
        return self.AGENT_NAME
    
    def get_agent_version(self) -> str:
        return self.AGENT_VERSION
        
    def validate_inputs(self, inputs: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
        """Validate inputs - basic checks only"""
        # We now rely on Pydantic MissionInput validation inside execute
        if not inputs.get("mission_id") or not inputs.get("image_path"):
             return False, "Missing required fields: mission_id, image_path"
        return True, None
        
    async def execute(self, inputs: Dict[str, Any]) -> Dict[str, Any]:
        """Wrapper for run_mission to satisfy BaseAgent contract"""
        try:
            # Convert Dict to Pydantic Model
            mission_input = MissionInput(**inputs)
        except Exception as e:
            raise ValueError(f"Invalid inputs for MissionInput: {e}")
            
        report = await self.run_mission(mission_input)
        return report.model_dump()

    async def run_mission(self, input_data: MissionInput) -> MissionReport:
        """
        Delegates to MissionCoordinator with strict typing.
        """
        return await self.coordinator.run_mission(input_data)

    async def generate_listing_from_interview(self, mission_id: str, interview_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Delegates to MissionCoordinator.
        """
        return await self.coordinator.generate_listing_from_interview(mission_id, interview_data)

    # Legacy helper methods removed as they are no longer handled by the facade
    # _save_intermediate_report -> Handled by AuditLogger internals (if we want to restore persistence)
    # create_artifact -> Handled by ArtifactManager
    # _run_with_timeout -> Handled by MissionCoordinator internal helper
