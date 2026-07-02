def create_order(payload: dict) -> dict:
    item_count = len(payload.get("items", []))
    return {"id": 42, "status": "created", "itemCount": item_count}

