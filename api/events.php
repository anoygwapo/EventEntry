<?php
// ============================================================
//  EVENTENTRY POS — Events API
//  File: api/events.php
//  GET    ?action=list
//  GET    ?action=get&id=1
//  POST   ?action=create
//  POST   ?action=update&id=1
//  POST   ?action=delete&id=1
// ============================================================
require_once __DIR__ . '/../includes/config.php';
$sess   = requireLogin();
$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];
$body   = json_decode(file_get_contents('php://input'), true) ?? [];

match ($action) {
    'list'   => listEvents(),
    'get'    => getEvent((int)($_GET['id'] ?? 0)),
    'create' => createEvent($body, $sess),
    'update' => updateEvent((int)($_GET['id'] ?? 0), $body),
    'delete' => deleteEvent((int)($_GET['id'] ?? 0)),
    default  => jsonResponse(['success' => false, 'error' => 'Unknown action'], 400),
};

function listEvents(): void {
    $db   = getDB();
    $rows = $db->query('
        SELECT e.*,
               u.full_name                              AS created_by_name,
               COALESCE(SUM(tt.sold_qty), 0)           AS total_sold,
               COALESCE(SUM(tt.total_qty), 0)          AS total_tickets,
               COUNT(DISTINCT tx.id)                   AS transaction_count,
               COALESCE(SUM(tx.total_amount), 0)       AS total_revenue
        FROM events e
        LEFT JOIN users u        ON u.id  = e.created_by
        LEFT JOIN ticket_types tt ON tt.event_id = e.id AND tt.is_active = 1
        LEFT JOIN transactions tx ON tx.event_id = e.id
        GROUP BY e.id
        ORDER BY e.event_date DESC
    ')->fetchAll();
    jsonResponse(['success' => true, 'data' => $rows]);
}

function getEvent(int $id): void {
    if (!$id) jsonResponse(['success' => false, 'error' => 'Missing id'], 422);
    $db   = getDB();
    $stmt = $db->prepare('SELECT * FROM events WHERE id = ?');
    $stmt->execute([$id]);
    $ev   = $stmt->fetch();
    if (!$ev) jsonResponse(['success' => false, 'error' => 'Event not found'], 404);
    jsonResponse(['success' => true, 'data' => $ev]);
}

function createEvent(array $b, array $sess): void {
    requireAdmin();
    $required = ['name','venue','event_date','capacity'];
    foreach ($required as $f) {
        if (empty($b[$f])) jsonResponse(['success' => false, 'error' => "Field '$f' is required"], 422);
    }
    $db   = getDB();
    $stmt = $db->prepare('
        INSERT INTO events (name, description, venue, event_date, event_time, capacity, status, color, created_by)
        VALUES (:name, :desc, :venue, :date, :time, :cap, :status, :color, :uid)
    ');
    $stmt->execute([
        'name'   => sanitize($b['name']),
        'desc'   => sanitize($b['description'] ?? ''),
        'venue'  => sanitize($b['venue']),
        'date'   => $b['event_date'],
        'time'   => $b['event_time'] ?? null,
        'cap'    => (int)$b['capacity'],
        'status' => in_array($b['status'] ?? '', ['active','upcoming','closed','cancelled']) ? $b['status'] : 'upcoming',
        'color'  => preg_match('/^#[0-9a-fA-F]{6}$/', $b['color'] ?? '') ? $b['color'] : '#8b5cf6',
        'uid'    => $sess['user_id'],
    ]);
    jsonResponse(['success' => true, 'id' => (int)$db->lastInsertId(), 'message' => 'Event created']);
}

function updateEvent(int $id, array $b): void {
    requireAdmin();
    if (!$id) jsonResponse(['success' => false, 'error' => 'Missing id'], 422);
    $db   = getDB();
    $stmt = $db->prepare('
        UPDATE events SET name=:name, description=:desc, venue=:venue,
            event_date=:date, event_time=:time, capacity=:cap,
            status=:status, color=:color
        WHERE id=:id
    ');
    $stmt->execute([
        'name'   => sanitize($b['name'] ?? ''),
        'desc'   => sanitize($b['description'] ?? ''),
        'venue'  => sanitize($b['venue'] ?? ''),
        'date'   => $b['event_date'] ?? date('Y-m-d'),
        'time'   => $b['event_time'] ?? null,
        'cap'    => (int)($b['capacity'] ?? 100),
        'status' => in_array($b['status'] ?? '', ['active','upcoming','closed','cancelled']) ? $b['status'] : 'active',
        'color'  => preg_match('/^#[0-9a-fA-F]{6}$/', $b['color'] ?? '') ? $b['color'] : '#8b5cf6',
        'id'     => $id,
    ]);
    jsonResponse(['success' => true, 'message' => 'Event updated']);
}

function deleteEvent(int $id): void {
    requireAdmin();
    if (!$id) jsonResponse(['success' => false, 'error' => 'Missing id'], 422);
    getDB()->prepare('DELETE FROM events WHERE id = ?')->execute([$id]);
    jsonResponse(['success' => true, 'message' => 'Event deleted']);
}
