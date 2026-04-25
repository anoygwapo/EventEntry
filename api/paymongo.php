<?php

require_once __DIR__ . '/../includes/config.php';
header('Content-Type: application/json');

// Keys come from config.php — no need to define them here again
// PAYMONGO_SECRET_KEY and PAYMONGO_PUBLIC_KEY are already set.

$action = $_GET['action'] ?? $_POST['action'] ?? '';
$body   = json_decode(file_get_contents('php://input'), true) ?? [];

match ($action) {
    'create_intent'    => createPaymentIntent($body),
    'create_method'    => createPaymentMethod($body),
    'attach_method'    => attachPaymentMethod($body),
    'verify_intent'    => verifyPaymentIntent($body),
    'get_public_key'   => getPublicKey(),
    'webhook_handler'  => handleWebhook(),
    default            => jsonResponse(['success' => false, 'error' => 'Unknown action: ' . $action], 400),
};
function createPaymentIntent(array $data): void {
    $amount = (int)round(($data['amount'] ?? 0) * 100); // PHP → centavos

    if ($amount < 2000) { // ₱20.00 minimum
        jsonResponse(['success' => false, 'error' => 'Minimum transaction amount is ₱20.00'], 422);
    }
    $methods = $data['payment_methods'] ?? ['card', 'gcash', 'paymaya'];

    $payload = [
        'data' => [
            'attributes' => [
                'amount'                 => $amount,
                'payment_method_allowed' => $methods,
                'currency'               => 'PHP',
                'capture_type'           => 'automatic',
                'description'            => sanitize($data['description'] ?? 'EventEntry Ticket Purchase'),
                'metadata'               => array_merge($data['metadata'] ?? [], [
                    'source'    => 'evententry_pos',
                    'timestamp' => date('c'),
                ]),
            ],
        ],
    ];

    $result = paymongoRequest('POST', '/payment_intents', $payload);

    if (isset($result['errors'])) {
        jsonResponse([
            'success' => false,
            'error'   => $result['errors'][0]['detail'] ?? 'Failed to create payment intent',
            'code'    => $result['errors'][0]['code']   ?? 'unknown_error',
        ], 400);
    }

    $intent = $result['data'];
    jsonResponse([
        'success'            => true,
        'payment_intent_id'  => $intent['id'],
        'client_key'         => $intent['attributes']['client_key'],
        'amount'             => $intent['attributes']['amount'],
        'status'             => $intent['attributes']['status'],
        'public_key'         => PAYMONGO_PUBLIC_KEY,  // frontend needs this
    ]);
}

// ── STEP 2: Create Payment Method ───────────────────────────
// For card: send card details.
// For GCash/PayMaya: only billing info needed (no card numbers).
// Send: { type: "gcash", billing_name: "Juan", billing_email: "...", billing_phone: "..." }
// Card: { type: "card", card_number: "...", exp_month: 12, exp_year: 2026, cvc: "123", billing_name: "..." }
function createPaymentMethod(array $data): void {
    $type = $data['type'] ?? 'card';

    if (in_array($type, ['gcash', 'paymaya'])) {
        // E-wallets: no card details needed
        $payload = [
            'data' => [
                'attributes' => [
                    'type'    => $type,
                    'billing' => [
                        'name'  => sanitize($data['billing_name']  ?? 'Guest'),
                        'email' => filter_var($data['billing_email'] ?? '', FILTER_VALIDATE_EMAIL) ?: null,
                        'phone' => sanitize($data['billing_phone'] ?? ''),
                    ],
                ],
            ],
        ];
    } else {
        // Card payment
        $cardNumber = str_replace(' ', '', $data['card_number'] ?? '');
        $expMonth   = (int)($data['exp_month'] ?? 0);
        $expYear    = (int)($data['exp_year']  ?? 0);
        $cvc        = $data['cvc'] ?? '';

        if (strlen($cardNumber) < 13 || $expMonth < 1 || $expMonth > 12 || strlen($cvc) < 3) {
            jsonResponse(['success' => false, 'error' => 'Invalid card details'], 422);
        }

        $payload = [
            'data' => [
                'attributes' => [
                    'type'    => 'card',
                    'details' => [
                        'card_number' => $cardNumber,
                        'exp_month'   => $expMonth,
                        'exp_year'    => $expYear,
                        'cvc'         => $cvc,
                    ],
                    'billing' => [
                        'name'  => sanitize($data['billing_name']  ?? 'Guest'),
                        'email' => filter_var($data['billing_email'] ?? '', FILTER_VALIDATE_EMAIL) ?: null,
                        'phone' => sanitize($data['billing_phone'] ?? ''),
                    ],
                ],
            ],
        ];
    }

    $result = paymongoRequest('POST', '/payment_methods', $payload);

    if (isset($result['errors'])) {
        jsonResponse([
            'success' => false,
            'error'   => $result['errors'][0]['detail'] ?? 'Payment method creation failed',
        ], 400);
    }

    jsonResponse([
        'success'           => true,
        'payment_method_id' => $result['data']['id'],
        'type'              => $result['data']['attributes']['type'],
    ]);
}

