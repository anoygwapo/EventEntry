<?php
// ============================================================
//  EVENTENTRY POS — Check-in Management API
//  File: api/checkin.php
//  GET  ?action=list        — list tickets with check-in status
//  POST ?action=checkin     — manually check in a ticket by code
//  POST ?action=undo        — undo a check-in (admin only)
//  GET  ?action=stats       — check-in stats for an event
// ============================================================
require_once __DIR__ . '/../includes/config.php';
$sess   = requireLogin();
$action = $_GET['action'] ?? '';
$body   = json_decode(file_get_contents('php://input'), true) ?? [];

match ($action) {
    'list'   => listCheckins(),
    'checkin'=> doCheckin($body, $sess),
    'undo'   => undoCheckin($body, $sess),
    'stats'  => checkinStats((int)($_GET['event_id'] ?? 0)),
    default  => jsonResponse(['success' => false, 'error' => 'Unknown action'], 400),
};

// ── List all tickets for an event with check-in status ──────
function listCheckins(): void {
    $evId   = (int)($_GET['event_id'] ?? 0);
    $status = $_GET['status'] ?? 'all';
    $search = trim($_GET['search'] ?? '');

    if (!$evId) jsonResponse(['success' => false, 'error' => 'event_id required'], 422);

    $db  = getDB();
    $sql = 'SELECT
                t.id,
                t.ticket_code,
                t.buyer_name,
                t.status,
                t.checked_in_at,
                tt.name        AS ticket_type,
                tt.color       AS ticket_color,
                tx.buyer_email,
                tx.buyer_phone,
                u.full_name    AS checked_in_by_name
            FROM tickets t
            JOIN ticket_types tt      ON tt.id = t.ticket_type_id
            JOIN transaction_items ti ON ti.id = t.transaction_item_id
            JOIN transactions tx      ON tx.id = ti.transaction_id
            LEFT JOIN users u         ON u.id  = t.checked_in_by
            WHERE t.event_id = :eid';
    $params = ['eid' => $evId];

    if ($status === 'pending')    { $sql .= " AND t.status = 'pending'"; }
    if ($status === 'checked_in') { $sql .= " AND t.status = 'checked_in'"; }

    if ($search) {
        $sql .= ' AND (t.buyer_name LIKE :s OR tx.buyer_email LIKE :s2 OR t.ticket_code LIKE :s3)';
        $params['s']  = '%' . $search . '%';
        $params['s2'] = '%' . $search . '%';
        $params['s3'] = '%' . $search . '%';
    }

    $sql .= ' ORDER BY t.status ASC, t.created_at DESC LIMIT 500';

    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    jsonResponse(['success' => true, 'data' => $stmt->fetchAll()]);
}

// ── Manually check in a ticket ──────────────────────────────
function doCheckin(array $b, array $sess): void {
    $code    = strtoupper(trim($b['ticket_code'] ?? ''));
    $eventId = (int)($b['event_id'] ?? 0);

    if (!$code)    jsonResponse(['success' => false, 'error' => 'ticket_code required'], 422);
    if (!$eventId) jsonResponse(['success' => false, 'error' => 'event_id required'], 422);

    $db = getDB();
    $db->beginTransaction();

    try {
        // Lock row
        $stmt = $db->prepare('SELECT t.*, tt.name AS type_name, e.name AS event_name
                               FROM tickets t
                               JOIN ticket_types tt ON tt.id = t.ticket_type_id
                               JOIN events e        ON e.id  = t.event_id
                               WHERE t.ticket_code = ? FOR UPDATE');
        $stmt->execute([$code]);
        $ticket = $stmt->fetch();

        if (!$ticket) {
            $db->rollBack();
            jsonResponse(['success' => false, 'result' => 'invalid', 'error' => 'Ticket code not found'], 404);
        }
        if ((int)$ticket['event_id'] !== $eventId) {
            $db->rollBack();
            jsonResponse(['success' => false, 'result' => 'wrong_event', 'error' => 'Ticket belongs to: ' . $ticket['event_name']], 409);
        }
        if ($ticket['status'] === 'checked_in') {
            $db->rollBack();
            jsonResponse([
                'success' => false,
                'result'  => 'already_used',
                'error'   => 'Already checked in at ' . $ticket['checked_in_at'],
                'data'    => $ticket,
            ], 409);
        }

        // Mark checked in
        $db->prepare('UPDATE tickets SET status = \'checked_in\', checked_in_at = NOW(), checked_in_by = ? WHERE id = ?')
           ->execute([$sess['user_id'], $ticket['id']]);

        // Log it
        $db->prepare('INSERT INTO check_in_logs (ticket_code, ticket_id, event_id, scanned_by, result)
                      VALUES (?,?,?,?,\'valid\')')
           ->execute([$code, $ticket['id'], $eventId, $sess['user_id']]);

        $db->commit();
        jsonResponse([
            'success'  => true,
            'result'   => 'valid',
            'message'  => 'Checked in: ' . ($ticket['buyer_name'] ?: 'Guest'),
            'data'     => array_merge($ticket, ['checked_in_at' => date('Y-m-d H:i:s')]),
        ]);

    } catch (PDOException $e) {
        $db->rollBack();
        jsonResponse(['success' => false, 'error' => 'Check-in failed: ' . $e->getMessage()], 500);
    }
}

// ── Undo a check-in (admin only) ────────────────────────────
function undoCheckin(array $b, array $sess): void {
    requireAdmin();
    $ticketId = (int)($b['ticket_id'] ?? 0);
    if (!$ticketId) jsonResponse(['success' => false, 'error' => 'ticket_id required'], 422);

    $db = getDB();
    $db->prepare('UPDATE tickets SET status = \'pending\', checked_in_at = NULL, checked_in_by = NULL WHERE id = ?')
       ->execute([$ticketId]);

    jsonResponse(['success' => true, 'message' => 'Check-in undone']);
}

// ── Stats ────────────────────────────────────────────────────
function checkinStats(int $evId): void {
    if (!$evId) jsonResponse(['success' => false, 'error' => 'event_id required'], 422);
    $db   = getDB();
    $stmt = $db->prepare("
        SELECT
            COUNT(*)                                    AS total_tickets,
            SUM(status = 'checked_in')                 AS checked_in,
            SUM(status = 'pending')                    AS pending,
            ROUND(SUM(status='checked_in')/COUNT(*)*100,1) AS checkin_rate
        FROM tickets WHERE event_id = ?
    ");
    $stmt->execute([$evId]);
    jsonResponse(['success' => true, 'data' => $stmt->fetch()]);
}