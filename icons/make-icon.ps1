param([string]$OutDir)
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $OutDir | Out-Null

$S = 512
$bmp = New-Object System.Drawing.Bitmap $S, $S
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)
function C($hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }
function P($pts) { [System.Drawing.PointF[]]($pts | ForEach-Object { New-Object System.Drawing.PointF $_[0], $_[1] }) }
function RR($x, $y, $w, $h, $r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x, $y, 2*$r, 2*$r, 180, 90); $p.AddArc($x+$w-2*$r, $y, 2*$r, 2*$r, 270, 90)
  $p.AddArc($x+$w-2*$r, $y+$h-2*$r, 2*$r, 2*$r, 0, 90); $p.AddArc($x, $y+$h-2*$r, 2*$r, 2*$r, 90, 90)
  $p.CloseFigure(); $p
}

# Фон — голубой круг с градиентом
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Point 0,0), (New-Object System.Drawing.Point 0,$S), (C '#45b3f0'), (C '#1a6fc2')
$g.FillEllipse($bg, 8, 8, $S-16, $S-16)

# Бумажный самолётик (свой рисунок): верхнее крыло, нижняя часть, сгиб
$g.FillPolygon((New-Object System.Drawing.SolidBrush (C '#ffffff')), (P @(@(405,92), @(62,222), @(178,262))))
$g.FillPolygon((New-Object System.Drawing.SolidBrush (C '#d3e7f7')), (P @(@(405,92), @(178,262), @(212,368))))
$g.FillPolygon((New-Object System.Drawing.SolidBrush (C '#a9cdea')), (P @(@(178,262), @(212,368), @(236,296))))

# Видеокассета на переднем плане (с белой обводкой, чтобы отделялась от самолётика)
# VHS: широкий чёрный корпус, белая наклейка сверху, окошко с двумя бобинами плёнки
$body = RR 186 296 300 172 18
$g.FillPath((New-Object System.Drawing.SolidBrush (C '#1e1e24')), $body)
$pen = New-Object System.Drawing.Pen (C '#ffffff'), 12
$g.DrawPath($pen, $body)
$g.FillPath((New-Object System.Drawing.SolidBrush (C '#f4f4f4')), (RR 206 314 260 40 6))    # наклейка
$g.FillRectangle((New-Object System.Drawing.SolidBrush (C '#e5484d')), 206, 314, 34, 40)     # цветная полоса наклейки
$g.FillPath((New-Object System.Drawing.SolidBrush (C '#3a3a44')), (RR 236 370 200 78 12))   # окошко
$tape = New-Object System.Drawing.SolidBrush (C '#4a2e22')
$white = New-Object System.Drawing.SolidBrush (C '#ffffff')
$g.FillEllipse($tape, 252, 377, 64, 64)   # левая бобина — много плёнки
$g.FillEllipse($tape, 372, 391, 36, 36)   # правая — мало
$g.FillEllipse($white, 272, 397, 24, 24)
$g.FillEllipse($white, 378, 397, 24, 24)
$g.FillRectangle($tape, 316, 436, 66, 5)  # плёнка между бобинами
$g.Dispose()

foreach ($n in 128, 48, 32, 16) {
  $o = New-Object System.Drawing.Bitmap $n, $n
  $og = [System.Drawing.Graphics]::FromImage($o)
  $og.InterpolationMode = 'HighQualityBicubic'; $og.SmoothingMode = 'AntiAlias'; $og.PixelOffsetMode = 'HighQuality'
  $og.DrawImage($bmp, 0, 0, $n, $n); $og.Dispose()
  $o.Save((Join-Path $OutDir "icon$n.png"), [System.Drawing.Imaging.ImageFormat]::Png); $o.Dispose()
}
$bmp.Save((Join-Path $OutDir 'icon512.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"ok"
