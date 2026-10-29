param (
    [string]$SrcPath,
    [string]$DstPath,
    [int]$MaxWidth = 1800
)

Add-Type -AssemblyName System.Drawing

$img = [System.Drawing.Image]::FromFile($SrcPath)
$origW = $img.Width
$origH = $img.Height

if ($origW -le $MaxWidth) {
    $img.Dispose()
    Copy-Item $SrcPath $DstPath -Force
    exit 0
}

$scale = $MaxWidth / $origW
$newW = $MaxWidth
$newH = [int]($origH * $scale)

$bmp = New-Object System.Drawing.Bitmap $newW, $newH
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($img, 0, 0, $newW, $newH)

$img.Dispose()

$bmp.Save($DstPath, [System.Drawing.Imaging.ImageFormat]::Jpeg)
$g.Dispose()
$bmp.Dispose()
