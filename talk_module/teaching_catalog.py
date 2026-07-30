"""Unified catalog: Explore app teachings + local arm recordings (Robot tab REC)."""

from __future__ import annotations

import os
import threading
from typing import Optional

LOCAL_PREFIX = "local::"
EXPLORE_PREFIX = "explore::"


def parse_teaching_ref(ref: str) -> dict:
    """Parse soundboard / API reference into local slot or Explore name."""
    s = str(ref or "").strip()
    if not s:
        return {"kind": None, "ref": ""}
    if s.startswith(LOCAL_PREFIX):
        try:
            slot_id = int(s[len(LOCAL_PREFIX) :])
            if slot_id < 0:
                return {"kind": None, "ref": s}
            return {"kind": "local", "slot_id": slot_id, "ref": f"{LOCAL_PREFIX}{slot_id}"}
        except ValueError:
            return {"kind": None, "ref": s}
    if s.startswith(EXPLORE_PREFIX):
        name = s[len(EXPLORE_PREFIX) :].strip()
        return {"kind": "explore", "name": name, "ref": f"{EXPLORE_PREFIX}{name}" if name else ""}
    if s.isdigit():
        slot_id = int(s)
        return {"kind": "local", "slot_id": slot_id, "ref": f"{LOCAL_PREFIX}{slot_id}"}
    return {"kind": "explore", "name": s, "ref": s}


def local_teaching_label(slot_id: int, name: str = "") -> str:
    label = str(name or "").strip()
    if label:
        return f"{label} (slot {slot_id})"
    return f"Slot {slot_id}"


def list_local_teachings() -> list[dict]:
    from talk_module import teaching_store

    items: list[dict] = []
    for row in teaching_store.list_teachings():
        slot_id = int(row["slot_id"])
        name = str(row.get("name") or "").strip()
        label = local_teaching_label(slot_id, name)
        items.append(
            {
                "name": label,
                "display_name": label,
                "ref": f"{LOCAL_PREFIX}{slot_id}",
                "slot_id": slot_id,
                "source": "local_arm",
                "duration_s": row.get("duration_s"),
                "frames": row.get("frames"),
            }
        )
    return items


def list_all_teachings(robot_ip: Optional[str] = None) -> dict:
    from talk_module.explore_teaching import list_explore_teachings

    explore_data = list_explore_teachings(robot_ip=robot_ip)
    local_items = list_local_teachings()
    explore_items = []
    for item in explore_data.get("teachings") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        explore_items.append(
            {
                **item,
                "display_name": name,
                "ref": f"{EXPLORE_PREFIX}{name}",
                "source": item.get("source") or "explore_app",
            }
        )

    teachings = explore_items + local_items
    explore_ok = bool(explore_data.get("ok"))
    return {
        "ok": explore_ok or bool(local_items),
        "teachings": teachings,
        "explore": explore_items,
        "local": local_items,
        "presets": explore_data.get("presets") or [],
        "error": explore_data.get("error") or "",
        "explore_count": len(explore_items),
        "local_count": len(local_items),
        "teaching_count": len(teachings),
    }


def play_local_teaching(slot_id: int) -> dict:
    from talk_module.teaching_api import get_teaching_manager

    result = get_teaching_manager().replay_slot(int(slot_id))
    ok = bool(result.get("ok"))
    return {
        "ok": ok,
        "message": result.get("error") or ("OK" if ok else "replay fallito"),
        "ref": f"{LOCAL_PREFIX}{slot_id}",
        "kind": "local",
        "slot_id": slot_id,
    }


def play_teaching(ref: str, robot_ip: Optional[str] = None) -> dict:
    parsed = parse_teaching_ref(ref)
    kind = parsed.get("kind")
    if kind == "local":
        return play_local_teaching(parsed["slot_id"])
    if kind == "explore":
        from talk_module.explore_teaching import play_explore_teaching

        name = str(parsed.get("name") or "").strip()
        if not name:
            return {"ok": False, "message": "nome movimento richiesto", "ref": ref, "kind": "explore"}
        result = play_explore_teaching(name, robot_ip=robot_ip)
        result["ref"] = parsed.get("ref") or name
        result["kind"] = "explore"
        return result
    return {"ok": False, "message": "riferimento teaching non valido", "ref": ref}


def play_teaching_async(ref: str, robot_ip: Optional[str] = None) -> None:
    def _run() -> None:
        result = play_teaching(ref, robot_ip=robot_ip)
        print(f"[teaching-catalog] play {ref!r} -> {result}", flush=True)

    threading.Thread(target=_run, daemon=True).start()
