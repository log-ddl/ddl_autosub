"""Add a blue marker at the current timeline playhead.

Small write action, easily reversed with Ctrl/Cmd+Z inside Resolve.
"""
import sys


def main() -> int:
    try:
        import DaVinciResolveScript as dvr
    except ImportError as exc:
        print(f"Could not import DaVinciResolveScript: {exc}", file=sys.stderr)
        return 1

    resolve = dvr.scriptapp("Resolve")
    if resolve is None:
        print(
            "Could not connect to Resolve. Open Resolve → Preferences → System → "
            "General, set 'External scripting using' to 'Local', then restart Resolve.",
            file=sys.stderr,
        )
        return 1

    project = resolve.GetProjectManager().GetCurrentProject()
    if project is None:
        print("No project is open.", file=sys.stderr)
        return 1

    timeline = project.GetCurrentTimeline()
    if timeline is None:
        print("No timeline is open.", file=sys.stderr)
        return 1

    # Playhead position is reported as a timecode string; convert to frames
    # relative to the timeline start for AddMarker.
    tc = timeline.GetCurrentTimecode()
    start_frame = timeline.GetStartFrame()
    fps = float(timeline.GetSetting("timelineFrameRate") or 24)

    def tc_to_frames(tc_str: str, fps: float) -> int:
        hh, mm, ss, ff = (int(part) for part in tc_str.replace(";", ":").split(":"))
        return int(round(((hh * 3600) + (mm * 60) + ss) * fps + ff))

    current_frame = tc_to_frames(tc, fps)
    frame_id = current_frame - start_frame
    if frame_id < 0:
        print(f"Playhead {tc} is before timeline start; nothing to do.", file=sys.stderr)
        return 1

    ok = timeline.AddMarker(
        frame_id,
        "Blue",
        "AutoEdit marker",
        "Added by AutoEdit test script",
        1,
        "",
    )
    if not ok:
        print("AddMarker failed. A marker may already exist at this frame.", file=sys.stderr)
        return 1

    print(f"Added blue marker at {tc} (frame {frame_id}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
