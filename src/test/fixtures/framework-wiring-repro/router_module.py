from fastapi import APIRouter, Depends

router = APIRouter(prefix="/api/x", tags=["x"])

@router.get("/y")
def y():
    return {}
