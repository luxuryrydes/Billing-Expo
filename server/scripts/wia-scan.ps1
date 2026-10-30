# Windows scanner helper for LR Billing (WIA). Run by the server; it prints one JSON object per line.
#   list : the scanners Windows knows and what each can do
#   scan : scan to JPEG/PNG files in -OutDir (every page of the document feeder, or one flatbed page)
param(
  [Parameter(Mandatory = $true)][ValidateSet('list', 'scan')][string]$Action,
  [string]$DeviceId = '',
  [string]$OutDir = '',
  [ValidateSet('color', 'gray', 'bw')][string]$Mode = 'color',
  [int]$Dpi = 200,
  [ValidateSet('feeder', 'flatbed')][string]$Source = 'feeder',
  [switch]$Duplex,
  [int]$MaxPages = 200
)
$ErrorActionPreference = 'Stop'

function Emit($o) { [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress -Depth 5)); [Console]::Out.Flush() }
function FindProp($props, $name, $id) {
  foreach ($p in $props) { if ($p.Name -eq $name -or $p.PropertyID -eq $id) { return $p } }
  return $null
}
function TrySet($props, $name, $id, $value) {
  $p = FindProp $props $name $id
  if ($null -eq $p) { return $false }
  try { $p.Value = $value; return $true } catch { return $false }
}
function Hr($e) { return ('{0:X8}' -f ([uint32]($e.Exception.HResult -band 0xFFFFFFFF))) }

$FMT_JPEG = '{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}'
$FMT_PNG = '{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}'
# Document handling bits (WIA): 1 feeder, 2 flatbed, 4 duplex
try { $dm = New-Object -ComObject WIA.DeviceManager } catch { Emit @{ error = 'wia_unavailable'; message = 'Windows Image Acquisition is not available on this computer.' }; exit 3 }

if ($Action -eq 'list') {
  $devices = @()
  foreach ($info in $dm.DeviceInfos) {
    if ($info.Type -ne 1) { continue }   # 1 = scanner
    $caps = 3                            # unknown: assume feeder + flatbed are possible
    try { $dev = $info.Connect(); $c = FindProp $dev.Properties 'Document Handling Capabilities' 3086; if ($null -ne $c) { $caps = [int]$c.Value } } catch { }
    $devices += @{ id = [string]$info.DeviceID; name = [string]$info.Properties.Item('Name').Value; feeder = (($caps -band 1) -ne 0); flatbed = (($caps -band 2) -ne 0); duplex = (($caps -band 4) -ne 0) }
  }
  Emit @{ ok = $true; devices = $devices }
  exit 0
}

# --- scan -----------------------------------------------------------------------------------------------
if (-not $OutDir) { Emit @{ error = 'bad_arguments'; message = 'OutDir is required' }; exit 2 }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$dev = $null
foreach ($info in $dm.DeviceInfos) { if ([string]$info.DeviceID -eq $DeviceId) { try { $dev = $info.Connect() } catch { Emit @{ error = 'device_busy'; message = 'The scanner could not be opened. Close other scanning programs and try again.' }; exit 4 } } }
if ($null -eq $dev) { Emit @{ error = 'device_not_found'; message = 'The scanner was not found. Check that it is switched on and connected.' }; exit 4 }

$handling = if ($Source -eq 'feeder') { 1 } else { 2 }
if ($Duplex) { $handling = $handling -bor 4 }
$null = TrySet $dev.Properties 'Document Handling Select' 3088 $handling
if ($Source -eq 'feeder') { $null = TrySet $dev.Properties 'Pages' 3096 0 }   # 0 = every page in the feeder
$item = $dev.Items.Item(1)
$intent = switch ($Mode) { 'color' { 1 } 'gray' { 2 } default { 4 } }       # 1 colour, 2 grey, 4 black and white text
$null = TrySet $item.Properties 'Current Intent' 6146 $intent
$null = TrySet $item.Properties 'Horizontal Resolution' 6147 $Dpi
$null = TrySet $item.Properties 'Vertical Resolution' 6148 $Dpi
$null = TrySet $item.Properties 'Horizontal Start Position' 6149 0
$null = TrySet $item.Properties 'Vertical Start Position' 6150 0
$null = TrySet $item.Properties 'Horizontal Extent' 6151 ([int][math]::Round(8.27 * $Dpi))   # A4
$null = TrySet $item.Properties 'Vertical Extent' 6152 ([int][math]::Round(11.69 * $Dpi))
$fmt = if ($Mode -eq 'bw') { $FMT_PNG } else { $FMT_JPEG }
$ext = if ($Mode -eq 'bw') { 'png' } else { 'jpg' }

$n = 0
while ($n -lt $MaxPages) {
  try {
    $img = $item.Transfer($fmt)
    if ($img.FileExtension -ne $ext) {   # some drivers ignore the requested format and return BMP: convert it
      $ip = New-Object -ComObject WIA.ImageProcess
      $ip.Filters.Add($ip.FilterInfos.Item('Convert').FilterID)
      $ip.Filters.Item(1).Properties.Item('FormatID').Value = $fmt
      $img = $ip.Apply($img)
    }
  } catch {
    $code = Hr $_
    if ($code -eq '80210003') {          # paper empty: the feeder is finished
      if ($n -eq 0) { Emit @{ error = 'no_paper'; message = 'There are no pages in the document feeder.' }; exit 5 }
      break
    }
    $msg = switch ($code) {
      '80210001' { 'The scanner is busy.' }
      '80210002' { 'Paper jam in the scanner.' }
      '80210005' { 'The scanner is offline. Check it is switched on and connected.' }
      '80210006' { 'The scanner cover is open.' }
      '8021000A' { 'The scanner lamp or sensor reported an error.' }
      default { "Scanner error $code. $($_.Exception.Message)" }
    }
    Emit @{ error = "wia_$code"; message = $msg; pages = $n }
    exit 6
  }
  $n++
  $path = Join-Path $OutDir ('page-{0:D3}.{1}' -f $n, $ext)
  if (Test-Path $path) { Remove-Item $path -Force }
  $img.SaveFile($path)
  Emit @{ page = $n; file = $path }
  if ($Source -eq 'flatbed') { break }   # the flatbed holds one page at a time
}
Emit @{ done = $true; pages = $n }
exit 0
