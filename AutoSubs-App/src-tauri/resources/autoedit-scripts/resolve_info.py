"""Print a snapshot of the currently open DaVinci Resolve project and timeline.

Read-only — makes no changes. Useful as a sanity check that the AutoEdit
runner is talking to Resolve correctly.
"""
import sys


def main() -> int:
    try:
        import DaVinciResolveScript as dvr
    except ImportError as exc:
        print(f"Could not import DaVinciResolveScript: {exc}", file=sys.stderr)
        print(
            "Is DaVinci Resolve installed and the scripting env set up?",
            file=sys.stderr,
        )
        return 1

    resolve = dvr.scriptapp("Resolve")
    if resolve is None:
        print(
            "Could not connect to Resolve. Open Resolve → Preferences → System → "
            "General, set 'External scripting using' to 'Local', then restart Resolve.",
            file=sys.stderr,
        )
        return 1

    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject()
    if project is None:
        print("No project is open in Resolve.", file=sys.stderr)
        return 1

    print(f"Resolve version: {resolve.GetVersionString()}")
    print(f"Project:         {project.GetName()}")
    print(f"Timelines:       {project.GetTimelineCount()}")

    timeline = project.GetCurrentTimeline()
    if timeline is None:
        print("(no timeline currently open)")
        return 0

    print()
    print(f"Current timeline: {timeline.GetName()}")
    print(f"  Frame rate:     {timeline.GetSetting('timelineFrameRate')}")
    print(f"  Resolution:     "
          f"{timeline.GetSetting('timelineResolutionWidth')}x"
          f"{timeline.GetSetting('timelineResolutionHeight')}")
    print(f"  Start TC:       {timeline.GetStartTimecode()}")

    video_tracks = timeline.GetTrackCount("video")
    audio_tracks = timeline.GetTrackCount("audio")
    print(f"  Video tracks:   {video_tracks}")
    print(f"  Audio tracks:   {audio_tracks}")

    total_clips = 0
    for track_index in range(1, video_tracks + 1):
        clips = timeline.GetItemListInTrack("video", track_index) or []
        total_clips += len(clips)
    print(f"  Video clips:    {total_clips}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
