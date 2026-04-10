CREATE DATABASE IF NOT EXISTS evententry_db
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE evententry_db;
CREATE TABLE IF NOT EXISTS users (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username    VARCHAR(50)  NOT NULL UNIQUE,
    password    VARCHAR(255) NOT NULL,          -- bcrypt hash
    full_name   VARCHAR(100) NOT NULL,
    email       VARCHAR(150) UNIQUE,
    role        ENUM('admin','staff') NOT NULL DEFAULT 'staff',
    is_active   TINYINT(1)   NOT NULL DEFAULT 1,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_users_role (role),
    INDEX idx_users_active (is_active)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS events (
    id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name          VARCHAR(150) NOT NULL,
    description   TEXT,
    venue         VARCHAR(200) NOT NULL,
    event_date    DATE         NOT NULL,
    event_time    TIME,
    capacity      INT UNSIGNED NOT NULL DEFAULT 100,
    status        ENUM('active','upcoming','closed','cancelled') NOT NULL DEFAULT 'upcoming',
    color         VARCHAR(7)   NOT NULL DEFAULT '#8b5cf6',  -- hex color
    created_by    INT UNSIGNED NOT NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_events_status (status),
    INDEX idx_events_date   (event_date)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS ticket_types (
    id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    event_id     INT UNSIGNED NOT NULL,
    name         VARCHAR(80)     NOT NULL,
    description  VARCHAR(255),
    price        DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
    total_qty    INT UNSIGNED    NOT NULL DEFAULT 0,
    sold_qty     INT UNSIGNED    NOT NULL DEFAULT 0,
    color        VARCHAR(7)      NOT NULL DEFAULT '#8b5cf6',
    is_active    TINYINT(1)      NOT NULL DEFAULT 1,
    created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    CONSTRAINT chk_sold_qty CHECK (sold_qty <= total_qty),
    INDEX idx_tt_event  (event_id),
    INDEX idx_tt_active (is_active)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS coupons (
    id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    code            VARCHAR(30)  NOT NULL UNIQUE,
    discount_type   ENUM('percent','fixed') NOT NULL,
    discount_value  DECIMAL(10,2) NOT NULL,
    max_uses        INT UNSIGNED  NOT NULL DEFAULT 100,
    used_count      INT UNSIGNED  NOT NULL DEFAULT 0,
    event_id        INT UNSIGNED  NULL,           -- NULL = applies to all events
    is_active       TINYINT(1)    NOT NULL DEFAULT 1,
    expires_at      DATETIME      NULL,
    created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL,
    INDEX idx_coupon_code   (code),
    INDEX idx_coupon_active (is_active)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS transactions (
    id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    receipt_no      VARCHAR(20)   NOT NULL UNIQUE,
    event_id        INT UNSIGNED  NOT NULL,
    buyer_name      VARCHAR(100),
    buyer_email     VARCHAR(150),
    buyer_phone     VARCHAR(20),
    payment_method  ENUM('cash','card','ewallet','gcash') NOT NULL,
    subtotal        DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    total_amount    DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    coupon_id       INT UNSIGNED  NULL,
    staff_id        INT UNSIGNED  NOT NULL,
    notes           TEXT,
    created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id)  REFERENCES events(id)       ON DELETE RESTRICT,
    FOREIGN KEY (coupon_id) REFERENCES coupons(id)      ON DELETE SET NULL,
    FOREIGN KEY (staff_id)  REFERENCES users(id)        ON DELETE RESTRICT,
    INDEX idx_tx_event      (event_id),
    INDEX idx_tx_staff      (staff_id),
    INDEX idx_tx_created    (created_at),
    INDEX idx_tx_payment    (payment_method)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS transaction_items (
    id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    transaction_id   INT UNSIGNED  NOT NULL,
    ticket_type_id   INT UNSIGNED  NOT NULL,
    quantity         INT UNSIGNED  NOT NULL DEFAULT 1,
    unit_price       DECIMAL(10,2) NOT NULL,
    total_price      DECIMAL(10,2) NOT NULL,
    created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transaction_id) REFERENCES transactions(id)   ON DELETE CASCADE,
    FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(id)   ON DELETE RESTRICT,
    INDEX idx_ti_transaction (transaction_id),
    INDEX idx_ti_ticket_type (ticket_type_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS tickets (
    id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    ticket_code         VARCHAR(20)  NOT NULL UNIQUE,
    transaction_item_id INT UNSIGNED NOT NULL,
    event_id            INT UNSIGNED NOT NULL,
    ticket_type_id      INT UNSIGNED NOT NULL,
    buyer_name          VARCHAR(100),
    status              ENUM('pending','checked_in','cancelled') NOT NULL DEFAULT 'pending',
    checked_in_at       DATETIME     NULL,
    checked_in_by       INT UNSIGNED NULL,        -- FK to users (staff who scanned)
    created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transaction_item_id) REFERENCES transaction_items(id) ON DELETE CASCADE,
    FOREIGN KEY (event_id)            REFERENCES events(id)            ON DELETE RESTRICT,
    FOREIGN KEY (ticket_type_id)      REFERENCES ticket_types(id)      ON DELETE RESTRICT,
    FOREIGN KEY (checked_in_by)       REFERENCES users(id)             ON DELETE SET NULL,
    INDEX idx_ticket_code     (ticket_code),
    INDEX idx_ticket_event    (event_id),
    INDEX idx_ticket_status   (status),
    INDEX idx_ticket_type     (ticket_type_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS check_in_logs (
    id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    ticket_code   VARCHAR(20)  NOT NULL,
    ticket_id     INT UNSIGNED NULL,              -- NULL if code not found
    event_id      INT UNSIGNED NULL,
    scanned_by    INT UNSIGNED NOT NULL,
    result        ENUM('valid','already_used','invalid','wrong_event') NOT NULL,
    scanned_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_id)   REFERENCES tickets(id) ON DELETE SET NULL,
    FOREIGN KEY (event_id)    REFERENCES events(id)  ON DELETE SET NULL,
    FOREIGN KEY (scanned_by)  REFERENCES users(id)   ON DELETE RESTRICT,
    INDEX idx_log_code      (ticket_code),
    INDEX idx_log_event     (event_id),
    INDEX idx_log_scanned   (scanned_at),
    INDEX idx_log_result    (result)
) ENGINE=InnoDB;
INSERT INTO users (username, password, full_name, email, role) VALUES
('admin', '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'System Administrator', 'admin@evententry.com', 'admin'),
('staff', '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Staff Member',         'staff@evententry.com', 'staff');
INSERT INTO events (name, description, venue, event_date, event_time, capacity, status, color, created_by) VALUES
('Summer Music Festival', 'Annual outdoor music event featuring top local artists', 'SM Mall of Asia Grounds', '2024-08-15', '16:00:00', 500, 'active',   '#8b5cf6', 1),
('Tech Summit 2024',      'Technology and innovation conference for developers',      'PICC Forum, Pasay',        '2024-09-20', '09:00:00', 300, 'upcoming', '#3b82f6', 1);
INSERT INTO ticket_types (event_id, name, description, price, total_qty, sold_qty, color) VALUES
(1, 'VIP',        'Front row + backstage access + free merch',  2500.00, 50,  8,   '#8b5cf6'),
(1, 'Regular',    'General admission standing area',              800.00, 300, 45,  '#3b82f6'),
(1, 'Early Bird', 'Limited discounted early access',              500.00, 100, 100, '#10b981'),
(2, 'Standard',   'Full conference access all 2 days',           1500.00, 200, 12,  '#f59e0b'),
(2, 'Premium',    'Access + workshop + lunch + certificate',     3000.00, 50,  4,   '#ec4899');

-- ============================================================
--  SEED DATA — Coupons
-- ============================================================
INSERT INTO coupons (code, discount_type, discount_value, max_uses, event_id, is_active) VALUES
('SUMMER10', 'percent', 10,  200, NULL, 1),
('FLAT100',  'fixed',   100, 50,  NULL, 1),
('VIP500',   'fixed',   500, 20,  1,    1);s
CREATE OR REPLACE VIEW vw_event_summary AS
SELECT
    e.id,
    e.name,
    e.venue,
    e.event_date,
    e.status,
    e.capacity,
    COALESCE(SUM(tt.sold_qty), 0)                           AS total_sold,
    ROUND(COALESCE(SUM(tt.sold_qty), 0) / e.capacity * 100, 1) AS fill_rate_pct,
    COUNT(DISTINCT tx.id)                                   AS total_transactions,
    COALESCE(SUM(tx.total_amount), 0)                       AS total_revenue,
    COUNT(DISTINCT CASE WHEN t.status = 'checked_in' THEN t.id END) AS checked_in_count
FROM events e
LEFT JOIN ticket_types tt  ON tt.event_id = e.id
LEFT JOIN transactions tx  ON tx.event_id = e.id
LEFT JOIN tickets t        ON t.event_id  = e.id
GROUP BY e.id, e.name, e.venue, e.event_date, e.status, e.capacity;

-- Ticket sales by type view
CREATE OR REPLACE VIEW vw_ticket_type_sales AS
SELECT
    tt.id,
    tt.event_id,
    e.name       AS event_name,
    tt.name      AS type_name,
    tt.price,
    tt.total_qty,
    tt.sold_qty,
    tt.total_qty - tt.sold_qty          AS available_qty,
    tt.price * tt.sold_qty              AS revenue,
    ROUND(tt.sold_qty / tt.total_qty * 100, 1) AS sell_through_pct
FROM ticket_types tt
JOIN events e ON e.id = tt.event_id;

-- Full attendee list view
CREATE OR REPLACE VIEW vw_attendees AS
SELECT
    tk.ticket_code,
    tk.buyer_name,
    tx.buyer_email,
    tx.buyer_phone,
    tt.name          AS ticket_type,
    tt.price         AS ticket_price,
    tx.payment_method,
    tx.receipt_no,
    tk.status,
    tk.checked_in_at,
    u2.full_name     AS checked_in_by,
    e.name           AS event_name,
    tx.created_at    AS sold_at,
    u1.full_name     AS sold_by
FROM tickets tk
JOIN transaction_items ti ON ti.id = tk.transaction_item_id
JOIN transactions tx      ON tx.id = ti.transaction_id
JOIN ticket_types tt      ON tt.id = tk.ticket_type_id
JOIN events e             ON e.id  = tk.event_id
JOIN users u1             ON u1.id = tx.staff_id
LEFT JOIN users u2        ON u2.id = tk.checked_in_by;
