"""HTTP API for Unitree Explore app teachings (record on phone, play from web)."""

from __future__ import annotations

import os

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from talk_module.explore_teaching import (
    explore_teaching_status,
    stop_explore_teaching,
)
from talk_module.teaching_catalog import list_all_teachings, play_teaching

router = APIRouter(prefix="/api/explore-teachings", tags=["explore-teachings"])


class PlayBody(BaseModel):
    name: str = ""
    action_name: str = ""
    robot_ip: str | None = None


class StopBody(BaseModel):
    robot_ip: str | None = None


class ParlaGesturesBody(BaseModel):
    gestures: list[str] = []


@router.get("")
@router.get("/")
def explore_teachings_list():
    return list_all_teachings()


@router.get("/status")
def explore_teachings_status():
    robot_ip = os.getenv("UNITREE_ROBOT_IP", "192.168.123.161")
    out = explore_teaching_status(robot_ip=robot_ip)
    catalog = list_all_teachings(robot_ip=robot_ip)
    out["teaching_count"] = catalog.get("teaching_count") or 0
    out["explore_count"] = catalog.get("explore_count") or 0
    out["local_count"] = catalog.get("local_count") or 0
    return out


@router.post("/play")
def explore_teachings_play(body: PlayBody):
    ref = (body.name or body.action_name or "").strip()
    if not ref:
        return JSONResponse({"ok": False, "message": "name richiesto"}, status_code=400)
    robot_ip = body.robot_ip or os.getenv("UNITREE_ROBOT_IP", "192.168.123.161")
    result = play_teaching(ref, robot_ip=robot_ip)
    return JSONResponse(result, status_code=200 if result.get("ok") else 409)


@router.post("/stop")
def explore_teachings_stop(body: StopBody = Body(default=StopBody())):
    robot_ip = body.robot_ip or os.getenv("UNITREE_ROBOT_IP", "192.168.123.161")
    result = stop_explore_teaching(robot_ip=robot_ip)
    return JSONResponse(result, status_code=200 if result.get("ok") else 409)


@router.get("/parla-gestures")
def explore_parla_gestures_get():
    from talk_module.parla_teaching_config import (
        MAX_PARLA_TEACHING_GESTURES,
        load_parla_teaching_gestures,
        parla_teaching_path,
    )

    return {
        "ok": True,
        "gestures": load_parla_teaching_gestures(),
        "max": MAX_PARLA_TEACHING_GESTURES,
        "path": str(parla_teaching_path()),
    }


@router.post("/parla-gestures")
def explore_parla_gestures_save(body: ParlaGesturesBody):
    from talk_module.parla_teaching_config import save_parla_teaching_gestures

    saved = save_parla_teaching_gestures(body.gestures or [])
    return {"ok": True, "gestures": saved}
