# Belt-and-suspenders against focus-stealing: stops any background app (incl. the scraping
# Chrome) from pulling itself to the foreground. Windows flashes the taskbar instead.
# Window state is untouched - nothing minimizes, pops up, or moves.
# Reverse with:  set-foreground-lock.ps1 -Reset
param([switch]$Reset)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FgLock {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SystemParametersInfo(uint a, uint b, UIntPtr c, uint d);
}
"@

$SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001
$SPIF_SENDCHANGE = 0x2
$timeout = if ($Reset) { 0 } else { 600000 }   # 10 min; 0 = default (stealing allowed)

[void][FgLock]::SystemParametersInfo($SPI_SETFOREGROUNDLOCKTIMEOUT, 0, [UIntPtr]::new([uint32]$timeout), $SPIF_SENDCHANGE)
if ($Reset) { Write-Output "Foreground lock reset to default." }
else { Write-Output ("Foreground lock ON (" + $timeout + " ms). Background apps cannot steal focus.") }
