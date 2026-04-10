<?php
// ============================================================
//  EVENTENTRY POS — Reports & Analytics API
//  File: api/reports.php
// ============================================================
require_once __DIR__ . '/../includes/config.php';
requireAdmin();
$action = $_GET['action'] ?? '';

match ($action) {
    'dashboard'  => dashboardStats((int)($_GET['event_id'] ?? 0)),
    'sales_trend'=> salesTrend((int)($_GET['event_id'] ?? 0), $_GET['range'] ?? 'month'),
    'checkins'   => checkinActivity((int)($_GET['event_id'] ?? 0)),
    'breakdown'  => ticketBreakdown((int)($_GET['event_id'] ?? 0)),
    'payments'   => paymentBreakdown((int)($_GET['event_id'] ?? 0)),
    'attendees'  => attendeeList(),
    default      => jsonResponse(['success' => false, 'error' => 'Unknown action'], 400),
};

function dashboardStats(int $evId): void {
    $db = getDB();
    // Revenue & transaction totals
    $stmt = $db->prepare('
        SELECT
            COUNT(*)                           AS total_transactions,
            COALESCE(SUM(total_amount), 0)     AS total_revenue,
            COALESCE(AVG(total_amount), 0)     AS avg_transaction,
            COALESCE(SUM(discount_amount), 0)  AS total_discounts
        FROM transactions WHERE event_id = ?
    ');
    $stmt->execute([$evId]);
    $txStats = $stmt->fetch();

    // Ticket stats
    $stmt2 = $db->prepare('
        SELECT
            COALESCE(SUM(sold_qty), 0)   AS total_sold,
            COALESCE(SUM(total_qty), 0)  AS total_capacity
        FROM ticket_types WHERE event_id = ? AND is_active = 1
    ');
    $stmt2->execute([$evId]);
    $ttStats = $stmt2->fetch();

    // Check-in count
    $stmt3 = $db->prepare("SELECT COUNT(*) AS checked_in FROM tickets WHERE event_id = ? AND status = 'checked_in'");
    $stmt3->execute([$evId]);
    $ciStats = $stmt3->fetch();

    // Today's revenue
    $stmt4 = $db->prepare("SELECT COALESCE(SUM(total_amount),0) AS today_revenue FROM transactions WHERE event_id=? AND DATE(created_at)=CURDATE()");
    $stmt4->execute([$evId]);
    $todayStats = $stmt4->fetch();

    jsonResponse(['success' => true, 'data' => array_merge($txStats, $ttStats, $ciStats, $todayStats)]);
}

function salesTrend(int $evId, string $range): void {
    $db   = getDB();
    $days = match ($range) { 'today' => 1, 'week' => 7, 'month' => 30, default => 90 };
    $stmt = $db->prepare('
        SELECT
            DATE(created_at)           AS sale_date,
            COUNT(*)                   AS tx_count,
            COALESCE(SUM(total_amount),0) AS revenue
        FROM transactions
        WHERE event_id = ?
          AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        GROUP BY DATE(created_at)
        ORDER BY sale_date ASC
    ');
    $stmt->execute([$evId, $days]);
    jsonResponse(['success' => true, 'data' => $stmt->fetchAll()]);
}

function checkinActivity(int $evId): void {
    $db   = getDB();
    $stmt = $db->prepare('
        SELECT
            DATE(checked_in_at)  AS checkin_date,
            HOUR(checked_in_at)  AS checkin_hour,
            COUNT(*)             AS count
        FROM tickets
        WHERE event_id = ? AND status = \'checked_in\'
        GROUP BY DATE(checked_in_at), HOUR(checked_in_at)
        ORDER BY checkin_date, checkin_hour
    ');
    $stmt->execute([$evId]);
    jsonResponse(['success' => true, 'data' => $stmt->fetchAll()]);
}

function ticketBreakdown(int $evId): void {
    $db   = getDB();
    $stmt = $db->prepare('
        SELECT tt.name, tt.color, tt.sold_qty, tt.total_qty,
               tt.price * tt.sold_qty AS revenue
        FROM ticket_types tt
        WHERE tt.event_id = ? AND tt.is_active = 1
        ORDER BY tt.sold_qty DESC
    ');
    $stmt->execute([$evId]);
    jsonResponse(['success' => true, 'data' => $stmt->fetchAll()]);
}

function paymentBreakdown(int $evId): void {
    $db   = getDB();
    $stmt = $db->prepare('
        SELECT payment_method, COUNT(*) AS tx_count,
               COALESCE(SUM(total_amount),0) AS revenue
        FROM transactions WHERE event_id = ?
        GROUP BY payment_method
    ');
    $stmt->execute([$evId]);
    jsonResponse(['success' => true, 'data' => $stmt->fetchAll()]);
}

function attendeeList(): void {
    $evId    = (int)($_GET['event_id'] ?? 0);
    $search  = trim($_GET['search'] ?? '');
    $db      = getDB();
    $sql = 'SELECT * FROM vw_attendees WHERE 1=1';
    $params = [];
    if ($evId) { $sql .= ' AND event_id IS NOT NULL'; } // filtered by join
    if ($search) {
        $sql .= ' AND (buyer_name LIKE ? OR buyer_email LIKE ? OR ticket_code LIKE ?)';
        $s = '%' . $search . '%';
        $params = array_merge($params, [$s, $s, $s]);
    }
    $sql .= ' ORDER BY sold_at DESC LIMIT 500';
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    jsonResponse(['success' => true, 'data' => $stmt->fetchAll()]);
}
