<?php
require_once __DIR__ . '/../includes/config.php';
startSecureSession();
header('Content-Type: application/json');

$action = $_GET['action'] ?? $_POST['action'] ?? '';

match ($action) {
    'login'   => handleLogin(),
    'logout'  => handleLogout(),
    'check'   => handleCheck(),
    default   => jsonResponse(['success' => false, 'error' => 'Unknown action'], 400),
};

// ── Login ───────────────────────────────────────────────────
function handleLogin(): void {
    $body     = json_decode(file_get_contents('php://input'), true) ?? [];
    $username = trim($body['username'] ?? '');
    $password = $body['password'] ?? '';

    if (!$username || !$password) {
        jsonResponse(['success' => false, 'error' => 'Username and password required'], 422);
    }

    $db   = getDB();
    $stmt = $db->prepare('SELECT id, username, password, full_name, role, is_active FROM users WHERE username = ? LIMIT 1');
    $stmt->execute([$username]);
    $user = $stmt->fetch();

    if (!$user || !$user['is_active'] || !password_verify($password, $user['password'])) {
        jsonResponse(['success' => false, 'error' => 'Invalid credentials'], 401);
    }

    session_regenerate_id(true);
    $_SESSION['user_id']   = $user['id'];
    $_SESSION['username']  = $user['username'];
    $_SESSION['full_name'] = $user['full_name'];
    $_SESSION['role']      = $user['role'];

    jsonResponse([
        'success'   => true,
        'user_id'   => $user['id'],
        'username'  => $user['username'],
        'full_name' => $user['full_name'],
        'role'      => $user['role'],
    ]);
}

// ── Logout ──────────────────────────────────────────────────
function handleLogout(): void {
    $_SESSION = [];
    session_destroy();
    jsonResponse(['success' => true]);
}

// ── Session check ────────────────────────────────────────────
function handleCheck(): void {
    if (!empty($_SESSION['user_id'])) {
        jsonResponse([
            'success'   => true,
            'user_id'   => $_SESSION['user_id'],
            'username'  => $_SESSION['username'],
            'full_name' => $_SESSION['full_name'],
            'role'      => $_SESSION['role'],
        ]);
    }
    jsonResponse(['success' => false, 'error' => 'Not logged in'], 401);
}
