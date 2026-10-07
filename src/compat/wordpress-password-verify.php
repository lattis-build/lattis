<?php
// Runs only as a separate PHP CLI process. Input arrives on stdin; no secrets are written to logs.
$raw = file_get_contents('php://stdin', false, null, 0, 8192);
$input = is_string($raw) ? json_decode($raw, true) : null;
if (!is_array($input) || !is_string($input['password'] ?? null) || !is_string($input['hash'] ?? null)) {
    exit(2);
}
$password = $input['password'];
$hash = $input['hash'];
if (strlen($password) > 4096) {
    echo '0';
    exit(0);
}

function lattis_phpass_verify($password, $stored) {
    $alphabet = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    $log = strpos($alphabet, $stored[3]);
    if ($log === false || $log < 7 || $log > 20) return false;
    $salt = substr($stored, 4, 8);
    $working = md5($salt . $password, true);
    $count = 1 << $log;
    do {
        $working = md5($working . $password, true);
    } while (--$count);
    $encoded = substr($stored, 0, 12);
    $i = 0;
    do {
        $value = ord($working[$i++]);
        $encoded .= $alphabet[$value & 0x3f];
        if ($i < 16) $value |= ord($working[$i]) << 8;
        $encoded .= $alphabet[($value >> 6) & 0x3f];
        if ($i++ >= 16) break;
        if ($i < 16) $value |= ord($working[$i]) << 16;
        $encoded .= $alphabet[($value >> 12) & 0x3f];
        if ($i++ >= 16) break;
        $encoded .= $alphabet[($value >> 18) & 0x3f];
    } while ($i < 16);
    return hash_equals($stored, $encoded);
}

if (preg_match('/^\$wp\$2y\$(0[4-9]|1[0-4])\$[.\/A-Za-z0-9]{53}$/D', $hash)) {
    $prehash = base64_encode(hash_hmac('sha384', $password, 'wp-sha384', true));
    $valid = password_verify($prehash, substr($hash, 3));
} elseif (preg_match('/^\$2[aby]\$(0[4-9]|1[0-4])\$[.\/A-Za-z0-9]{53}$/D', $hash)) {
    $valid = password_verify($password, $hash);
} elseif (preg_match('/^\$P\$[.\/0-9A-Za-z]{31}$/D', $hash)) {
    $valid = lattis_phpass_verify($password, $hash);
} else {
    $valid = false;
}
echo $valid ? '1' : '0';
