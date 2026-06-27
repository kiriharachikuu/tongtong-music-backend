$ErrorActionPreference = "Stop"

# 1. 登录 admin
$body = '{"username":"admin","password":"admin123"}'
$r = Invoke-WebRequest -Uri "http://localhost:3000/api/auth/login" -Method POST -Body $body -ContentType "application/json" -UseBasicParsing
$token = ($r.Content | ConvertFrom-Json).data.token
$header = @{ Authorization = "Bearer " + $token }
Write-Host "[OK] 登录成功"

# 2. 创建两首歌曲记录
$songs = @(
  @{ title = "搬家前，短暂夜"; singer = "ChiliChill乐团"; album = "原创单曲"; genre = "流行"; file = "E:\code\xingtong-song\backend\uploads\audio\ChiliChill乐团 - 搬家前，短暂夜.flac" },
  @{ title = "See You"; singer = "志国 一路"; album = "Cover"; genre = "流行"; file = "E:\code\xingtong-song\backend\uploads\audio\志国 一路 - See You (Cover).flac" }
)

$ids = @()
foreach ($s in $songs) {
  $body = ($s | Select-Object title, singer, album, genre | ConvertTo-Json -Compress)
  $r = Invoke-WebRequest -Uri "http://localhost:3000/api/admin/songs" -Method POST -Body $body -Headers $header -ContentType "application/json" -UseBasicParsing
  $id = ($r.Content | ConvertFrom-Json).data.id
  $ids += $id
  Write-Host ("[OK] 已创建歌曲: " + $s.title + " (ID=" + $id + ")")
}

# 3. 上传音频文件 (multipart/form-data)
function Send-Audio($songId, $filePath) {
  if (-not (Test-Path $filePath)) { Write-Host ("[跳过] 文件不存在: " + $filePath); return }
  $fileBytes = [System.IO.File]::ReadAllBytes($filePath)
  $boundary = "----tongtongBoundary" + [System.DateTime]::Now.Ticks.ToString("x")
  $lf = "`r`n"
  $headerText = "--$boundary$lf" +
    'Content-Disposition: form-data; name="audio"; filename="song.flac"' + $lf +
    'Content-Type: audio/flac' + $lf + $lf
  $footerText = "$lf--$boundary--$lf"

  $headerBytes = [System.Text.Encoding]::UTF8.GetBytes($headerText)
  $footerBytes = [System.Text.Encoding]::UTF8.GetBytes($footerText)

  $ms = New-Object System.IO.MemoryStream
  $ms.Write($headerBytes, 0, $headerBytes.Length)
  $ms.Write($fileBytes, 0, $fileBytes.Length)
  $ms.Write($footerBytes, 0, $footerBytes.Length)
  $ms.Position = 0

  try {
    $r = Invoke-WebRequest -Uri "http://localhost:3000/api/admin/songs/$songId/audio" -Method POST -Body $ms.ToArray() -Headers $header -ContentType "multipart/form-data; boundary=$boundary" -UseBasicParsing
    Write-Host ("[OK] 音频上传完成 (ID=" + $songId + ")")
    Write-Host ("  " + $r.Content)
  } catch {
    Write-Host ("[错误] 音频上传失败: " + $_.Exception.Message)
  }
}

for ($i = 0; $i -lt $songs.Count; $i++) {
  Send-Audio $ids[$i] $songs[$i].file
}

# 4. 最终验证
Write-Host "`n=== 最终歌曲列表 ==="
(Invoke-WebRequest -Uri "http://localhost:3000/api/songs" -UseBasicParsing).Content
