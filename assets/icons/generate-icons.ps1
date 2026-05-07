# ScreenScot — icon generator
# Renders the brand mark (gradient rounded square + 4-dot viewfinder) at all
# sizes required by manifest.json. Antialiased and HiDPI-clean.

Add-Type -AssemblyName System.Drawing

function New-RoundedPath {
    param(
        [int]$X, [int]$Y, [int]$Width, [int]$Height, [int]$Radius
    )
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $Radius * 2
    if ($d -gt 0) {
        $path.AddArc($X,                  $Y,                    $d, $d, 180, 90)
        $path.AddArc($X + $Width - $d,    $Y,                    $d, $d, 270, 90)
        $path.AddArc($X + $Width - $d,    $Y + $Height - $d,     $d, $d,   0, 90)
        $path.AddArc($X,                  $Y + $Height - $d,     $d, $d,  90, 90)
    } else {
        $path.AddRectangle((New-Object System.Drawing.Rectangle $X, $Y, $Width, $Height))
    }
    $path.CloseFigure()
    return $path
}

function New-Icon {
    param([int]$Size, [string]$OutPath)

    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    $bmp.SetResolution(72, 72)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # Gradient background — indigo (#818cf8) → violet (#a78bfa) at 135°
    $radius = [int][Math]::Round($Size * 0.22)
    $bgPath = New-RoundedPath -X 0 -Y 0 -Width $Size -Height $Size -Radius $radius

    $gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF 0, 0),
        (New-Object System.Drawing.PointF $Size, $Size),
        [System.Drawing.Color]::FromArgb(255, 0x81, 0x8c, 0xf8),
        [System.Drawing.Color]::FromArgb(255, 0xa7, 0x8b, 0xfa)
    )
    $g.FillPath($gradient, $bgPath)

    # Subtle inner highlight
    $highlightColor = [System.Drawing.Color]::FromArgb(36, 255, 255, 255)
    $highlight = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF 0, 0),
        (New-Object System.Drawing.PointF 0, $Size),
        $highlightColor,
        ([System.Drawing.Color]::FromArgb(0, 255, 255, 255))
    )
    $g.FillPath($highlight, $bgPath)

    # Viewfinder dots (matches popup SVG: 4 dots in corners of an inner box)
    # Reference grid: 32×32, dots at (11,11), (18,11), (11,18), (18,18), 3×3 each.
    $scale = [double]$Size / 32.0
    $dotSize  = [Math]::Max(1.0, 3.0 * $scale)
    $dotRadius = [Math]::Max(0, [int][Math]::Round($dotSize * 0.25))
    $whiteBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(245, 255, 255, 255))

    $coords = @(
        @{ x = 11.0; y = 11.0 },
        @{ x = 18.0; y = 11.0 },
        @{ x = 11.0; y = 18.0 },
        @{ x = 18.0; y = 18.0 }
    )

    foreach ($c in $coords) {
        $px = [int][Math]::Round($c.x * $scale)
        $py = [int][Math]::Round($c.y * $scale)
        $sz = [int][Math]::Round($dotSize)
        $dotPath = New-RoundedPath -X $px -Y $py -Width $sz -Height $sz -Radius $dotRadius
        $g.FillPath($whiteBrush, $dotPath)
        $dotPath.Dispose()
    }

    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)

    $whiteBrush.Dispose()
    $highlight.Dispose()
    $gradient.Dispose()
    $bgPath.Dispose()
    $g.Dispose()
    $bmp.Dispose()
}

$dir = $PSScriptRoot
if ([string]::IsNullOrEmpty($dir)) { $dir = (Get-Location).Path }

$sizes = @(16, 32, 48, 128)
foreach ($s in $sizes) {
    $path = Join-Path $dir ("icon{0}.png" -f $s)
    New-Icon -Size $s -OutPath $path
    Write-Output ("  generated {0}" -f $path)
}

Write-Output "Done."