// ── STEP 3: Attach Payment Method to Intent ──────────────────
// For GCash/PayMaya: you MUST pass return_url — user will be redirected there after paying.
// Send: { payment_intent_id, payment_method_id, client_key, payment_method_type, return_url }
function attachPaymentMethod(array $data): void {
    $intentId   = $data['payment_intent_id']   ?? '';
    $methodId   = $data['payment_method_id']   ?? '';
    $clientKey  = $data['client_key']           ?? '';
    $methodType = $data['payment_method_type']  ?? 'card';
    $returnUrl  = $data['return_url']           ?? null;

    if (!$intentId || !$methodId || !$clientKey) {
        jsonResponse(['success' => false, 'error' => 'payment_intent_id, payment_method_id, and client_key are required'], 422);
    }

    // GCash and PayMaya REQUIRE a return_url — PayMongo redirects the user here after payment
    if (in_array($methodType, ['gcash', 'paymaya']) && !$returnUrl) {
        jsonResponse([
            'success' => false,
            'error'   => "return_url is required for {$methodType} payments. Example: http://yoursite.com/payment-success.php",
            'code'    => 'return_url_required',
        ], 422);
    }

    $payload = [
        'data' => [
            'attributes' => [
                'payment_method' => $methodId,
                'client_key'     => $clientKey,
            ],
        ],
    ];

    if ($returnUrl) {
        $payload['data']['attributes']['return_url'] = $returnUrl;
    }

    $result = paymongoRequest('POST', "/payment_intents/{$intentId}/attach", $payload);

    if (isset($result['errors'])) {
        jsonResponse([
            'success' => false,
            'error'   => $result['errors'][0]['detail'] ?? 'Failed to attach payment method',
            'code'    => $result['errors'][0]['code']   ?? 'attach_failed',
        ], 400);
    }

    $intent   = $result['data'];
    $status   = $intent['attributes']['status'];
    $response = [
        'success'           => true,
        'status'            => $status,
        'payment_intent_id' => $intent['id'],
    ];

    // E-wallets and 3DS cards need a redirect — return the URL to the frontend
    if ($status === 'awaiting_next_action') {
        $response['requires_action'] = true;
        $response['redirect_url']    = $intent['attributes']['next_action']['redirect']['url'] ?? null;
        $response['instruction']     = 'Redirect the user to redirect_url to complete payment';
    }

    // Card paid immediately (no 3DS)
    if ($status === 'succeeded') {
        $response['payment_success'] = true;
        $response['payment_id']      = $intent['attributes']['payments'][0]['id'] ?? null;
    }

    jsonResponse($response);
}

