from fastapi import FastAPI

from db.database import Base, engine
from routers import items

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Inventory Fixture")
app.include_router(items.router)

@app.get("/")
def read_root() -> dict[str, str]:
    return {"status": "ok"}

@app.get("/health")
def read_health() -> dict[str, str]:
    return {"database": "ready"}

