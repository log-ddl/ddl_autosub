!macro NSIS_HOOK_POSTINSTALL
  ; AutoSubs no longer supports DaVinci Resolve: remove the launchers older
  ; versions installed so Resolve's Scripts menu has no dead entry.
  Delete "$APPDATA\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\AutoSubs.lua"
  Delete "$APPDATA\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\AutoSubs V2.lua"
  RMDir /r "$APPDATA\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\AutoSubs"
  Delete "$PROGRAMDATA\Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins\AutoSubs.lua"
  Delete "$PROGRAMDATA\Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins\AutoSubs V2.lua"

  ; Adobe Extension Installation
  CreateDirectory "$APPDATA\Adobe\CEP\extensions"
  CopyFiles "$INSTDIR\resources\com.autosubs.adobe" "$APPDATA\Adobe\CEP\extensions"

  ; Enable PlayerDebugMode for Adobe CEP extensions (CSXS 6-14)
  ; CSXS.13/14 are required for Premiere Pro 2026 (v26); older keys cover legacy versions.
  WriteRegStr HKCU "Software\Adobe\CSXS.6" "PlayerDebugMode" "1"
  WriteRegStr HKCU "Software\Adobe\CSXS.7" "PlayerDebugMode" "1"
  WriteRegStr HKCU "Software\Adobe\CSXS.8" "PlayerDebugMode" "1"
  WriteRegStr HKCU "Software\Adobe\CSXS.9" "PlayerDebugMode" "1"
  WriteRegStr HKCU "Software\Adobe\CSXS.10" "PlayerDebugMode" "1"
  WriteRegStr HKCU "Software\Adobe\CSXS.11" "PlayerDebugMode" "1"
  WriteRegStr HKCU "Software\Adobe\CSXS.12" "PlayerDebugMode" "1"
  WriteRegStr HKCU "Software\Adobe\CSXS.13" "PlayerDebugMode" "1"
  WriteRegStr HKCU "Software\Adobe\CSXS.14" "PlayerDebugMode" "1"
!macroend
