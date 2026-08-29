# 把 logo\dsh_logo.png 中 RGB≈白色的像素改成完全透明（alpha=0），再缩放到 240x320。
# 这样鲸鱼 PNG 就是透明背景了。

Add-Type -AssemblyName System.Drawing

$src = 'D:\projects\dsh-pet\logo\dsh_logo.png'
$dst = 'D:\projects\dsh-pet\logo\dsh_logo_sm.png'

$img = [System.Drawing.Image]::FromFile($src)
$srcW = $img.Width
$srcH = $img.Height

# 第一步：原图转成 RGBA，把白底改成透明
$bmp = New-Object System.Drawing.Bitmap $srcW, $srcH, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::Transparent)
$g.DrawImage($img, 0, 0)
$g.Dispose()
$img.Dispose()

# 遍历像素：RGB 接近白色 (>=240) 的改成 alpha=0
$threshold = 240
for ($y = 0; $y -lt $srcH; $y++) {
    for ($x = 0; $x -lt $srcW; $x++) {
        $pix = $bmp.GetPixel($x, $y)
        if ($pix.R -ge $threshold -and $pix.G -ge $threshold -and $pix.B -ge $threshold) {
            $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
        }
    }
}

# 第二步：缩放 240x320（lanczos 高质量）
$dstW = 240
$dstH = 320
$small = New-Object System.Drawing.Bitmap $dstW, $dstH, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
$g2.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g2.DrawImage($bmp, 0, 0, $dstW, $dstH)
$g2.Dispose()
$bmp.Dispose()

$small.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
$small.Dispose()

$bytes = [System.IO.File]::ReadAllBytes($dst)
$b64 = [Convert]::ToBase64String($bytes)

$out = 'D:\projects\dsh-pet\logo\_dsh_whale_b64.txt'
$b64 | Out-File -FilePath $out -Encoding ascii -NoNewline

"PNG: $dstW x $dstH"
"file size: $($bytes.Length) bytes"
"base64 length: $($b64.Length) chars"
"written to: $out"
