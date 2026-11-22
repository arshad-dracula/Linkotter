; Linkotter for Windows installer.
;   makensis /DVERSION=0.1.0 /DSRC=<folder with the built files> linkotter.nsi
;
; Installs the app and registers the network engine as an automatic Windows service, so the
; connection comes up at boot, before anyone signs in.

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!define APP "Linkotter"
!define ENGINE "linkotter-engine.exe"
!define SERVICE "Tailscale" ; service name is fixed inside the open-source engine for now
!define UNKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"

Name "${APP}"
OutFile "${SRC}\LinkotterSetup.exe"
InstallDir "$PROGRAMFILES64\${APP}"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
!define MUI_ICON "linkotter.ico"
!define MUI_UNICON "linkotter.ico"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open Linkotter"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function LaunchApp
  ; Start through Explorer so the app runs as the signed-in user, not elevated.
  Exec '"$WINDIR\explorer.exe" "$INSTDIR\${APP}.exe"'
FunctionEnd

Function .onInit
  SetRegView 64
  SetShellVarContext all
  ; The engine currently shares its service slot with Tailscale; refuse to clobber a real install.
  nsExec::Exec 'sc.exe query "${SERVICE}"'
  Pop $0
  ${If} $0 == 0
  ${AndIfNot} ${FileExists} "$INSTDIR\${ENGINE}"
    MessageBox MB_ICONSTOP "Tailscale is installed on this computer. Uninstall Tailscale first, then run this installer again." /SD IDOK
    SetErrorLevel 3
    Quit
  ${EndIf}
FunctionEnd

Section "Install"
  SetRegView 64
  SetShellVarContext all

  ; Upgrade: stop what is running so files can be replaced.
  nsExec::Exec 'taskkill.exe /F /IM "${APP}.exe"'
  Pop $0
  nsExec::Exec 'sc.exe stop "${SERVICE}"'
  Pop $0
  Sleep 1500

  SetOutPath "$INSTDIR"
  File "${SRC}\${APP}.exe"
  File "${SRC}\${ENGINE}"
  File "${SRC}\linkotter-cli.exe"
  File "${SRC}\wintun.dll"
  File "${SRC}\LICENSES.txt"

  ; Engine settings: never upload logs to the upstream vendor.
  CreateDirectory "$APPDATA\Tailscale"
  FileOpen $1 "$APPDATA\Tailscale\tailscaled-env.txt" w
  FileWrite $1 "TS_NO_LOGS_NO_SUPPORT=true$\r$\n"
  FileClose $1

  ; Register the service on first install; on upgrade it already exists.
  nsExec::Exec 'sc.exe query "${SERVICE}"'
  Pop $0
  ${If} $0 != 0
    nsExec::ExecToLog '"$INSTDIR\${ENGINE}" install-system-daemon'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "The Linkotter network service could not be installed (code $0)." /SD IDOK
      SetErrorLevel 4
      Abort
    ${EndIf}
  ${EndIf}
  nsExec::Exec 'sc.exe start "${SERVICE}"'
  Pop $0

  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${APP}.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "${UNKEY}" "DisplayName" "${APP}"
  WriteRegStr HKLM "${UNKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNKEY}" "Publisher" "PropVR"
  WriteRegStr HKLM "${UNKEY}" "DisplayIcon" "$INSTDIR\${APP}.exe"
  WriteRegStr HKLM "${UNKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "${UNKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKLM "${UNKEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetRegView 64
  SetShellVarContext all
  nsExec::Exec 'taskkill.exe /F /IM "${APP}.exe"'
  Pop $0
  nsExec::ExecToLog '"$INSTDIR\${ENGINE}" uninstall-system-daemon'
  Pop $0
  Sleep 1000
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$INSTDIR\${APP}.exe"
  Delete "$INSTDIR\${ENGINE}"
  Delete "$INSTDIR\linkotter-cli.exe"
  Delete "$INSTDIR\wintun.dll"
  Delete "$INSTDIR\LICENSES.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "${UNKEY}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP}"
  ; Device identity in ProgramData\Tailscale is kept so a reinstall stays signed in.
SectionEnd
