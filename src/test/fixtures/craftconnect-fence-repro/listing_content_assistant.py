class ListingContentAssistant:
    def generate_draft(self, craft_name, interview_data):
        try:
            data = json.loads(json_str, strict=False)
        except Exception as e:
            self.logger.error(f"Failed to parse Listing LLM response: {e}")
            self.logger.debug(f"Raw LLM Output was: {raw_text}")

            # Slightly improved fallback to avoid "Generic" complaints if AI fails
            data = {
                "title": (
                    f"{craft_name} | Handmade Traditional "
                    f"Wall Art | Authentic Indian Heritage"
                ),
                "short_description": (
                    f"This handcrafted {craft_name} piece "
                    f"is created using traditional techniques."
                ),
            }

    def _sanitize_rejection_text(self, craft_name):
        rejection_text = f"We currently do not have sufficient authoritative information about this {craft_name} to provide a detailed description. This may be a rare or regional variation not yet documented in our knowledge base."
        return rejection_text
