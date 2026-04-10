<?php
// ============================================================
//  EVENTENTRY POS — Scanner / Ticket Validation API
//  File: api/scanner.php
//  POST ?action=scan    — validate a ticket code
//  GET  ?action=logs    — get check-in logs
//  GET  ?action=stats   — scanner stats for an event
// ============================================================
require_once __DIR__ . '/../includes/config.php';
$sess   = requireLogin();
$action = $_GET['action'] ?? '';
$body   = json_decode(file_get_contents('php://input'), true) ?? [];

match ($action) {
    'scan'  => scanTicket($body, $sess),
    'logs'  => getCheckInLogs(),
    'stats' => getScannerStats((int)($_GET['event_id'] ?? 0)),
    default => jsonResponse(['success' => false, 'error' => 'Unknown action'], 400),
};

// ── Scan / Validate ─────────────────────────────────────────
function scanTicket(array $b, array $sess): void {
    $code    = strtoupper(trim($b['ticket_code'] ?? ''));
    $eventId = (int)($b['event_id'] ?? 0);
    if (!$code) jsonResponse(['success' => false, 'error' => 'ticket_code required'], 422);

    $db   = getDB();
    // Lock the row to prevent race conditions (double scan)
    $stmt = $db->prepare('SELECT t.*, tt.name AS type_name, tt.color AS type_color, tt.price,
                                  e.name AS event_name
                           FROM tickets t
                           JOIN ticket_types tt ON tt.id = t.ticket_type_id
                           JOIN events e        ON e.id  = t.event_id
                           WHERE t.ticket_code = ?
                           FOR UPDATE');

    $db->beginTransaction();
    try {
        $stmt->execute([$code]);
        $ticket = $stmt->fetch();

        $result = ''; $msg = ''; $data = [];

        if (!$ticket) {
            $result = 'invalid';
            $msg    = 'Ticket code not found in system';
            $data   = ['ticket_code' => $code, 'status' => 'invalid'];
        } elseif ($eventId && (int)$ticket['event_id'] !== $eventId) {
            $result = 'wrong_event';
            $msg    = 'Ticket belongs to a different event: ' . $ticket['event_name'];
            $data   = ['ticket_code' => $code, 'status' => 'wrong_event', 'correct_event' => $ticket['event_name']];
        } elseif ($ticket['status'] === 'checked_in') {
            $result = 'already_used';
            $msg    = 'Ticket already used at ' . $ticket['checked_in_at'];
            $data   = [
                'ticket_code'   => $code,
                'status'        => 'already_used',
                'buyer_name'    => $ticket['buyer_name'],
                'type_name'     => $ticket['type_name'],
                'type_color'    => $ticket['type_color'],
                'checked_in_at' => $ticket['checked_in_at'],
            ];
        } else {
            // ✅ Valid — mark checked in
            $db->prepare('UPDATE tickets SET status=\'checked_in\', checked_in_at=NOW(), checked_in_by=? WHERE id=?')
               ->execute([$sess['user_id'], $ticket['id']]);
            $result = 'valid';
            $msg    = 'Welcome, ' . ($ticket['buyer_name'] ?: 'Guest') . '!';
            $data   = [
                'ticket_code' => $code,
                'status'      => 'valid',
                'buyer_name'  => $ticket['buyer_name'],
                'type_name'   => $ticket['type_name'],
                'type_color'  => $ticket['type_color'],
                'event_name'  => $ticket['event_name'],
                'price'       => $ticket['price'],
                'checked_in_at' => date('Y-m-d H:i:s'),
            ];
        }

        // Log every scan attempt
        $db->prepare('
            INSERT INTO check_in_logs (ticket_code, ticket_id, event_id, scanned_by, result)
            VALUES (?, ?, ?, ?, ?)
        ')->execute([
            $code,
            $ticket['id']       ?? null,
            $ticket['event_id'] ?? ($eventId ?: null),
            $sess['user_id'],
            $result,
        ]);

        $db->commit();
        jsonResponse(['success' => true, 'result' => $result, 'message' => $msg, 'data' => $data]);

    } catch (PDOException $e) {
        $db->rollBack();
        jsonResponse(['success' => false, 'error' => 'Scan failed: ' . $e->getMessage()], 500);
    }
}

// ── Check-in Logs ────────────────────────────────────────────
function getCheckInLogs(): void {
    $eventId = (int)($_GET['event_id'] ?? 0);
    $db      = getDB();
    $sql     = 'SELECT cl.*, u.full_name AS scanned_by_name
                FROM check_in_logs cl
                JOIN users u ON u.id = cl.scanned_by
                WHERE 1=1';
    $params  = [];
    if ($eventId) { $sql .= ' AND cl.event_id = ?'; $params[] = $eventId; }
    $sql .= ' ORDER BY cl.scanned_at DESC LIMIT 100';
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    jsonResponse(['success' => true, 'data' => $stmt->fetchAll()]);
}

// ── Scanner Stats ────────────────────────────────────────────
function getScannerStats(int $eventId): void {
    if (!$eventId) jsonResponse(['success'=>false,'error'=>'event_id required'],422);
    $db   = getDB();
    $stmt = $db->prepare('
        SELECT
            COUNT(*) AS total_scans,
            SUM(result = \'valid\')       AS valid_count,
            SUM(result = \'already_used\') AS used_count,
            SUM(result = \'invalid\')      AS invalid_count,
            SUM(result = \'wrong_event\')  AS wrong_event_count
        FROM check_in_logs WHERE event_id = ?
    ');
    $stmt->execute([$eventId]);
    jsonResponse(['success' => true, 'data' => $stmt->fetch()]);
}
