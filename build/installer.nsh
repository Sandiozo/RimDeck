; RimDeck installer hooks (included by electron-builder).

; Close any running RimDeck before files are replaced, instead of asking the user to do it.
; The installer and uninstaller have different file names, so they are never matched.
!macro customCheckAppRunning
  DetailPrint "Closing RimDeck…"
  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  ${If} $0 == 0
    ; Give Windows a moment to release file handles.
    Sleep 1500
  ${EndIf}
!macroend
