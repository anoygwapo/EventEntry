<?php
// ============================================================
//  EVENTENTRY POS — Core Configuration
//  File: includes/config.php
// ============================================================

// ── Database ────────────────────────────────────────────────
define('DB_HOST',    'localhost');
define('DB_NAME',    'evententry_db');
define('DB_USER',    'root');
define('DB_PASS',    '');
define('DB_CHARSET', 'utf8mb4');

define('APP_NAME',    'EventEntry POS');
define('APP_VERSION', '2.0');

// ── Session lifetime (seconds) ──────────────────────────────
define('SESSION_LIFETIME', 3600);

// ============================================================
//  🔑 PAYMONGO API KEYS
//  ➜  Paste your keys from: https://dashboard.paymongo.com/developers/keys
//  ➜  Test keys  → use when PAYMONGO_LIVE_MODE = false
//  ➜  Live keys  → use when PAYMONGO_LIVE_MODE = true
// ============================================================

// --- TEST MODE KEYS (starts with sk_test_ / pk_test_) -------
define('PAYMONGO_TEST_SECRET', 'sk_test_PASTE_YOUR_KEY_HERE');
define('PAYMONGO_TEST_PUBLIC', 'pk_test_PASTE_YOUR_KEY_HERE');

// --- LIVE MODE KEYS (starts with sk_live_ / pk_live_) -------
define('PAYMONGO_LIVE_SECRET', 'sk_live_PASTE_YOUR_LIVE_SECRET_KEY_HERE');
define('PAYMONGO_LIVE_PUBLIC', 'pk_live_PASTE_YOUR_LIVE_PUBLIC_KEY_HERE');

// --- WEBHOOK SECRET (from PayMongo Dashboard → Webhooks) ----
define('PAYMONGO_WEBHOOK_SECRET', 'whsec_PASTE_YOUR_WEBHOOK_SECRET_HERE');

// --- 🔄 TOGGLE: false = test mode, true = production live ----
define('PAYMONGO_LIVE_MODE', false);

// Auto-selects keys based on the toggle above — DO NOT EDIT BELOW
define('PAYMONGO_SECRET_KEY', PAYMONGO_LIVE_MODE ? PAYMONGO_LIVE_SECRET : PAYMONGO_TEST_SECRET);
define('PAYMONGO_PUBLIC_KEY', PAYMONGO_LIVE_MODE ? PAYMONGO_LIVE_PUBLIC : PAYMONGO_TEST_PUBLIC);
define('PAYMONGO_API',        'https://api.paymongo.com/v1');

// ── PDO Connection ──────────────────────────────────────────
function getDB(): PDO {
    static $pdo = null;
    if ($pdo !== null) return $pdo;
    $dsn = sprintf('mysql:host=%s;dbname=%s;charset=%s', DB_HOST, DB_NAME, DB_CHARSET);
    try {
        $pdo = new PDO($dsn, DB_USER, DB_PASS, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
    } catch (PDOException $e) {
        http_response_code(500);
        die(json_encode(['success' => false, 'error' => 'Database connection failed: ' . $e->getMessage()]));
    }
    return $pdo;
}

// ── Session helper ──────────────────────────────────────────
function startSecureSession(): void {
    if (session_status() === PHP_SESSION_NONE) {
        session_set_cookie_params([
            'lifetime' => SESSION_LIFETIME,
            'path'     => '/',
            'secure'   => false,   // set true in production with HTTPS
            'httponly' => true,
            'samesite' => 'Strict',
        ]);
        session_start();
    }
}

// ── JSON response helper ────────────────────────────────────
function jsonResponse(array $data, int $code = 200): void {
    http_response_code($code);
    header('Content-Type: application/json');
    echo json_encode($data);
    exit;
}

// ── Auth helpers ────────────────────────────────────────────
function requireLogin(): array {
    startSecureSession();
    if (empty($_SESSION['user_id'])) {
        jsonResponse(['success' => false, 'error' => 'Unauthorized'], 401);
    }
    return $_SESSION;
}

function requireAdmin(): array {
    $sess = requireLogin();
    if ($sess['role'] !== 'admin') {
        jsonResponse(['success' => false, 'error' => 'Forbidden: admin only'], 403);
    }
    return $sess;
}

// ── Sanitize helper ─────────────────────────────────────────
function sanitize(mixed $val): string {
    return htmlspecialchars(trim((string)$val), ENT_QUOTES, 'UTF-8');
}

// ── PayMongo API call helper ────────────────────────────────
function paymongoRequest(string $method, string $path, array $body = []): array {
    $ch = curl_init(PAYMONGO_API . $path);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST  => strtoupper($method),
        CURLOPT_HTTPHEADER     => [
            'Authorization: Basic ' . base64_encode(PAYMONGO_SECRET_KEY . ':'),
            'Content-Type: application/json',
            'Accept: application/json',
        ],
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_TIMEOUT        => 30,
    ]);
    if ($body) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    $response = curl_exec($ch);
    $httpCode  = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    $decoded = json_decode($response, true) ?? [];
    $decoded['_http_code'] = $httpCode;
    return $decoded;
}

// ── Ticket code generator ───────────────────────────────────
function generateTicketCode(int $eventId): string {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $seg   = fn(int $n) => implode('', array_map(fn() => $chars[random_int(0, strlen($chars)-1)], range(1,$n)));
    $ev    = strtoupper(substr(base_convert($eventId, 10, 36), -3));
    do {
        $code = sprintf('%s-%s-%s-%s', str_pad($ev,3,'X'), $seg(4), $seg(4), $seg(3));
        $row  = getDB()->prepare('SELECT id FROM tickets WHERE ticket_code = ?');
        $row->execute([$code]);
    } while ($row->fetch());
    return $code;
}

// ── Receipt number generator ────────────────────────────────
function generateReceiptNo(): string {
    $year  = date('Y');
    $db    = getDB();
    $count = (int)$db->query('SELECT COUNT(*) FROM transactions')->fetchColumn();
    return sprintf('RCP-%s-%04d', $year, $count + 1);
}