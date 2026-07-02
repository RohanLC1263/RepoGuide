from fastapi import FastAPI

from services.orders import create_order

app = FastAPI(title="Orders Fixture")

@app.get("/api/orders/{order_id}")
def get_order(order_id: int):
    return {"id": order_id, "status": "processing"}

@app.post("/api/orders")
def post_order(payload: dict):
    return create_order(payload)

