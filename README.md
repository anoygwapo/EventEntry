# EventEntry POS System — Setup Guide

## Requirements
- PHP 8.0+ (with PDO + PDO_MySQL extensions)
- MySQL 8.0+ or MariaDB 10.5+
- MySQL Workbench (for DB setup)
- XAMPP / WAMP / Laragon (local dev)

---

## Step 1 — Database Setup in MySQL Workbench

1. Open **MySQL Workbench**
2. Connect to your local server (default: root / no password)
3. Open `sql/schema.sql` in the Query Editor
4. Click ▶ **Execute All** (Ctrl+Shift+Enter)
5. The database `evententry_db` is created with all tables, views, and seed data

### Tables Created:
| Table              | Description                              |
|--------------------|------------------------------------------|
| `users`            | Admin and staff accounts (bcrypt hashed) |
| `events`           | Event records                            |
| `ticket_types`     | Ticket categories per event              |
| `coupons`          | Discount codes (% or fixed)              |
| `transactions`     | Sales receipts                           |
| `transaction_items`| Line items per sale                      |
| `tickets`          | Individual entry tickets with QR codes   |
| `check_in_logs`    | Full audit log of every scan attempt     |

### Views Created:
| View                  | Description                    |
|-----------------------|--------------------------------|
| `vw_event_summary`    | Revenue, fill rate per event   |
| `vw_ticket_type_sales`| Sell-through per ticket type   |
| `vw_attendees`        | Full attendee roster with joins |

---

## Step 2 — Configure Database Connection

Open `includes/config.php` and edit:

```php
define('DB_HOST', 'localhost');
define('DB_NAME', 'evententry_db');
define('DB_USER', 'root');      // your MySQL username
define('DB_PASS', '');          // your MySQL password
```

---

## Step 3 — Run the App

### Using XAMPP:
1. Copy the entire `evententry/` folder to `C:/xampp/htdocs/`
2. Start **Apache** and **MySQL** in the XAMPP Control Panel
3. Visit: `http://localhost/evententry/`

### Using Laragon:
1. Drop the folder into `C:/laragon/www/`
2. Visit: `http://evententry.test/`

---

## Login Credentials (Demo)

| Role  | Username | Password |
|-------|----------|----------|
| Admin | admin    | password |
| Staff | staff    | password |

> To change passwords, run in MySQL Workbench:
> ```sql
> UPDATE users SET password = '$2y$10$...' WHERE username = 'admin';
> ```
> Generate a bcrypt hash at: https://bcrypt-generator.com/

---

## Project Structure

```
evententry/
├── index.html              ← Single-page app (HTML)
├── style.css               ← All styles
├── app.js                  ← Frontend logic (JS)
├── includes/
│   └── config.php          ← DB connection + helpers
├── api/
│   ├── auth.php            ← Login / logout / session
│   ├── events.php          ← Event CRUD
│   ├── ticket_types.php    ← Ticket type CRUD
│   ├── transactions.php    ← Checkout + coupon validation
│   ├── scanner.php         ← QR scan + check-in
│   └── reports.php         ← Analytics & attendee data
└── sql/
    └── schema.sql          ← Full MySQL schema + seed data
```

---

## Demo Coupons

| Code      | Type    | Value | Valid For |
|-----------|---------|-------|-----------|
| SUMMER10  | Percent | 10%   | All events|
| FLAT100   | Fixed   | ₱100  | All events|
| VIP500    | Fixed   | ₱500  | Event 1   |
