#!/bin/bash
# CapCut Editing Automation: puts the finished timeline into your CapCut project.
# Run it with CapCut fully quit. Nothing is deleted: the old project files are backed up first.
cd "$(dirname "$0")" || exit 1
PROJECT_NAME='__PROJECT_NAME__'
CONTENT='__CONTENT_NAME__'
DURATION='__DURATION__'
ROOT="$HOME/Movies/CapCut/User Data/Projects/com.lveditor.draft"

finish() { echo; read -r -p "Press Enter to close this window." _; exit "$1"; }

echo "Installing the timeline into the CapCut project \"$PROJECT_NAME\"..."
if pgrep -x "CapCut" >/dev/null 2>&1; then
  echo "CapCut is still running. Quit it completely (CapCut menu > Quit, or Cmd+Q), then run this again."
  finish 1
fi
if [ ! -d "$ROOT" ]; then
  echo "CapCut's projects folder isn't in the usual place."
  echo "In CapCut: Settings > Projects > Draft location shows it. Drag that folder into this window, then press Enter:"
  read -r ROOT
  ROOT="${ROOT%/}"; ROOT="${ROOT//\\ / }"; ROOT="${ROOT%\'}"; ROOT="${ROOT#\'}"
fi
P=""
for d in "$ROOT"/*/; do
  m="${d}draft_meta_info.json"
  [ -f "$m" ] || continue
  if grep -qF "\"draft_name\":\"$PROJECT_NAME\"" "$m" || grep -qF "\"draft_name\": \"$PROJECT_NAME\"" "$m"; then
    P="${d%/}"; break
  fi
done
if [ -z "$P" ]; then
  echo "No CapCut project called \"$PROJECT_NAME\" was found in $ROOT."
  echo "Check the project name in CapCut (it must match exactly) and that you saved it at least once."
  finish 1
fi
if [ ! -f "$P/$CONTENT" ]; then
  echo "The project folder doesn't contain $CONTENT. Was this timeline built from a different CapCut project?"
  finish 1
fi
if [ "$(head -c 1 "$P/$CONTENT")" != "{" ]; then
  echo "This CapCut version stores projects in a locked format, so the timeline can't be installed."
  finish 1
fi
TS=$(date +%Y%m%d-%H%M%S)
BK="$P/_backup_before_cca_$TS"
mkdir -p "$BK/Timelines"
TID=""
if [ -f "$P/Timelines/project.json" ]; then
  TID=$(grep -o '"main_timeline_id": *"[^"]*"' "$P/Timelines/project.json" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
fi
written=0
for rel in "$CONTENT" "$CONTENT.bak" "template-2.tmp" \
           "Timelines/$TID/$CONTENT" "Timelines/$TID/$CONTENT.bak" "Timelines/$TID/template-2.tmp"; do
  [ -n "$TID" ] || case "$rel" in Timelines/*) continue;; esac
  f="$P/$rel"
  if [ -f "$f" ] || [ "$rel" = "$CONTENT" ]; then
    mkdir -p "$BK/$(dirname "$rel")"
    [ -f "$f" ] && cp -p "$f" "$BK/$rel" && chmod u+w "$f"
    cp "draft/$CONTENT" "$f" && written=$((written + 1))
  fi
done
if [ -f "$P/draft_meta_info.json" ]; then
  cp -p "$P/draft_meta_info.json" "$BK/"
  chmod u+w "$P/draft_meta_info.json"
  perl -0pi -e "s/\"tm_duration\":\s*\d+/\"tm_duration\":$DURATION/" "$P/draft_meta_info.json"
fi
echo "Done: wrote the timeline to $written file(s) in $P"
echo "Backup of the previous files: $BK"
echo "Open CapCut and click the project \"$PROJECT_NAME\"."
finish 0