// ── STEP 4: Verify Payment Intent (server-side check) ────────
// Always verify on the server — never trust the frontend alone.
// Send: { payment_intent_id: "pi_..." }
function verifyPaymentIntent(array $data): void {
    $intentId = $data['payment_intent_id'] ?? '';
    if (!$intentId) {
        jsonResponse(['success' => false, 'error' => 'payment_intent_id required'], 422);
    }

    $result = paymongoRequest('GET', '/payment_intents/' . $intentId);

    if (isset($result['errors'])) {
        jsonResponse(['success' => false, 'error' => 'Failed to verify payment'], 400);
    }

    $intent     = $result['data'];
    $attributes = $intent['attributes'];

    $response = [
        'success'           => true,
        'payment_intent_id' => $intent['id'],
        'status'            => $attributes['status'],   // succeeded | awaiting_payment_method | processing
        'amount'            => $attributes['amount'],   // in centavos
        'currency'          => $attributes['currency'],
        'description'       => $attributes['description'],
        'livemode'          => $attributes['livemode'],
    ];

    if ($attributes['status'] === 'succeeded' && !empty($attributes['payments'])) {
        $payment             = $attributes['payments'][0];
        $response['payment'] = [
            'id'         => $payment['id'],
            'amount'     => $payment['attributes']['amount'],
            'fee'        => $payment['attributes']['fee']        ?? null,
            'net_amount' => $payment['attributes']['net_amount'] ?? null,
            'status'     => $payment['attributes']['status'],
            'paid_at'    => $payment['attributes']['paid_at']    ?? null,
        ];
    }

    jsonResponse($response);
}

// ── Expose Public Key to Frontend ────────────────────────────
// Call GET ?action=get_public_key on page load
function getPublicKey(): void {
    jsonResponse([
        'success'    => true,
        'public_key' => PAYMONGO_PUBLIC_KEY,
        'live_mode'  => PAYMONGO_LIVE_MODE,
    ]);
}

// ── Webhook Handler ──────────────────────────────────────────
// Register this URL in PayMongo Dashboard → Developers → Webhooks
// URL: https://yourdomain.com/api/paymongo.php?action=webhook_handler
function handleWebhook(): void {
    $payload   = file_get_contents('php://input');
    $signature = $_SERVER['HTTP_PAYMONGO_SIGNATURE'] ?? '';

    // Verify signature using your webhook secret from config.php
    if (defined('PAYMONGO_WEBHOOK_SECRET') && PAYMONGO_WEBHOOK_SECRET && $signature) {
        [$timestamp, $testSig, $liveSig] = array_pad(explode(',', $signature), 3, '');
        $ts  = ltrim($timestamp, 't=');
        $computed = hash_hmac('sha256', $ts . '.' . $payload, PAYMONGO_WEBHOOK_SECRET);
        $received = ltrim($testSig ?: $liveSig, 'te=');
        if (!hash_equals($computed, $received)) {
            http_response_code(401);
            exit(json_encode(['error' => 'Invalid signature']));
        }
    }

    $event = json_decode($payload, true);
    if (!$event || !isset($event['data'])) {
        http_response_code(400);
        exit;
    }

    $eventType = $event['data']['attributes']['type'] ?? '';
    $eventData = $event['data']['attributes']['data'] ?? [];

    error_log("PayMongo Webhook received: {$eventType}");

    switch ($eventType) {
        case 'payment.paid':
        case 'payment_intent.payment_completed':
            $transactionId = $eventData['attributes']['metadata']['transaction_id'] ?? null;
            if ($transactionId) {
                // Optionally mark your transaction as confirmed:
                // getDB()->prepare("UPDATE transactions SET notes='paymongo_confirmed' WHERE id=?")->execute([$transactionId]);
            }
            break;

        case 'payment.failed':
        case 'payment_intent.payment_failed':
            // Handle failed payment
            break;

        case 'source.chargeable':
            // Source API (older GCash flow) — source is ready to charge
            break;
    }

    http_response_code(200);
    echo json_encode(['received' => true]);
    exit;
}