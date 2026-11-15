param([switch]$Background)

$ErrorActionPreference = 'Stop'
$scoopPrefix = scoop prefix mongodb
if ($LASTEXITCODE -ne 0 -or -not $scoopPrefix) {
    throw 'Install MongoDB with scoop install main/mongodb first.'
}
$mongod = Join-Path $scoopPrefix 'bin\mongod.exe'
if (-not (Test-Path -LiteralPath $mongod -PathType Leaf)) {
    throw 'The MongoDB executable was not found in the Scoop installation.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$localRoot = Join-Path $repoRoot '.mongodb-local'
$dataPath = Join-Path $localRoot 'data'
$keyPath = Join-Path $localRoot 'replica.key'
$logPath = Join-Path $localRoot 'mongod.log'
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null

if (-not (Test-Path -LiteralPath $keyPath)) {
    $key = New-Object byte[] 64
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $random.GetBytes($key)
        $stream = [IO.File]::Open($keyPath, [IO.FileMode]::CreateNew)
        try {
            $encodedKey = [Text.Encoding]::ASCII.GetBytes([Convert]::ToBase64String($key))
            $stream.Write($encodedKey, 0, $encodedKey.Length)
        } finally {
            $stream.Dispose()
        }
    } finally {
        $random.Dispose()
    }
}

$mongodArgs = @(
    '--bind_ip', '127.0.0.1', '--port', '27017', '--replSet', 'rs0',
    '--dbpath', $dataPath, '--logpath', $logPath, '--logappend', '--keyFile', $keyPath
)
if ($Background) {
    $quotedArgs = $mongodArgs | ForEach-Object { '"{0}"' -f $_ }
    $process = Start-Process -FilePath $mongod -ArgumentList $quotedArgs -WindowStyle Hidden -PassThru
    Write-Output "Started MongoDB process $($process.Id). Run pnpm db:check to verify readiness."
} else {
    Write-Output "MongoDB log: $logPath"
    & $mongod @mongodArgs
    if ($LASTEXITCODE -ne 0) {
        throw "MongoDB exited with code $LASTEXITCODE. See $logPath."
    }
}
