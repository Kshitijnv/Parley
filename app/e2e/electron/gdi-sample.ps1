# Private mode capture check (architecture.md revision 3 P6, method b): GDI
# CopyFromScreen from a separate process, like a real screen share. Reads a JSON
# request file { x, y, w, h, pts: [[px,py]...], hwnds: [..], png } in physical pixels
# and prints { pts: [[r,g,b]...], affinity: ["0x11"...] }. The affinity is recorded
# only: it reads 0x11 even when the window is captured as a black box.
param([Parameter(Mandatory = $true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class ParleyU32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint dwAffinity);
}
"@
[ParleyU32]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Drawing
$req = Get-Content -Raw $RequestPath | ConvertFrom-Json
$bmp = New-Object System.Drawing.Bitmap([int]$req.w, [int]$req.h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen([int]$req.x, [int]$req.y, 0, 0, $bmp.Size)
$g.Dispose()
if ($req.png) { $bmp.Save([string]$req.png, [System.Drawing.Imaging.ImageFormat]::Png) }
$pts = @()
foreach ($p in $req.pts) { $c = $bmp.GetPixel([int]$p[0], [int]$p[1]); $pts += , @([int]$c.R, [int]$c.G, [int]$c.B) }
$bmp.Dispose()
$aff = @()
foreach ($h in $req.hwnds) {
  [uint32]$a = 0
  $ok = [ParleyU32]::GetWindowDisplayAffinity([IntPtr][long]$h, [ref]$a)
  if ($ok) { $aff += ('0x{0:X}' -f $a) } else { $aff += 'error' }
}
@{ pts = $pts; affinity = $aff } | ConvertTo-Json -Compress -Depth 5
