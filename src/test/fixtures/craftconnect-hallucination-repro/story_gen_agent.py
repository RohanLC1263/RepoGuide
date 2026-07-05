"""
DEPRECATED: StoryGenAgent

StoryGenAgent (Gemini-based) has been removed in favor of StoryGenerationAgent.
This file provides a compatibility shim that logs a deprecation warning and returns
empty results instead of crashing.

Issue 34: Legacy agent should not hard-crash; provide a shim for safety.
"""

import logging
import warnings
from typing import Dict, Any

logger = logging.getLogger(__name__)


class StoryGenAgent:
    """
    DEPRECATED: StoryGenAgent has been replaced by StoryGenerationAgent.
    
    This shim exists for backward compatibility. Any code importing StoryGenAgent
    should be updated to use StoryGenerationAgent via MissionOrchestratorAgent.
    """
    
    AGENT_NAME = "StoryGenAgent"
    AGENT_VERSION = "DEPRECATED"
    
    def __init__(self, *args, **kwargs):
        warnings.warn(
            "StoryGenAgent is deprecated. Use StoryGenerationAgent via MissionOrchestratorAgent instead.",
            DeprecationWarning,
            stacklevel=2
        )
        logger.warning(
            "DEPRECATED: StoryGenAgent instantiated. System now uses StoryGenerationAgent."
        )
    
    def execute(self, inputs: Dict[str, Any]) -> Dict[str, Any]:
        """Return empty result with deprecation notice."""
        logger.warning("StoryGenAgent.execute() called on deprecated agent")
        return {
            "status": "DEPRECATED",
            "story_text": "",
            "message": "StoryGenAgent is deprecated. Use StoryGenerationAgent instead."
        }
    
    def get_agent_name(self) -> str:
        return self.AGENT_NAME
    
    def get_agent_version(self) -> str:
        return self.AGENT_VERSION
