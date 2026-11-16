# Сборка APK «Полки» без Gradle: aapt2 -> javac -> d8 -> zipalign -> apksigner.
#
# Требования: JDK 17 и Android SDK (build-tools + platform) — берутся из
# toolchain, который уже лежит на этом ПК. Если пути другие — задайте
# переменные окружения POLKA_JDK / POLKA_SDK.
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$proj = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = "C:\Users\админ\AppData\Local\Temp\opencode\toolchain"

$jdk = if ($env:POLKA_JDK) { $env:POLKA_JDK } else {
  Get-ChildItem (Join-Path $root "jdk*") -Directory -ErrorAction SilentlyContinue |
    Select-Object -First 1 | ForEach-Object { $_.FullName }
}
$sdk = if ($env:POLKA_SDK) { $env:POLKA_SDK } else { Join-Path $root "sdk" }
if (-not $jdk -or -not (Test-Path $jdk)) { throw "JDK не найден. Задайте POLKA_JDK." }
if (-not (Test-Path $sdk)) { throw "Android SDK не найден. Задайте POLKA_SDK." }

$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$env:Path"

$bt = Get-ChildItem (Join-Path $sdk "build-tools") -Directory | Sort-Object Name -Descending | Select-Object -First 1
$platform = Get-ChildItem (Join-Path $sdk "platforms") -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (-not $bt -or -not $platform) { throw "Android build-tools/platform не установлены в $sdk" }

$python = "C:\Users\админ\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
$node = "C:\Users\админ\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

Write-Host "JDK:      $jdk"
Write-Host "Build:    $($bt.Name)"
Write-Host "Platform: $($platform.Name)"

# aapt2/d8/javac не открывают файлы по путям с кириллицей — собираем в ASCII-каталоге.
$work = "C:\polka-android-build"
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $work | Out-Null
Copy-Item "$proj\*" $work -Recurse -Force
Set-Location $work

$build = Join-Path $work "build"
Remove-Item $build -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$build\gen", "$build\classes", "$build\dex", "$build\www" | Out-Null

Write-Host "`n[1/7] Веб-сборка (relative paths)"
Push-Location (Split-Path -Parent $proj)
$repo = (Get-Location).Path
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $node "$repo\node_modules\vite\bin\vite.js" build --base=./ --outDir=dist-app 2>&1 | Out-Null
$viteCode = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($viteCode -ne 0) { throw "vite build failed ($viteCode)" }
# Для file:// убираем crossorigin, иначе браузер блокирует загрузку скриптов.
$indexPath = "$repo\dist-app\index.html"
$html = Get-Content $indexPath -Raw -Encoding UTF8
$html = $html -replace '\s+crossorigin', ''
Set-Content $indexPath $html -Encoding UTF8 -NoNewline
Copy-Item "$repo\dist-app\*" "$build\www" -Recurse -Force
Pop-Location

Write-Host "[2/7] Иконки"
$sizes = @{ 'mipmap-mdpi' = 48; 'mipmap-hdpi' = 72; 'mipmap-xhdpi' = 96; 'mipmap-xxhdpi' = 144; 'mipmap-xxxhdpi' = 192 }
& $python -c @"
from PIL import Image
import os
src = r'$repo\public\icons\icon-512.png'
res = r'$work\res'
im = Image.open(src).convert('RGBA')
for folder, size in {'mipmap-mdpi':48,'mipmap-hdpi':72,'mipmap-xhdpi':96,'mipmap-xxhdpi':144,'mipmap-xxxhdpi':192}.items():
    d = os.path.join(res, folder)
    os.makedirs(d, exist_ok=True)
    im.resize((size, size), Image.LANCZOS).save(os.path.join(d, 'ic_launcher.png'))
    im.resize((size, size), Image.LANCZOS).save(os.path.join(d, 'ic_launcher_round.png'))
print('icons ok')
"@
if ($LASTEXITCODE -ne 0) { throw "icons failed" }

