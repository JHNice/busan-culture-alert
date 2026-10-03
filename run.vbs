' Hidden launcher for Task Scheduler / Startup folder.
' Usage: wscript.exe run.vbs "C:\path\to\node.exe"
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FolderExists(dir & "\logs") Then fso.CreateFolder(dir & "\logs")
nodeExe = "node"
If WScript.Arguments.Count > 0 Then nodeExe = WScript.Arguments(0)
sh.CurrentDirectory = dir
cmd = "cmd /c chcp 65001 >nul & """ & nodeExe & """ """ & dir & "\src\index.mjs"" >> """ & dir & "\logs\console.txt"" 2>&1"
sh.Run cmd, 0, False
' Also open the calendar window (skipped when openCalendarOnLogon is false in config.json)
sh.Run "wscript.exe """ & dir & "\calendar.vbs"" """ & nodeExe & """ --logon", 0, False
