# 从图像边缘洪水填充：外部背景白 → 透明；黑色轮廓内部的白色细节（眼/腹）保留。
# 纯 PowerShell + LockBits byte 数组（避免 PS7 System.Drawing.Common 的 C# 编译引用问题）。

Add-Type -AssemblyName System.Drawing

$src = 'D:\projects\dsh-pet\logo\dsh_logo.png'
$dst = 'D:\projects\dsh-pet\logo\dsh_logo_sm.png'

# 1) 载入并转 RGBA
$srcImg = [System.Drawing.Image]::FromFile($src)
$W = $srcImg.Width; $H = $srcImg.Height
$bmp = New-Object System.Drawing.Bitmap $W, $H, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::Transparent)
$g.DrawImage($srcImg, 0, 0)
$g.Dispose(); $srcImg.Dispose()

$rect = New-Object System.Drawing.Rectangle 0, 0, $W, $H
$data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $data.Stride
$len = $stride * $H
$px = New-Object byte[] $len
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $px, 0, $len)

# 2) BFS 从边缘标记背景白
$thr = 200
$bg = New-Object bool[] ($W * $H)
$q = New-Object System.Collections.Generic.Queue[int]
function AddSeed([int]$x, [int]$y) {
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $W -or $y -ge $H) { return }
  $i = $y * $W + $x
  if ($bg[$i]) { return }
  $o = $y * $stride + $x * 4
  if ($px[$o] -ge $thr -and $px[$o + 1] -ge $thr -and $px[$o + 2] -ge $thr) {
    $bg[$i] = $true
    $q.Enqueue($i)
  }
}
for ($x = 0; $x -lt $W; $x++) { AddSeed $x 0; AddSeed $x ($H - 1) }
for ($y = 0; $y -lt $H; $y++) { AddSeed 0 $y; AddSeed ($W - 1) $y }
while ($q.Count -gt 0) {
  $i = $q.Dequeue()
  $x = $i % $W; $y = [int]($i / $W)
  AddSeed ($x + 1) $y; AddSeed ($x - 1) $y; AddSeed $x ($y + 1); AddSeed $x ($y - 1)
}

# 3) 背景像素 alpha=0
for ($y = 0; $y -lt $H; $y++) {
  for ($x = 0; $x -lt $W; $x++) {
    if ($bg[$y * $W + $x]) { $px[$y * $stride + $x * 4 + 3] = 0 }
  }
}
[System.Runtime.InteropServices.Marshal]::Copy($px, 0, $data.Scan0, $len)
$bmp.UnlockBits($data)

# 4) 缩放 240x320
$ow = 240; $oh = 320
$small = New-Object System.Drawing.Bitmap $ow, $oh, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.Clear([System.Drawing.Color]::Transparent)
$g2.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
$g2.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g2.DrawImage($bmp, 0, 0, $ow, $oh)
$g2.Dispose(); $bmp.Dispose()

# 黑色主体内的两处"白色镂空"全部透明化，让它们消失融入背景（不做填黑，避免突出黑块）
function TransparentBox([System.Drawing.Bitmap]$b, [int]$x0, [int]$y0, [int]$x1, [int]$y1) {
  for ($y = $y0; $y -le $y1; $y++) {
    for ($x = $x0; $x -le $x1; $x++) {
      $p = $b.GetPixel($x, $y)
      if ($p.R -ge 160 -and $p.G -ge 160 -and $p.B -ge 160 -and $p.A -gt 0) {
        $b.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
      }
    }
  }
}
TransparentBox $small 188 126 214 154   # 尾巴上方白斑 → 透明化
TransparentBox $small 112 214 185 263   # 腹部下方白斑 → 透明化
TransparentBox $small 116 260 140 282   # 腹部下缘残留白三角 → 透明化（截图红框处）

$small.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
$small.Dispose()

$bytes = [System.IO.File]::ReadAllBytes($dst)
$b64 = [Convert]::ToBase64String($bytes)
$b64 | Out-File -FilePath 'D:\projects\dsh-pet\logo\_dsh_whale_b64.txt' -Encoding ascii -NoNewline

"PNG: ${ow}x${oh}"
"file size: $($bytes.Length) bytes"
"base64 length: $($b64.Length) chars"
