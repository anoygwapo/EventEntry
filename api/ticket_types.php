<?php
// ============================================================
//  EVENTENTRY POS — Ticket Types API
//  File: api/ticket_types.php
// ============================================================
require_once __DIR__ . '/../includes/config.php';
$sess   = requireLogin();
$action = $_GET['action'] ?? '';
$body   = json_decode(file_get_contents('php://input'), true) ?? [];

match ($action) {
    'list'   => listTicketTypes((int)($_GET['event_id'] ?? 0)),
    'create' => createTicketType($body),
    'update' => updateTicketType((int)($_GET['id'] ?? 0), $body),
    'delete' => deleteTicketType((int)($_GET['id'] ?? 0)),
    default  => jsonResponse(['success' => false, 'error' => 'Unknown action'], 400),
};

function listTicketTypes(int $eventId): void {
    $db   = getDB();
    $sql  = 'SELECT tt.*, (tt.total_qty - tt.sold_qty) AS available_qty,
                    ROUND(tt.sold_qty / tt.total_qty * 100, 1) AS sell_through_pct
             FROM ticket_types tt WHERE tt.is_active = 1';
    $params = [];
    if ($eventId) { $sql .= ' AND tt.event_id = ?'; $params[] = $eventId; }
    $sql .= ' ORDER BY tt.price DESC';
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    jsonResponse(['success' => true, 'data' => $stmt->fetchAll()]);
}

function createTicketType(array $b): void {
    requireAdmin();
    foreach (['event_id','name','price','total_qty'] as $f) {
        if (!isset($b[$f]) || $b[$f] === '') jsonResponse(['success'=>false,'error'=>"Field '$f' required"],422);
    }
    $db   = getDB();
    $stmt = $db->prepare('
        INSERT INTO ticket_types (event_id, name, description, price, total_qty, sold_qty, color)
        VALUES (:eid, :name, :desc, :price, :qty, 0, :color)
    ');
    $stmt->execute([
        'eid'   => (int)$b['event_id'],
        'name'  => sanitize($b['name']),
        'desc'  => sanitize($b['description'] ?? ''),
        'price' => (float)$b['price'],
        'qty'   => (int)$b['total_qty'],
        'color' => preg_match('/^#[0-9a-fA-F]{6}$/', $b['color'] ?? '') ? $b['color'] : '#8b5cf6',
    ]);
    jsonResponse(['success' => true, 'id' => (int)$db->lastInsertId(), 'message' => 'Ticket type created']);
}

function updateTicketType(int $id, array $b): void {
    requireAdmin();
    if (!$id) jsonResponse(['success'=>false,'error'=>'Missing id'],422);
    $db   = getDB();
    $stmt = $db->prepare('
        UPDATE ticket_types SET name=:name, description=:desc,
            price=:price, total_qty=:qty, color=:color
        WHERE id=:id
    ');
    $stmt->execute([
        'name'  => sanitize($b['name'] ?? ''),
        'desc'  => sanitize($b['description'] ?? ''),
        'price' => (float)($b['price'] ?? 0),
        'qty'   => (int)($b['total_qty'] ?? 0),
        'color' => preg_match('/^#[0-9a-fA-F]{6}$/', $b['color'] ?? '') ? $b['color'] : '#8b5cf6',
        'id'    => $id,
    ]);
    jsonResponse(['success' => true, 'message' => 'Ticket type updated']);
}

function deleteTicketType(int $id): void {
    requireAdmin();
    if (!$id) jsonResponse(['success'=>false,'error'=>'Missing id'],422);
    // Soft delete
    getDB()->prepare('UPDATE ticket_types SET is_active=0 WHERE id=?')->execute([$id]);
    jsonResponse(['success' => true, 'message' => 'Ticket type removed']);
}
