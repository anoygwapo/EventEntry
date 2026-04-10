<?php
// ============================================================
//  EVENTENTRY POS — Transactions API
//  File: api/transactions.php
//  POST ?action=checkout   — complete a sale
//  GET  ?action=list       — list transactions
//  GET  ?action=coupon     — validate coupon
// ============================================================
require_once __DIR__ . '/../includes/config.php';
$sess   = requireLogin();
$action = $_GET['action'] ?? '';
$body   = json_decode(file_get_contents('php://input'), true) ?? [];

match ($action) {
    'checkout'       => handleCheckout($body, $sess),
    'list'           => listTransactions(),
    'validate_coupon'=> validateCoupon($body),
    default          => jsonResponse(['success' => false, 'error' => 'Unknown action'], 400),
};

// ── Checkout ────────────────────────────────────────────────
function handleCheckout(array $b, array $sess): void {
    $db = getDB();

    // Validate required fields
    if (empty($b['event_id']) || empty($b['items']) || !is_array($b['items'])) {
        jsonResponse(['success' => false, 'error' => 'event_id and items[] required'], 422);
    }

    $eventId     = (int)$b['event_id'];
    $payMethod   = in_array($b['payment_method'] ?? '', ['cash','card','ewallet','gcash']) ? $b['payment_method'] : 'cash';
    $buyerName   = sanitize($b['buyer_name']  ?? '');
    $buyerEmail  = filter_var($b['buyer_email']  ?? '', FILTER_VALIDATE_EMAIL) ?: null;
    $buyerPhone  = sanitize($b['buyer_phone'] ?? '');
    $couponCode  = strtoupper(trim($b['coupon_code'] ?? ''));

    try {
        $db->beginTransaction();

        // 1. Lock ticket types and validate availability
        $subtotal = 0;
        $itemData = [];
        foreach ($b['items'] as $item) {
            $ttId = (int)($item['ticket_type_id'] ?? 0);
            $qty  = max(1, (int)($item['quantity'] ?? 1));
            $stmt = $db->prepare('SELECT * FROM ticket_types WHERE id = ? AND event_id = ? AND is_active = 1 FOR UPDATE');
            $stmt->execute([$ttId, $eventId]);
            $tt = $stmt->fetch();
            if (!$tt) { $db->rollBack(); jsonResponse(['success'=>false,'error'=>"Ticket type $ttId not found"],404); }
            $avail = $tt['total_qty'] - $tt['sold_qty'];
            if ($qty > $avail) { $db->rollBack(); jsonResponse(['success'=>false,'error'=>"Not enough {$tt['name']} tickets (only $avail left)"],409); }
            $itemData[] = ['tt' => $tt, 'qty' => $qty, 'total' => $tt['price'] * $qty];
            $subtotal  += $tt['price'] * $qty;
        }

        // 2. Apply coupon
        $discountAmt = 0;
        $couponId    = null;
        if ($couponCode) {
            $cs = $db->prepare('SELECT * FROM coupons WHERE code=? AND is_active=1 AND (expires_at IS NULL OR expires_at > NOW()) FOR UPDATE');
            $cs->execute([$couponCode]);
            $coupon = $cs->fetch();
            if ($coupon && $coupon['used_count'] < $coupon['max_uses']) {
                $couponId = $coupon['id'];
                $discountAmt = $coupon['discount_type'] === 'percent'
                    ? round($subtotal * $coupon['discount_value'] / 100, 2)
                    : min((float)$coupon['discount_value'], $subtotal);
                $db->prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?')->execute([$couponId]);
            }
        }
        $total = $subtotal - $discountAmt;

        // 3. Insert transaction
        $receiptNo = generateReceiptNo();
        $txStmt = $db->prepare('
            INSERT INTO transactions (receipt_no, event_id, buyer_name, buyer_email, buyer_phone, payment_method,
                subtotal, discount_amount, total_amount, coupon_id, staff_id)
            VALUES (:rno,:eid,:bname,:bemail,:bphone,:pay,:sub,:disc,:total,:cid,:sid)
        ');
        $txStmt->execute([
            'rno'    => $receiptNo,
            'eid'    => $eventId,
            'bname'  => $buyerName  ?: 'Walk-in Customer',
            'bemail' => $buyerEmail,
            'bphone' => $buyerPhone ?: null,
            'pay'    => $payMethod,
            'sub'    => $subtotal,
            'disc'   => $discountAmt,
            'total'  => $total,
            'cid'    => $couponId,
            'sid'    => $sess['user_id'],
        ]);
        $txId = (int)$db->lastInsertId();

        // 4. Insert items, generate tickets
        $generatedTickets = [];
        foreach ($itemData as $item) {
            $tiStmt = $db->prepare('
                INSERT INTO transaction_items (transaction_id, ticket_type_id, quantity, unit_price, total_price)
                VALUES (?,?,?,?,?)
            ');
            $tiStmt->execute([$txId, $item['tt']['id'], $item['qty'], $item['tt']['price'], $item['total']]);
            $tiId = (int)$db->lastInsertId();

            // Update sold_qty
            $db->prepare('UPDATE ticket_types SET sold_qty = sold_qty + ? WHERE id = ?')
               ->execute([$item['qty'], $item['tt']['id']]);

            // Generate individual tickets
            for ($i = 0; $i < $item['qty']; $i++) {
                $code = generateTicketCode($eventId);
                $tkStmt = $db->prepare('
                    INSERT INTO tickets (ticket_code, transaction_item_id, event_id, ticket_type_id, buyer_name, status)
                    VALUES (?,?,?,?,?,\'pending\')
                ');
                $tkStmt->execute([$code, $tiId, $eventId, $item['tt']['id'], $buyerName ?: 'Walk-in Customer']);
                $generatedTickets[] = [
                    'id'          => (int)$db->lastInsertId(),
                    'ticket_code' => $code,
                    'type_name'   => $item['tt']['name'],
                    'type_color'  => $item['tt']['color'],
                    'unit_price'  => $item['tt']['price'],
                ];
            }
        }

        $db->commit();

        jsonResponse([
            'success'   => true,
            'receipt_no'      => $receiptNo,
            'transaction_id'  => $txId,
            'subtotal'        => $subtotal,
            'discount_amount' => $discountAmt,
            'total_amount'    => $total,
            'buyer_name'      => $buyerName ?: 'Walk-in Customer',
            'buyer_email'     => $buyerEmail,
            'buyer_phone'     => $buyerPhone,
            'payment_method'  => $payMethod,
            'tickets'         => $generatedTickets,
        ]);

    } catch (PDOException $e) {
        $db->rollBack();
        jsonResponse(['success' => false, 'error' => 'Checkout failed: ' . $e->getMessage()], 500);
    }
}

// ── List Transactions ────────────────────────────────────────
function listTransactions(): void {
    $eventId = (int)($_GET['event_id'] ?? 0);
    $range   = $_GET['range']   ?? 'all';
    $payment = $_GET['payment'] ?? 'all';
    $db      = getDB();

    $sql    = 'SELECT tx.*, e.name AS event_name, u.full_name AS staff_name,
                      GROUP_CONCAT(CONCAT(tt.name," x",ti.quantity) SEPARATOR ", ") AS items_summary,
                      SUM(ti.quantity) AS total_tickets
               FROM transactions tx
               JOIN events e ON e.id = tx.event_id
               JOIN users u  ON u.id = tx.staff_id
               LEFT JOIN transaction_items ti ON ti.transaction_id = tx.id
               LEFT JOIN ticket_types tt      ON tt.id = ti.ticket_type_id
               WHERE 1=1';
    $params = [];
    if ($eventId) { $sql .= ' AND tx.event_id = ?'; $params[] = $eventId; }
    if ($payment !== 'all') { $sql .= ' AND tx.payment_method = ?'; $params[] = $payment; }
    if ($range === 'today')  { $sql .= ' AND DATE(tx.created_at) = CURDATE()'; }
    elseif ($range === 'week')  { $sql .= ' AND tx.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)'; }
    elseif ($range === 'month') { $sql .= ' AND tx.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)'; }
    $sql .= ' GROUP BY tx.id ORDER BY tx.created_at DESC LIMIT 500';

    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    jsonResponse(['success' => true, 'data' => $stmt->fetchAll()]);
}

// ── Validate Coupon ──────────────────────────────────────────
function validateCoupon(array $b): void {
    $code    = strtoupper(trim($b['code'] ?? ''));
    $eventId = (int)($b['event_id'] ?? 0);
    if (!$code) jsonResponse(['success' => false, 'error' => 'Code required'], 422);

    $stmt = getDB()->prepare('
        SELECT * FROM coupons
        WHERE code = ? AND is_active = 1
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (event_id IS NULL OR event_id = ?)
    ');
    $stmt->execute([$code, $eventId ?: 0]);
    $coupon = $stmt->fetch();

    if (!$coupon) jsonResponse(['success' => false, 'error' => 'Invalid or expired coupon'], 404);
    if ($coupon['used_count'] >= $coupon['max_uses']) jsonResponse(['success' => false, 'error' => 'Coupon has reached max uses'], 409);

    jsonResponse(['success' => true, 'data' => $coupon]);
}
