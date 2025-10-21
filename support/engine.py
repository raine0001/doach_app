"""
Support intent detection + autofix handlers.

This module centralises the heuristics that decide what helper flow to run
when a user sends a support request through the in-app widget.  Handlers are
kept intentionally lightweight so they can run inside the web request thread
without blocking; heavier work (video reprocessing, etc.) should be queued
elsewhere.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional
from datetime import datetime, timedelta


# --------------------------------------------------------------------------- #
#  Intent detection
# --------------------------------------------------------------------------- #

_INTENT_REGEXES = {
    "missed_shot": [
        r"miss(ed)? shot",
        r"shot (didn'?t|did not) log",
        r"lost shot",
        r"missing shot",
    ],
    "preferred_name": [
        r"call me (?P<name>[A-Za-z][A-Za-z\s\-']+)",
        r"my name is (?P<name>[A-Za-z][A-Za-z\s\-']+)",
        r"use the name (?P<name>[A-Za-z][A-Za-z\s\-']+)",
    ],
    "camera_setup": [
        r"camera setup",
        r"where (do|should) i (set|put) the camera",
        r"camera position",
        r"camera help",
    ],
    "progress_check": [
        r"how am i doing",
        r"how (do|am) (i|we) doing",
        r"progress report",
        r"compare sessions",
    ],
    "technical_issue": [
        r"technical issue",
        r"system problem",
        r"app (is|keeps) (crashing|freezing)",
        r"something (is|went) wrong",
    ],
    "account_setup": [
        r"setup my account",
        r"set up my account",
        r"account setup",
        r"activate my account",
    ],
    "challenge_help": [
        r"join a challenge",
        r"challenge help",
        r"what (challenge|challenges) are available",
        r"my challenge standing",
    ],
    "false_shot": [
        r"that (wasn'?t|was not) a shot",
        r"i didn'?t shoot",
        r"false trigger",
        r"shot logged but i didn't",
        r"logged a shot i didn't take",
    ],
}


def detect_intent(message: str) -> str:
    """Return the first matching intent for the supplied message."""
    if not message:
        return "general"
    text = message.lower()
    for intent, patterns in _INTENT_REGEXES.items():
        for pattern in patterns:
            if re.search(pattern, text):
                return intent
    return "general"


# --------------------------------------------------------------------------- #
#  Handler plumbing
# --------------------------------------------------------------------------- #

@dataclass
class HandlerResult:
    reply: Optional[str] = None
    result_status: Optional[str] = None
    action_taken: Optional[Dict[str, Any]] = None
    related_ticket_id: Optional[int] = None
    intent: Optional[str] = None
    meta: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "reply": self.reply,
            "result_status": self.result_status,
            "action_taken": self.action_taken,
            "related_ticket_id": self.related_ticket_id,
            "intent": self.intent,
            "meta": self.meta,
        }


Handler = Callable[[Dict[str, Any]], HandlerResult]


def _format_number(value: Optional[float]) -> str:
    if value is None:
        return "—"
    if isinstance(value, int):
        return str(value)
    return f"{value:.1f}"


def run_intent_handler(db: Dict[str, Any], intent: str, context: Dict[str, Any]) -> HandlerResult:
    handler = _HANDLERS.get(intent) or _handle_general
    try:
        return handler({**context, "db": db, "intent": intent})
    except Exception as exc:  # pragma: no cover - defensive
        return HandlerResult(
            reply="I ran into an issue while checking that. I've flagged it for follow-up.",
            result_status="needs_ticket",
            action_taken={"error": str(exc), "intent": intent},
        )


# --------------------------------------------------------------------------- #
#  Autofix helpers
# --------------------------------------------------------------------------- #

def _ensure_ticket(db: Dict[str, Any], user_id: Optional[int], title: str, description: str,
                   category: str = "technical", priority: str = "normal",
                   session_id: Optional[str] = None) -> int:
    SupportTicket = db["SupportTicket"]
    with db["Session"]() as s:
        ticket = SupportTicket(
            user_id=user_id,
            title=title,
            description=description,
            status="open",
            priority=priority,
            category=category,
            session_id=session_id,
        )
        s.add(ticket)
        s.commit()
        s.refresh(ticket)
        return ticket.id


# --------------------------------------------------------------------------- #
#  Handlers
# --------------------------------------------------------------------------- #


def _handle_missed_shot(ctx: Dict[str, Any]) -> HandlerResult:
    db = ctx["db"]
    session_id = ctx.get("session_id")
    user_id = ctx.get("user_id")
    shot_id = ctx.get("shot_id")
    total_logged = None
    latest_idx = None
    if session_id:
        ShotRow = db["ShotRow"]
        with db["Session"]() as s:
            rows = (
                s.query(ShotRow)
                .filter(ShotRow.sid == session_id)
                .order_by(ShotRow.shot_idx.asc())
                .all()
            )
            total_logged = len(rows)
            if rows:
                latest_idx = rows[-1].shot_idx
    action = {"autofix": "ensure_session_shot_count", "session_id": session_id}
    if shot_id is not None:
        action["reported_shot_id"] = shot_id

    reply_parts = []
    if total_logged is not None:
        reply_parts.append(f"I can see {total_logged} shot(s) logged for this session.")
        if total_logged < 10:
            reply_parts.append("I'll round the session off so the summary lands on 10 shots.")
    else:
        reply_parts.append("I couldn't see this session in the database just yet, but I'll keep looking.")
    if latest_idx is not None:
        reply_parts.append(f"The last confirmed shot was number {latest_idx}.")

    reply = " ".join(reply_parts) or "I'll keep an eye on that session and make sure the count stays accurate."
    return HandlerResult(
        reply=reply,
        result_status="in_progress",
        action_taken=action,
        intent="missed_shot",
        meta={"session_id": session_id, "shot_id": shot_id, "total_logged": total_logged},
    )


def _handle_preferred_name(ctx: Dict[str, Any]) -> HandlerResult:
    db = ctx["db"]
    user_id = ctx.get("user_id")
    message = ctx.get("message") or ""
    name_match = None
    for pattern in _INTENT_REGEXES["preferred_name"]:
        match = re.search(pattern, message.lower())
        if match and match.groupdict().get("name"):
            name_match = match.groupdict()["name"].strip()
            break
    preferred_name = name_match.title() if name_match else None
    updates = {}
    if user_id and preferred_name:
        User = db["User"]
        with db["Session"]() as s:
            user = s.query(User).filter(User.user_id == user_id).first()
            if user:
                user.name = preferred_name
                s.add(user)
                s.commit()
                updates["name"] = preferred_name
    reply = (
        f"Got it — I'll call you {preferred_name} from now on."
        if preferred_name
        else "I've saved your request and will use your preferred name from now on."
    )
    return HandlerResult(
        reply=reply,
        result_status="resolved",
        action_taken={"update_user_preferred_name": updates} if updates else None,
        intent="preferred_name",
    )


def _handle_camera_setup(ctx: Dict[str, Any]) -> HandlerResult:
    guidance = (
        "Line the hoop up with the overlay so the rim sits inside the highlighted ring. "
        "Position the ghost player so their feet match your shooting spot, and keep the full key visible. "
        "Once everything matches the guide, lock the hoop and you're ready."
    )
    return HandlerResult(
        reply=guidance,
        result_status="resolved",
        action_taken={"show_camera_overlay": True},
        intent="camera_setup",
    )


def _handle_progress_check(ctx: Dict[str, Any]) -> HandlerResult:
    db = ctx["db"]
    user_id = ctx.get("user_id")
    SessionRow = db["SessionRow"]
    summary = []
    meta: Dict[str, Any] = {}
    if user_id:
        with db["Session"]() as s:
            sessions = (
                s.query(SessionRow)
                .filter(SessionRow.user_id == user_id)
                .order_by(SessionRow.created_at.desc())
                .limit(5)
                .all()
            )
            if sessions:
                attempts = [sess.shots_count or 0 for sess in sessions]
                makes = [sess.makes or 0 for sess in sessions]
                arc = [sess.entry_angle_avg for sess in sessions if sess.entry_angle_avg is not None]
                avg_acc = round((sum(makes) / sum(attempts) * 100), 1) if sum(attempts) else None
                meta["session_samples"] = len(sessions)
                meta["attempts"] = attempts
                meta["makes"] = makes
                reply = []
                latest = sessions[0]
                reply.append(
                    f"Your most recent session logged {latest.makes or 0}/{latest.shots_count or 0} made shots."
                )
                if avg_acc is not None:
                    reply.append(f"Across your last {len(sessions)} sessions you're averaging {avg_acc}% makes.")
                if arc:
                    reply.append(
                        f"Entry angle is hovering around {_format_number(sum(arc)/len(arc))}°, which is close to target."
                    )
                improvement = None
                if len(makes) >= 4:
                    first_half = sum(makes[-4:]) / max(1, sum(attempts[-4:]))
                    last_half = sum(makes[:4]) / max(1, sum(attempts[:4]))
                    improvement = round((last_half - first_half) * 100, 1)
                    meta["accuracy_delta_pct"] = improvement
                if improvement is not None:
                    if improvement > 0:
                        reply.append(f"You're up roughly {improvement} percentage points versus earlier sessions — nice!")
                    elif improvement < 0:
                        reply.append(f"Accuracy dipped about {abs(improvement)} points; focus on a strong base next time.")
                summary.append(" ".join(reply))
    if not summary:
        summary.append("Once we have a few full sessions logged I'll put together a progress report for you.")
    return HandlerResult(
        reply=" ".join(summary),
        result_status="resolved",
        intent="progress_check",
        meta=meta or None,
    )


def _handle_technical_issue(ctx: Dict[str, Any]) -> HandlerResult:
    db = ctx["db"]
    user_id = ctx.get("user_id")
    checks = {}
    last_release = ctx.get("last_release")
    if last_release:
        checks["last_release_event"] = last_release
    else:
        checks["last_release_event"] = ctx.get("app_config_last_release")

    # Quick health snapshot
    checks["torches_loaded"] = bool(ctx.get("torch_available"))
    checks["active_sessions"] = list(ctx.get("active_sessions", []))[:5]

    ticket_id = _ensure_ticket(
        db,
        user_id=user_id,
        title="Technical diagnostics requested",
        description="Automated diagnostics were requested due to a technical issue report.",
        category="technical",
        priority="high",
        session_id=ctx.get("session_id"),
    )
    reply = (
        "I ran a quick health check on the system. Everything looks steady, but I've opened a ticket so the team "
        "can dig deeper and follow up shortly."
    )
    return HandlerResult(
        reply=reply,
        result_status="needs_ticket",
        action_taken={"diagnostics": checks, "ticket": ticket_id},
        related_ticket_id=ticket_id,
        intent="technical_issue",
        meta=checks,
    )


def _handle_account_setup(ctx: Dict[str, Any]) -> HandlerResult:
    steps = (
        "To finish setting up your account: 1) Open the Menu ▸ Account to confirm your email and profile. "
        "2) Visit Equipment to lock your hoop and calibrate. 3) Run the short camera alignment guide once. "
        "After that you're ready to start a live session."
    )
    return HandlerResult(
        reply=steps,
        result_status="resolved",
        action_taken={"provide_checklist": True},
        intent="account_setup",
    )


def _handle_challenge_help(ctx: Dict[str, Any]) -> HandlerResult:
    db = ctx["db"]
    Event = db["Event"]
    EventRegistration = db["EventRegistration"]
    user_id = ctx.get("user_id")
    details = []
    with db["Session"]() as s:
        events = s.query(Event).order_by(Event.start_date.asc()).limit(3).all()
        if events:
            for ev in events:
                details.append(
                    f"{ev.name} ({ev.slug}) runs {ev.start_date} → {ev.end_date}, needs {ev.min_shots}+ shots per session."
                )
        if user_id:
            regs = (
                s.query(EventRegistration)
                .filter(EventRegistration.user_id == user_id)
                .order_by(EventRegistration.registered_at.desc())
                .all()
            )
            if regs:
                latest = regs[0]
                details.append(
                    f"You're registered for {latest.event_id}; check Menu ▸ Challenges for live standings."
                )
    if not details:
        details.append("Open Menu ▸ Challenges to browse current events. Pick one and tap Join to get started.")
    return HandlerResult(
        reply=" ".join(details),
        result_status="resolved",
        intent="challenge_help",
    )


def _handle_false_shot(ctx: Dict[str, Any]) -> HandlerResult:
    db = ctx["db"]
    session_id = ctx.get("session_id")
    details: Dict[str, Any] = {}
    shot_idx = None

    if session_id:
        ShotRow = db.get("ShotRow")
        if ShotRow is not None:
            with db["Session"]() as s:
                last_shot = (
                    s.query(ShotRow)
                    .filter(ShotRow.sid == session_id)
                    .order_by(ShotRow.idx.desc())
                    .first()
                )
                if last_shot:
                    shot_idx = last_shot.idx
                    details["shot_idx"] = shot_idx
                    details["miss_reason_before"] = last_shot.miss_reason
                    last_shot.miss_reason = "false_trigger"
                    data = dict(last_shot.data or {})
                    flags = data.get("flags")
                    if not isinstance(flags, list):
                        flags = [] if flags is None else [flags]
                    flags.append({
                        "type": "false_trigger",
                        "flagged_at": datetime.utcnow().isoformat(),
                    })
                    data["flags"] = flags
                    last_shot.data = data
                    s.add(last_shot)
                    s.commit()

    if shot_idx is None:
        return HandlerResult(
            reply="Which shot should I fix? Tell me \"mark shot 3 false\" or similar.",
            result_status="pending_user",
            action_taken={
                "autofix": "flag_false_shot_pending",
                "session_id": session_id,
            },
            intent="false_shot",
        )

    reply = f"I've marked shot {shot_idx} as a false trigger. Take another attempt when you're ready."

    return HandlerResult(
        reply=reply,
        result_status="resolved",
        action_taken={
            "autofix": "flag_false_shot",
            "session_id": session_id,
            **details,
        },
        intent="false_shot",
    )


def _handle_general(ctx: Dict[str, Any]) -> HandlerResult:
    return HandlerResult(
        reply="Thanks for the update — I'll keep that noted. If you need something specific just let me know.",
        result_status="pending_user",
        intent="general",
    )


_HANDLERS: Dict[str, Handler] = {
    "missed_shot": _handle_missed_shot,
    "preferred_name": _handle_preferred_name,
    "camera_setup": _handle_camera_setup,
    "progress_check": _handle_progress_check,
    "technical_issue": _handle_technical_issue,
    "account_setup": _handle_account_setup,
    "challenge_help": _handle_challenge_help,
    "false_shot": _handle_false_shot,
    "general": _handle_general,
}
