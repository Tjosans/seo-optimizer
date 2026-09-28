; Included into the NSIS installer and uninstaller by electron-builder
; (`nsis.include` in electron-builder.config.cjs). It makes an update a
; handover rather than a gap: something of the app's is on screen the whole
; time, and the person never has to wonder whether it is still updating.
;
;   1. The app, holding a downloaded update, starts this installer and stays
;      open (apps/desktop/src/updater.ts). The installer's progress window
;      comes up in front of it.
;   2. customCheckAppRunning: when the files have to be replaced, the
;      installer writes <exe>.update-close in %TEMP%. The app is watching for
;      it and exits at once.
;   3. customInstall: with the new files in place, the installer starts the
;      new version itself and keeps its progress window up until the app
;      writes <exe>.update-started, once its window is showing.
;
; Neither step lists processes. electron-builder's stock check starts Windows
; PowerShell up to five times, and tasklist is no better: each takes one to
; four seconds on a busy machine. Whether any process still runs the app is
; answered instantly instead, by opening the exe for writing, which Windows
; refuses while a process is running from it.

; electron-builder leaves these out once customCheckAppRunning is defined,
; and the stock check this falls back to needs them.
!include "getProcessInfo.nsh"
Var pid

!define SEO_CLOSE_SIGNAL "$TEMP\${APP_EXECUTABLE_FILENAME}.update-close"
!define SEO_STARTED_SIGNAL "$TEMP\${APP_EXECUTABLE_FILENAME}.update-started"

!macro seoAppExeState _RESULT
  ; "busy" while some process runs $INSTDIR's exe, "free" otherwise.
  StrCpy ${_RESULT} "free"
  ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ClearErrors
    FileOpen $R8 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" a
    ${if} ${Errors}
      StrCpy ${_RESULT} "busy"
    ${else}
      FileClose $R8
    ${endIf}
  ${endIf}
!macroend

!macro customCheckAppRunning
  !insertmacro seoAppExeState $R9
  ${if} $R9 == "busy"
  ${andIf} ${isUpdated}
    ; The app that started this update is waiting for the word.
    FileOpen $R8 "${SEO_CLOSE_SIGNAL}" w
    FileClose $R8
    StrCpy $R7 0
    seoWaitForExit:
      Sleep 100
      !insertmacro seoAppExeState $R9
      IntOp $R7 $R7 + 1
      ${if} $R9 == "busy"
      ${andIf} $R7 < 150
        Goto seoWaitForExit
      ${endIf}
    Delete "${SEO_CLOSE_SIGNAL}"
  ${endIf}

  ; Still running after 15 seconds (an older version that knows no signal,
  ; say), or running while someone installs by hand: electron-builder's own
  ; check, which asks or closes it and waits.
  ${if} $R9 == "busy"
    !insertmacro IS_POWERSHELL_AVAILABLE
    !insertmacro _CHECK_APP_RUNNING
  ${endIf}
!macroend

; An update runs the old version's uninstaller first, and that one carries
; the old version's check for a running copy. A process Windows still lists
; after it has exited (any open handle keeps it there) fails that check five
; times, and the stock handling then abandons the update, leaving the old
; version installed. The new files are extracted over the old ones either
; way, so carry on; if the app really is still running, writing its files
; fails and says so.
!macro customUnInstallCheck
  ${if} ${Errors}
    DetailPrint "Could not run the old version's uninstaller; installing over it."
  ${elseIf} $R0 != 0
    DetailPrint "The old version's uninstaller exited with $R0; installing over it."
  ${endIf}
!macroend

!macro customInstall
  ; Only where the installer would start the app anyway (an update, run
  ; to restart into it); the stock start that follows then finds this copy
  ; running and just brings it forward.
  ${if} ${isUpdated}
    ${if} ${isForceRun}
    ${orIfNot} ${Silent}
      Delete "${SEO_STARTED_SIGNAL}"
      Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --updated'
      StrCpy $R7 0
      seoWaitForStart:
        ${ifNot} ${FileExists} "${SEO_STARTED_SIGNAL}"
        ${andIf} $R7 < 300
          Sleep 100
          IntOp $R7 $R7 + 1
          Goto seoWaitForStart
        ${endIf}
      Delete "${SEO_STARTED_SIGNAL}"
    ${endIf}
  ${endIf}
!macroend
