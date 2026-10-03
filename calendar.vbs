' Starts the Busan culture calendar without a console window (desktop shortcut / run.vbs at logon)
' Usage: wscript.exe calendar.vbs ["C:\path\to\node.exe"] [--logon]
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FolderExists(dir & "\logs") Then fso.CreateFolder(dir & "\logs")
nodeExe = "node"
extra = ""
For Each a In WScript.Arguments
  If a = "--logon" Then
    extra = " --logon"
  Else
    nodeExe = a
  End If
Next
sh.CurrentDirectory = dir
cmd = "cmd /c chcp 65001 >nul & """ & nodeExe & """ """ & dir & "\calendar\server.mjs""" & extra & " >> """ & dir & "\logs\calendar.txt"" 2>&1"
sh.Run cmd, 0, False
