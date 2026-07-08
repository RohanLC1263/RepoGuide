TIMEOUT_CLASSIFICATION = 60
TIMEOUT_RAG = 30

class MissionCoordinator:
    async def run_mission(self, input_data):
        try:
            classifier_output = await asyncio.wait_for(
                self.container.classifier.classify(c_input),
                timeout=TIMEOUT_CLASSIFICATION
            )
        except asyncio.TimeoutError:
            raise Exception(f"Classification timed out after {TIMEOUT_CLASSIFICATION}s")

        audit.log_step("Classification Completed")
