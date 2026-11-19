#!/usr/bin/env python3
"""Generate status.json from bot profiles + message timestamps, and publish it to Vercel Blob.

Reads ONLY message timestamps, role, in_main_chat, and agent_id from the search index.
Never reads or writes message text, prompts, URLs, command args, emails or secrets.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Keep logs timely when launched under nohup
try:
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
except Exception:
    pass


def _apply_env_file(path: Path) -> None:
    """Load KEY=VALUE lines into os.environ without overriding existing values."""
    if not path.is_file():
        return
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip("'").strip('"')
        if key and key not in os.environ:
            os.environ[key] = val


def _path_from_env(name: str, default: Path | None = None) -> Path | None:
    raw = (os.environ.get(name) or "").strip()
    if raw:
        return Path(raw).expanduser()
    return default


_SCRIPT_ROOT = Path(__file__).resolve().parent.parent
_apply_env_file(_path_from_env("LBM_ENV_FILE") or (_SCRIPT_ROOT / ".secrets" / "refresher.env"))

ROOT = (_path_from_env("LBM_ROOT") or _SCRIPT_ROOT).resolve()
AGENTS_DIR = _path_from_env("LBM_AGENTS_DIR")
DB_PATH = _path_from_env("LBM_INDEX_DB")
DELETED_PATH = _path_from_env("LBM_DELETED_AGENTS")
if DELETED_PATH is None and AGENTS_DIR is not None:
    DELETED_PATH = AGENTS_DIR.parent / "deleted-agents.json"
CLUSTERS_PATH = ROOT / "clusters.json"
SECRETS_PATH = ROOT / ".secrets" / "blob-token"
BANNED_TERMS_PATH = _path_from_env("LBM_BANNED_TERMS_FILE") or (ROOT / ".secrets" / "banned-terms.txt")
STATE_PATH = ROOT / "logs" / "refresh-state.json"
LOCAL_STATUS_PATH = ROOT / "logs" / "status.json"
WORK_CACHE_PATH = ROOT / "logs" / "work-export-cache.json"
CONFIG_PATH = ROOT / "config.js"

IDLE_AFTER_SEC = 10 * 60
PULSE_SEC = 10 * 60
GLOW_SEC = 24 * 60 * 60
FORCE_PUBLISH_SEC = 10 * 60
LOOP_SEC = 90
TICKER_LIMIT = 30
WORK_CACHE_SEC = 5 * 60
WORK_SSH_TIMEOUT = 12

EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w.-]+\.\w+\b")
URL_RE = re.compile(r"(https?://\S+|www\.\S+)", re.I)
MD_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
WS_RE = re.compile(r"\s+")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def from_ms(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


KNOWN_COLORS = ("red", "green", "blue", "yellow", "orange", "magenta", "violet", "brown", "cyan", "pink", "teal")
CLUSTER_FALLBACK_COLOR = {
    "front-door": "orange",
    "building-and-fleet-care": "blue",
    "work": "violet",
    "money": "yellow",
    "career": "brown",
    "social-and-streaming": "magenta",
    "map-itself": "magenta",
    "other": "blue",
}

# Keys as reported by the optional work-fleet export, mapped to public display names.
WORK_EXPORT_KEYS = {
    "eevee": "Eevee",
    "kssm": "Umbreon",
    "reports": "Glaceon",
    "campaigns": "Sylveon",
    "scout": "Espeon",
    "partnerdesk": "Leafeon",
    "smeargle-designer": "Smeargle",
}

def _banned_terms() -> list[str]:
    """Load optional extra strip-terms from a local file and/or LBM_BANNED_TERMS."""
    terms: list[str] = []
    path = BANNED_TERMS_PATH
    if path is not None and path.is_file():
        try:
            for line in path.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    terms.append(line)
        except OSError:
            pass
    raw = (os.environ.get("LBM_BANNED_TERMS") or "").strip()
    if raw:
        terms.extend(part.strip() for part in raw.split(",") if part.strip())
    # Longer phrases first, unique case-insensitive
    seen: set[str] = set()
    unique: list[str] = []
    for term in sorted(terms, key=len, reverse=True):
        key = term.casefold()
        if key not in seen:
            seen.add(key)
            unique.append(term)
    return unique


def sanitise_public_text(text: str) -> str:
    """Strip URLs, emails, ids, and any locally configured blocklist terms."""
    text = text or ""
    text = MD_LINK_RE.sub(r"\1", text)
    text = URL_RE.sub("", text)
    text = EMAIL_RE.sub("", text)
    text = re.sub(
        r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
        "",
        text,
        flags=re.I,
    )
    text = re.sub(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "", text)
    text = re.sub(r"\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b", "", text, flags=re.I)
    for term in _banned_terms():
        text = re.sub(rf"\s*\(\s*{re.escape(term)}\s*\)", "", text, flags=re.I)
        text = re.sub(rf"\b{re.escape(term)}\b", "", text, flags=re.I)
    text = re.sub(r"\(\s*\)", "", text)
    text = WS_RE.sub(" ", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    return text.strip(" ,;:-")


def resolve_avatar_color(raw: str | None, cluster_id: str) -> str:
    name = (raw or "").strip().casefold()
    if name in KNOWN_COLORS:
        return name
    return CLUSTER_FALLBACK_COLOR.get(cluster_id, "blue")


def first_sentence(text: str) -> str:
    text = text or ""
    text = MD_LINK_RE.sub(r"\1", text)
    text = URL_RE.sub("", text)
    text = EMAIL_RE.sub("", text)
    text = WS_RE.sub(" ", text).strip()
    if not text:
        return ""
    match = re.search(r"(.+?[.!?])(\s|$)", text)
    sentence = match.group(1).strip() if match else text
    return WS_RE.sub(" ", sentence).strip()


def name_key(name: str) -> str:
    return name.split("·", 1)[0].strip().casefold()


def name_slug(name: str) -> str:
    short = name.split("·", 1)[0].strip()
    slug = re.sub(r"[^a-z0-9]+", "-", short.casefold()).strip("-")
    return slug or "bot"


def unique_slug(name: str, used: set[str]) -> str:
    base = name_slug(name)
    slug = base
    n = 2
    while slug in used:
        slug = f"{base}-{n}"
        n += 1
    used.add(slug)
    return slug


def load_deleted_ids() -> set[str]:
    if DELETED_PATH is None or not DELETED_PATH.exists():
        return set()
    try:
        data = json.loads(DELETED_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return set()
    agents = data.get("agents", data) if isinstance(data, dict) else {}
    if isinstance(agents, dict):
        return set(agents.keys())
    return set()


def load_clusters() -> list[dict]:
    data = json.loads(CLUSTERS_PATH.read_text())
    clusters = data["clusters"]
    for cluster in clusters:
        name = sanitise_public_text(cluster.get("name") or "")
        if name:
            cluster["name"] = name
        cluster["id"] = sanitise_public_text(cluster.get("id") or cluster["name"]).casefold().replace(" ", "-") or cluster.get("id")
        for slot in cluster.get("bots", []):
            if slot.get("role"):
                slot["role"] = sanitise_public_text(slot["role"])
    return clusters


def match_bot(name: str, clusters: list[dict]) -> tuple[dict, dict | None]:
    key = name_key(name)
    other = None
    for cluster in clusters:
        if cluster["id"] == "other":
            other = cluster
            continue
        for slot in cluster.get("bots", []):
            if name_key(slot["match"]) == key:
                return cluster, slot
            # Also allow the full display name to match a shorter prefix
            if key.startswith(name_key(slot["match"])) or name_key(slot["match"]).startswith(key):
                return cluster, slot
    return other or {
        "id": "other",
        "name": "Other",
        "color": "#8b93a7",
        "hub": {"x": 160, "y": 430},
        "bots": [],
    }, None


def load_profiles(deleted: set[str]) -> list[dict]:
    bots = []
    if AGENTS_DIR is None or not AGENTS_DIR.exists():
        return bots
    for path in sorted(AGENTS_DIR.iterdir()):
        if not path.is_dir():
            continue
        agent_id = path.name
        if agent_id in deleted:
            continue
        profile_path = path / "profile.json"
        if not profile_path.exists():
            continue
        try:
            profile = json.loads(profile_path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        name = (profile.get("name") or "").strip()
        if not name:
            continue
        bots.append(
            {
                "agent_id": agent_id,
                "name": name,
                "role": sanitise_public_text(first_sentence(profile.get("description") or "")),
                "avatarColor": profile.get("avatarColor"),
            }
        )
    return bots


def load_activity(agent_ids: list[str]) -> dict[str, dict]:
    """Read only timestamps and sender type — never message body."""
    empty = {
        aid: {"last_ms": None, "last_role": None, "last_main": None, "events24h": 0, "recent": []}
        for aid in agent_ids
    }
    if DB_PATH is None or not DB_PATH.exists() or not agent_ids:
        return empty
    uri = f"file:{DB_PATH}?mode=ro"
    try:
        con = sqlite3.connect(uri, uri=True)
    except sqlite3.Error:
        try:
            con = sqlite3.connect(f"file:{DB_PATH}?mode=ro&immutable=1", uri=True)
        except sqlite3.Error as exc:
            print(f"warning: could not open search index: {exc}", file=sys.stderr)
            return empty
    con.row_factory = sqlite3.Row
    try:
        now_ms = int(time.time() * 1000)
        since_24h = now_ms - GLOW_SEC * 1000
        placeholders = ",".join("?" * len(agent_ids))
        # Explicit column list — never SELECT * or body.
        rows = con.execute(
            f"""
            SELECT agent_id, role, timestamp_ms, in_main_chat
            FROM messages
            WHERE agent_id IN ({placeholders})
            ORDER BY timestamp_ms DESC
            """,
            agent_ids,
        ).fetchall()
    except sqlite3.Error as exc:
        print(f"warning: activity query failed: {exc}", file=sys.stderr)
        return empty
    finally:
        con.close()

    out = {aid: {"last_ms": None, "last_role": None, "last_main": None, "events24h": 0, "recent": []} for aid in agent_ids}
    for row in rows:
        aid = row["agent_id"]
        bucket = out[aid]
        ts = int(row["timestamp_ms"])
        role = row["role"]
        main = int(row["in_main_chat"])
        if bucket["last_ms"] is None:
            bucket["last_ms"] = ts
            bucket["last_role"] = role
            bucket["last_main"] = main
        if ts >= since_24h:
            bucket["events24h"] += 1
            if len(bucket["recent"]) < 8:
                bucket["recent"].append({"role": role, "ts": ts, "main": main})
    return out



def load_work_cache() -> dict:
    if not WORK_CACHE_PATH.exists():
        return {}
    try:
        data = json.loads(WORK_CACHE_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def save_work_cache(cache: dict) -> None:
    WORK_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    WORK_CACHE_PATH.write_text(json.dumps(cache, indent=2) + "\n")


def parse_work_export(raw: str) -> dict[str, dict]:
    """Keep only numeric activity fields for known keys. Drop everything else."""
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("work export is not an object")
    out: dict[str, dict] = {}
    for key in WORK_EXPORT_KEYS:
        item = data.get(key)
        if not isinstance(item, dict):
            continue
        last = item.get("lastActive")
        last_ts = None
        if isinstance(last, (int, float)) and last > 0:
            last_ts = float(last)
        elif isinstance(last, str) and last.strip():
            try:
                last_ts = datetime.strptime(last.strip(), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
            except ValueError:
                last_ts = None
        try:
            events = max(0, int(item.get("events24h") or 0))
        except (TypeError, ValueError):
            events = 0
        active = item.get("activeRecent")
        if not isinstance(active, bool):
            active = bool(last_ts is not None and (time.time() - last_ts) <= IDLE_AFTER_SEC)
        out[key] = {"lastActive": last_ts, "events24h": events, "activeRecent": active}
    return out


def fetch_work_export() -> dict[str, dict]:
    """Return cached or freshly fetched work-fleet activity. SSH failures keep last values."""
    cache = load_work_cache()
    bots = cache.get("bots") if isinstance(cache.get("bots"), dict) else {}
    fetched_at = cache.get("fetchedAt")
    try:
        fetched_at = float(fetched_at)
    except (TypeError, ValueError):
        fetched_at = 0.0
    host = (os.environ.get("LBM_WORK_EXPORT_HOST") or "").strip()
    cmd = (os.environ.get("LBM_WORK_EXPORT_CMD") or "").strip()
    if not host or not cmd:
        return bots
    if bots and fetched_at and (time.time() - fetched_at) < WORK_CACHE_SEC:
        return bots
    timeout = WORK_SSH_TIMEOUT
    raw_timeout = (os.environ.get("LBM_WORK_EXPORT_TIMEOUT") or "").strip()
    if raw_timeout:
        try:
            timeout = max(2, int(raw_timeout))
        except ValueError:
            pass
    try:
        proc = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", f"ConnectTimeout={min(8, timeout)}", host, cmd],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (subprocess.SubprocessError, OSError):
        print("work export: ssh failed; keeping last values", file=sys.stderr, flush=True)
        return bots
    if proc.returncode != 0:
        print("work export: ssh failed; keeping last values", file=sys.stderr, flush=True)
        return bots
    try:
        fresh = parse_work_export(proc.stdout)
    except (ValueError, json.JSONDecodeError):
        print("work export: invalid payload; keeping last values", file=sys.stderr, flush=True)
        return bots
    merged = dict(bots)
    merged.update(fresh)
    save_work_cache({"fetchedAt": time.time(), "bots": merged})
    return merged


def doing_now_work(act: dict, now_ts: float) -> str:
    if act.get("activeRecent"):
        return "Working"
    last = act.get("lastActive")
    if last is not None and (now_ts - last) <= IDLE_AFTER_SEC:
        return "Working"
    return "Idle"


def attach_work_fleet_bots(
    bots_out: list[dict],
    used_clusters: dict[str, dict],
    used_slugs: set[str],
    clusters_cfg: list[dict],
    now: datetime,
) -> None:
    """Add the work-fleet bots from clusters.json + the optional export."""
    work = next((c for c in clusters_cfg if c["id"] == "work"), None)
    if work is None:
        return
    export = fetch_work_export()
    slots = {name_key(slot["match"]): slot for slot in work.get("bots", [])}
    already = {name_key(bot["name"]) for bot in bots_out}
    now_ts = now.timestamp()
    if "work" not in used_clusters:
        used_clusters["work"] = {
            "id": work["id"],
            "name": work["name"],
            "color": work["color"],
            "hub": {"x": work["hub"]["x"], "y": work["hub"]["y"]},
        }
    for key, display in WORK_EXPORT_KEYS.items():
        if name_key(display) in already:
            continue
        slot = slots.get(name_key(display), {})
        act = export.get(key) or {}
        last = act.get("lastActive")
        last_iso = iso(datetime.fromtimestamp(last, tz=timezone.utc)) if last else None
        role = sanitise_public_text(slot.get("role") or "")
        bot = {
            "id": unique_slug(display, used_slugs),
            "name": display,
            "cluster": work["name"],
            "clusterId": work["id"],
            "role": role,
            "color": resolve_avatar_color(slot.get("color"), work["id"]),
            "lastActive": last_iso,
            "events24h": int(act.get("events24h") or 0),
            "doingNow": doing_now_work(act, now_ts),
            "x": slot.get("x"),
            "y": slot.get("y"),
        }
        bots_out.append(bot)
        already.add(name_key(display))

def doing_now(act: dict, now_ms: int) -> str:
    last = act["last_ms"]
    if last is None or (now_ms - last) > IDLE_AFTER_SEC * 1000:
        return "Idle"
    recent_non_main = [e for e in act["recent"] if (now_ms - e["ts"]) <= IDLE_AFTER_SEC * 1000 and e["main"] == 0]
    recent_any = [e for e in act["recent"] if (now_ms - e["ts"]) <= IDLE_AFTER_SEC * 1000]
    if recent_non_main and len(recent_non_main) >= max(1, len(recent_any) // 2):
        return "Running a routine"
    if act["last_role"] == "user":
        return "Replying"
    return "Working"


def ticker_action(role: str, main: int) -> str:
    if main == 0:
        return "Ran a routine" if role == "assistant" else "Routine started"
    if role == "assistant":
        return "Replied"
    return "Got a request"


def assign_other_positions(unplaced: list[dict], cluster: dict) -> None:
    hub = cluster.get("hub") or {"x": 160, "y": 430}
    cluster["hub"] = {"x": 160, "y": 430} if hub.get("y", 0) > 800 else hub
    hx, hy = cluster["hub"]["x"], cluster["hub"]["y"]
    if hx > 800:
        hx, hy = 160, 430
        cluster["hub"] = {"x": hx, "y": hy}
    count = len(unplaced)
    if count == 1:
        unplaced[0]["x"] = hx
        unplaced[0]["y"] = hy + 20
        return
    for i, bot in enumerate(unplaced):
        bot["x"] = hx + ((-1) ** i) * (70 + (i // 2) * 80)
        bot["y"] = hy + 20 + (i // 2) * 70


def build_status() -> dict:
    clusters_cfg = load_clusters()
    deleted = load_deleted_ids()
    profiles = load_profiles(deleted)
    activity = load_activity([b["agent_id"] for b in profiles])
    now = utc_now()
    now_ms = int(now.timestamp() * 1000)

    used_clusters: dict[str, dict] = {}
    unplaced_by_cluster: dict[str, list] = {}
    used_slugs: set[str] = set()
    bots_out = []

    for profile in profiles:
        cluster, slot = match_bot(profile["name"], clusters_cfg)
        act = activity[profile["agent_id"]]
        override = sanitise_public_text((slot or {}).get("role") or "")
        bot = {
            "id": unique_slug(profile["name"], used_slugs),
            "name": profile["name"],
            "cluster": cluster["name"],
            "clusterId": cluster["id"],
            "role": override or profile["role"],
            "color": resolve_avatar_color(profile.get("avatarColor"), cluster["id"]),
            "lastActive": iso(from_ms(act["last_ms"])) if act["last_ms"] else None,
            "events24h": act["events24h"],
            "doingNow": doing_now(act, now_ms),
            "x": (slot or {}).get("x"),
            "y": (slot or {}).get("y"),
        }
        if bot["x"] is None or bot["y"] is None:
            unplaced_by_cluster.setdefault(cluster["id"], []).append(bot)
        bots_out.append(bot)
        if cluster["id"] not in used_clusters:
            used_clusters[cluster["id"]] = {
                "id": cluster["id"],
                "name": cluster["name"],
                "color": cluster["color"],
                "hub": {"x": cluster["hub"]["x"], "y": cluster["hub"]["y"]},
            }

    before = {id(b) for b in bots_out}
    attach_work_fleet_bots(bots_out, used_clusters, used_slugs, clusters_cfg, now)
    for bot in bots_out:
        if id(bot) in before:
            continue
        if bot.get("x") is None or bot.get("y") is None:
            unplaced_by_cluster.setdefault(bot["clusterId"], []).append(bot)

    for cid, group in unplaced_by_cluster.items():
        cluster = used_clusters[cid]
        assign_other_positions(group, cluster)

    # Stable cluster order from the mapping file, then any extras
    order = [c["id"] for c in clusters_cfg]
    clusters_out = []
    for cid in order:
        if cid == "other" and cid not in used_clusters:
            continue
        if cid in used_clusters:
            clusters_out.append(used_clusters.pop(cid))
    clusters_out.extend(used_clusters.values())

    ticker = []
    for profile in profiles:
        for ev in activity[profile["agent_id"]]["recent"]:
            ticker.append(
                {
                    "at": iso(from_ms(ev["ts"])),
                    "bot": profile["name"],
                    "cluster": match_bot(profile["name"], clusters_cfg)[0]["name"],
                    "action": ticker_action(ev["role"], ev["main"]),
                }
            )
    ticker.sort(key=lambda e: e["at"], reverse=True)
    ticker = ticker[:TICKER_LIMIT]

    return {
        "generatedAt": iso(now),
        "bots": bots_out,
        "clusters": clusters_out,
        "ticker": ticker,
    }


def fingerprint(payload: dict) -> str:
    slim = {"bots": payload["bots"], "clusters": payload["clusters"], "ticker": payload["ticker"]}
    raw = json.dumps(slim, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def load_state() -> dict:
    if not STATE_PATH.exists():
        return {}
    try:
        return json.loads(STATE_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2) + "\n")


def read_token() -> str | None:
    token = os.environ.get("BLOB_READ_WRITE_TOKEN") or os.environ.get("VERCEL_BLOB_READ_WRITE_TOKEN")
    if token:
        return token.strip()
    if SECRETS_PATH.exists():
        return SECRETS_PATH.read_text().strip() or None
    return None


def extract_feed_url_from_config() -> str | None:
    if not CONFIG_PATH.exists():
        return None
    text = CONFIG_PATH.read_text()
    match = re.search(r'feedUrl\s*:\s*"([^"]+)"', text)
    return match.group(1) if match else None


def write_config(feed_url: str) -> None:
    existing = extract_feed_url_from_config()
    if existing == feed_url and CONFIG_PATH.exists():
        return
    CONFIG_PATH.write_text(
        "window.LIVE_BOT_MAP = {\n"
        f'  feedUrl: "{feed_url}"\n'
        "};\n"
    )


def upload_blob(payload: dict, token: str) -> str:
    body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    # Official Vercel Blob REST API. Stable pathname, overwrites in place, 60s cache (platform minimum).
    url = "https://blob.vercel-storage.com/?pathname=status.json"
    req = urllib.request.Request(
        url,
        data=body,
        method="PUT",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
            "x-api-version": "13",
            "x-vercel-blob-access": "public",
            "x-add-random-suffix": "0",
            "x-allow-overwrite": "1",
            "x-content-type": "application/json; charset=utf-8",
            "x-cache-control-max-age": "60",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"blob upload failed: HTTP {exc.code} {detail[:300]}") from exc
    feed_url = result.get("url") or result.get("downloadUrl")
    if not feed_url:
        raise RuntimeError("blob upload succeeded but no url was returned")
    return feed_url


def publish(payload: dict, force: bool = False) -> dict:
    digest = fingerprint(payload)
    state = load_state()
    last_hash = state.get("hash")
    last_pub = state.get("publishedAt")
    last_pub_ts = 0
    if last_pub:
        try:
            last_pub_ts = datetime.strptime(last_pub, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            last_pub_ts = 0
    age = time.time() - last_pub_ts
    changed = digest != last_hash
    should = force or changed or age >= FORCE_PUBLISH_SEC or not state.get("feedUrl")

    LOCAL_STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOCAL_STATUS_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")

    if not should:
        print(f"unchanged, skipping upload ({int(age)}s since last publish)")
        return state

    token = read_token()
    if not token:
        print("no blob token yet; wrote local status only", file=sys.stderr)
        state.update({"hash": digest, "generatedAt": payload["generatedAt"], "skippedReason": "no-token"})
        save_state(state)
        return state

    feed_url = upload_blob(payload, token)
    write_config(feed_url)
    state = {
        "hash": digest,
        "publishedAt": payload["generatedAt"],
        "generatedAt": payload["generatedAt"],
        "feedUrl": feed_url,
        "bots": len(payload["bots"]),
        "clusters": len(payload["clusters"]),
        "forced": (not changed) and age >= FORCE_PUBLISH_SEC,
    }
    save_state(state)
    kind = "forced refresh" if state["forced"] else ("first publish" if last_hash is None else "updated")
    print(f"{kind}: {len(payload['bots'])} bots, {len(payload['clusters'])} clusters, {feed_url}")
    return state


def loop() -> None:
    print(f"refresher loop every {LOOP_SEC}s (pid {os.getpid()})", flush=True)
    while True:
        started = time.time()
        try:
            payload = build_status()
            publish(payload)
        except Exception as exc:
            print(f"refresh error: {exc}", file=sys.stderr, flush=True)
        elapsed = time.time() - started
        time.sleep(max(1, LOOP_SEC - elapsed))


def main() -> int:
    parser = argparse.ArgumentParser(description="Build and publish the live bot map feed")
    parser.add_argument("--loop", action="store_true", help="Refresh every 90 seconds")
    parser.add_argument("--force", action="store_true", help="Upload even if unchanged")
    parser.add_argument("--once", action="store_true", help="Generate (and upload if possible) once")
    args = parser.parse_args()
    if args.loop:
        loop()
        return 0
    payload = build_status()
    state = publish(payload, force=args.force or args.once)
    print(json.dumps({k: v for k, v in {**state, "bots": len(payload["bots"]), "clusters": len(payload["clusters"])}.items() if k != "token"}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
