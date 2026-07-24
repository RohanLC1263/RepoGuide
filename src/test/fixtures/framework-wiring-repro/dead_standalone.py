from fastapi import FastAPI

# Mirrors community_engine.py: a standalone app that is never mounted anywhere.
app = FastAPI(title="Dead Standalone")
app.add_middleware(object)

@app.get("/z")
def z():
    return {}