$aapt2 = Join-Path $bt.FullName "aapt2.exe"
$d8 = Join-Path $bt.FullName "d8.bat"
$zipalign = Join-Path $bt.FullName "zipalign.exe"
$apksigner = Join-Path $bt.FullName "apksigner.bat"
$androidJar = "$build\android.jar"
Copy-Item (Join-Path $platform.FullName "android.jar") $androidJar -Force

Write-Host "[3/7] aapt2 compile"
& $aapt2 compile --dir "$work\res" -o "$build\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

Write-Host "[4/7] aapt2 link"
& $aapt2 link -o "$build\base.apk" -I $androidJar --manifest "$work\AndroidManifest.xml" `
  "$build\res.zip" --java "$build\gen" --min-sdk-version 24 --target-sdk-version 34 `
  --version-code 5 --version-name "1.3.0" --auto-add-overlay
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

# Приложение целиком внутрь APK: assets/www
Write-Host "[5/7] упаковка assets (веб-приложение)"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$build\base.apk", 'Update')
$www = "$build\www"
$files = Get-ChildItem $www -Recurse -File
foreach ($file in $files) {
  $rel = $file.FullName.Substring($www.Length + 1).Replace('\', '/')
  $entry = "assets/www/$rel"
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
    $zip, $file.FullName, $entry,
    [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
}
$zip.Dispose()
Write-Host "      файлов в assets: $($files.Count)"

Write-Host "[6/7] javac + d8"
$sources = @(Get-ChildItem "$work\src" -Recurse -Filter *.java | ForEach-Object { $_.FullName })
$sources += (Get-ChildItem "$build\gen" -Recurse -Filter R.java | ForEach-Object { $_.FullName })
[System.IO.File]::WriteAllLines("$build\sources.txt", $sources, (New-Object System.Text.UTF8Encoding $false))
& "$jdk\bin\javac.exe" -encoding UTF-8 -source 8 -target 8 -nowarn `
  -bootclasspath $androidJar -d "$build\classes" "@$build\sources.txt"
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

$classes = @(Get-ChildItem "$build\classes" -Recurse -Filter *.class | ForEach-Object { $_.FullName })
& $d8 --release --min-api 24 --lib $androidJar --output "$build\dex" @classes
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }

$zip = [System.IO.Compression.ZipFile]::Open("$build\base.apk", 'Update')
[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
  $zip, "$build\dex\classes.dex", "classes.dex",
  [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
$zip.Dispose()

Write-Host "[7/7] zipalign + подпись"
& $zipalign -f 4 "$build\base.apk" "$build\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

$ks = "$work\polka-release.keystore"
if (-not (Test-Path $ks)) {
  & "$jdk\bin\keytool.exe" -genkeypair -keystore $ks -storepass polka2026 -keypass polka2026 `
    -alias polka -keyalg RSA -keysize 2048 -validity 10000 `
    -dname "CN=Polka Books,O=Polka,C=RU" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "keytool failed" }
}
& $apksigner sign --ks $ks --ks-pass pass:polka2026 --key-pass pass:polka2026 `
  --out "$build\Polka-1.3.0.apk" "$build\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }
& $apksigner verify "$build\Polka-1.3.0.apk"
if ($LASTEXITCODE -ne 0) { throw "подпись не прошла проверку" }

# Копируем готовый APK обратно в проект
$outDir = Join-Path $proj "release"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Copy-Item "$build\Polka-1.3.0.apk" (Join-Path $outDir "Polka-1.3.0.apk") -Force

$size = [math]::Round((Get-Item "$build\Polka-1.3.0.apk").Length / 1MB, 2)
Write-Host "`nГотово: $outDir\Polka-1.3.0.apk ($size МБ)"
Write-Host "Проверка: $(& $aapt2 dump badging "$build\Polka-1.3.0.apk" | Select-Object -First 3)"
