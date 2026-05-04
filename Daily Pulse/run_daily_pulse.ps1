$ErrorActionPreference = "Continue"
$root = "C:\Users\RichardMUSI\OneDrive - Dolfines_clean\OneDrive - Dolfines\Bureau\AI\Daily Pulse"
Set-Location -LiteralPath $root

$logDir = Join-Path $root "logs"
if (!(Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$stamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$log = Join-Path $logDir ("daily_pulse_" + $stamp + ".log")

# Run Python and capture stdout + stderr separately so full tracebacks are logged
$tmpErr = [System.IO.Path]::GetTempFileName()
try {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    $out = & py -3 "daily_pulse.py" 2>$tmpErr
  } elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $out = & python "daily_pulse.py" 2>$tmpErr
  } else {
    "Python launcher not found." | Out-File -FilePath $log -Encoding utf8
    exit 1
  }
} catch {
  $_ | Out-String | Out-File -FilePath $log -Encoding utf8 -Append
}

# Write stdout then stderr into the log (full traceback preserved)
if ($out)           { $out            | Out-File -FilePath $log -Encoding utf8 -Append }
$errContent = Get-Content $tmpErr -Raw -ErrorAction SilentlyContinue
if ($errContent)    { "--- STDERR ---" | Out-File -FilePath $log -Encoding utf8 -Append
                      $errContent      | Out-File -FilePath $log -Encoding utf8 -Append }
Remove-Item $tmpErr -ErrorAction SilentlyContinue


