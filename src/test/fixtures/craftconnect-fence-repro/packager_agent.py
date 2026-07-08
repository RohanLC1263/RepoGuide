class PackagerAgent(BaseAgent):
    async def _format_whatsapp(self, title, description, pricing):
        price_val = pricing.get('recommended_price', 'Available on Request')
        currency = pricing.get('currency', 'INR')

        prompt = (
            f"Write a short, shareable WhatsApp message for selling a {title}.\n"
            f"STORY CONTEXT: {description[:800]}\n"
            f"PRICE: {currency} {price_val}\n"
            "GUIDELINES:\n"
            "- Format it clearly with bullet points or emojis.\n"
            "- Highlight the 'Handmade' and 'Cultural' aspect.\n"
            "- End with a Call to Action (DM for details).\n"
            "- DO NOT include internal citation markers like [MAD-001].\n"
            "- Keep it under 500 characters.\n"
        )

        message = await self._generate_social_content(prompt, fallback_text=f"🎨 *{title}*\n\n{description[:200]}...")
