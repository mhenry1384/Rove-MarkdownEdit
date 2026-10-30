# Adds a Start menu shortcut to the release build and associates .md/.markdown
# files with it, for the current user only (no admin, no installer).
# Run after `npm run tauri build -- --no-bundle`.

$ErrorActionPreference = 'Stop'

$exe = Join-Path $PSScriptRoot '..\src-tauri\target\release\rove-markdownedit.exe'
$exe = (Resolve-Path $exe).Path
$progId = 'Rove.MarkdownEdit.md'

# Start menu shortcut
$programs = [Environment]::GetFolderPath('Programs')
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path $programs 'Rove MarkdownEdit.lnk'))
$lnk.TargetPath = $exe
$lnk.WorkingDirectory = Split-Path $exe
$lnk.IconLocation = "$exe,0"
$lnk.Save()

# ProgID
$classes = 'HKCU:\Software\Classes'
New-Item "$classes\$progId\shell\open\command" -Force | Out-Null
Set-ItemProperty "$classes\$progId" '(default)' 'Markdown Document'
New-Item "$classes\$progId\DefaultIcon" -Force | Out-Null
Set-ItemProperty "$classes\$progId\DefaultIcon" '(default)' "`"$exe`",0"
Set-ItemProperty "$classes\$progId\shell\open\command" '(default)' "`"$exe`" `"%1`""

# Extensions: make it the default and list it under "Open with"
foreach ($ext in '.md', '.markdown') {
    New-Item "$classes\$ext\OpenWithProgids" -Force | Out-Null
    Set-ItemProperty "$classes\$ext" '(default)' $progId
    New-ItemProperty "$classes\$ext\OpenWithProgids" $progId -PropertyType String -Value '' -Force | Out-Null
}

# Tell Explorer the associations changed
Add-Type -Namespace Win32 -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, int f, IntPtr a, IntPtr b);'
[Win32.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

Write-Host "Shortcut and .md/.markdown association point to $exe"
