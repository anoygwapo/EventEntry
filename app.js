/* =============================================================
   EVENTENTRY POS SYSTEM — Frontend Application
   All data operations call PHP API endpoints backed by MySQL
   =============================================================*/

/* ── API helper ─────────────────────────────────────────────── */
const API = {
    async call(endpoint, params = {}, body = null) {
        const url = new URL(`api/${endpoint}`, location.href);
        Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
        const opts = { headers: { 'Content-Type': 'application/json' } };
        if (body !== null) { opts.method = 'POST'; opts.body = JSON.stringify(body); }
        try {
            const res  = await fetch(url, opts);
            const data = await res.json();
            return data;
        } catch (e) {
            console.error('API Error:', e);
            return { success: false, error: 'Network error' };
        }
    },
    get:  (ep, params)        => API.call(ep, params),
    post: (ep, params, body)  => API.call(ep, params, body),
};

/* ── App State ───────────────────────────────────────────────── */
const state = {
    user: null, role: null, currentEvent: null,
    events: [], cart: [], appliedCoupon: null,
    scanCounts: { valid: 0, used: 0, invalid: 0 },
    scanLock: false, cameraRunning: false, html5QrCode: null,
    charts: {}, selectedEvColor: '#8b5cf6', selectedTTColor: '#8b5cf6',
    activityLog: [],
};

/* ── Init ────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
    // Check if already logged in
    // Handle GCash/Maya redirect return FIRST (before auth check)
    const paymentCompleted = await handlePayMongoReturn();
    if (paymentCompleted) {
        console.log('Payment return handled');
    }

    const r = await API.get('auth.php', { action: 'check' });
    if (r.success) { state.user = r; postLogin(r.role, r.full_name); return; }
    showPage('page-landing');

    // Payment method UI handled by onPayMethodChange()
    // POS clock
    setInterval(() => {
        const el = document.getElementById('pos-clock');
        if (el) el.textContent = new Date().toLocaleTimeString();
    }, 1000);
});

/* ── Navigation ─────────────────────────────────────────────── */
function showPage(id) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}
function showLanding() { showPage('page-landing'); }
function showLogin(role) {
    state.role = role;
    const isAdmin = role === 'admin';
    document.getElementById('login-title').textContent    = isAdmin ? 'Admin Login' : 'Staff Login';
    document.getElementById('login-subtitle').textContent = isAdmin ? 'Access the management dashboard' : 'Access the staff panel';
    document.getElementById('login-hint-text').textContent = isAdmin ? 'admin / password' : 'staff / password';
    document.getElementById('login-icon').innerHTML = `<i class="fas fa-${isAdmin ? 'shield-alt' : 'id-badge'}"></i>`;
    showPage('page-login');
}
function togglePassword() {
    const inp = document.getElementById('password');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    document.getElementById('eye-icon').className = inp.type === 'password' ? 'fas fa-eye' : 'fas fa-eye-slash';
}
function goBack() {
    stopCamera();
    showPage(state.role === 'admin' ? 'page-admin' : 'page-staff');
    if (state.role === 'admin') setAdminNav('nav-dashboard');
}

/* ── Auth ────────────────────────────────────────────────────── */
async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const r = await API.post('auth.php', { action: 'login' }, { username, password });
    if (!r.success) { showToast(r.error || 'Invalid credentials', 'error'); return; }
    state.user = r;
    postLogin(r.role, r.full_name);
}

function postLogin(role, fullName) {
    state.role = role;
    if (role === 'admin') {
        document.getElementById('admin-name').textContent = fullName || 'Admin';
        showPage('page-admin');
        initAdminDashboard();
    } else {
        document.getElementById('staff-name').textContent = fullName || 'Staff';
        showPage('page-staff');
        initStaffDashboard();
    }
}

async function logout() {
    stopCamera();
    await API.post('auth.php', { action: 'logout' }, {});
    state.user = null; state.role = null; state.currentEvent = null; state.cart = [];
    showLanding();
}

/* ── Admin Dashboard ─────────────────────────────────────────── */
async function initAdminDashboard() {
    setAdminNav('nav-dashboard');
    showAdminSection('dashboard');
    await loadEvents();
    if (state.events.length > 0) selectEvent(state.events[0]);
    else {
        document.getElementById('empty-dashboard').classList.remove('hidden');
        document.getElementById('dashboard-content').classList.add('hidden');
    }
}

async function loadEvents() {
    const r = await API.get('events.php', { action: 'list' });
    state.events = r.success ? r.data : [];
    renderAllEventTabs();
    return state.events;
}

function renderAllEventTabs() {
    ['event-tabs','pos-event-tabs','scanner-event-tabs','attendee-event-tabs'].forEach(id => renderEventTabs(id));
    // Reports select
    const sel = document.getElementById('rpt-event-sel');
    if (sel) {
        sel.innerHTML = state.events.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
        if (state.currentEvent) sel.value = state.currentEvent.id;
    }
}

function renderEventTabs(containerId) {
    const c = document.getElementById(containerId);
    if (!c) return;
    const noHint = document.getElementById('no-events-hint');
    if (state.events.length === 0) {
        c.innerHTML = '';
        if (noHint) noHint.classList.remove('hidden');
        return;
    }
    if (noHint) noHint.classList.add('hidden');
    c.innerHTML = state.events.map(ev => `
        <button class="event-tab ${state.currentEvent?.id == ev.id ? 'active' : ''}"
                onclick="onEventTabClick('${containerId}', ${ev.id})"
                style="border-left: 3px solid ${ev.color}">
            ${ev.name}
        </button>`).join('');
}

function onEventTabClick(containerId, evId) {
    const ev = state.events.find(e => e.id == evId);
    if (!ev) return;
    state.currentEvent = ev;
    renderAllEventTabs();
    if (containerId === 'event-tabs')          selectEvent(ev);
    else if (containerId === 'pos-event-tabs') loadPOSTickets();
    else if (containerId === 'attendee-event-tabs') renderAttendeesTable();
}

async function selectEvent(ev) {
    state.currentEvent = ev;
    renderAllEventTabs();
    document.getElementById('selected-event-label').textContent = `📅 ${ev.name} — ${ev.venue}`;
    document.getElementById('empty-dashboard').classList.add('hidden');
    document.getElementById('dashboard-content').classList.remove('hidden');
    await Promise.all([renderDashboardStats(), renderTicketTypesList(), renderRecentTransactions(), renderDashboardCharts()]);
}

async function renderDashboardStats() {
    if (!state.currentEvent) return;
    const r = await API.get('reports.php', { action: 'dashboard', event_id: state.currentEvent.id });
    if (!r.success) return;
    const d = r.data;
    document.getElementById('stats-grid').innerHTML = `
        ${statCard('Total Revenue',     '₱' + parseFloat(d.total_revenue||0).toLocaleString(), 'fas fa-peso-sign', 'si-violet', d.total_transactions + ' transactions','neutral')}
        ${statCard('Tickets Sold',       d.total_sold + ' / ' + d.total_capacity,                'fas fa-ticket-alt','si-blue',   Math.round((d.total_sold/Math.max(d.total_capacity,1))*100)+'% full','neutral')}
        ${statCard('Checked In',         d.checked_in,                                           'fas fa-door-open', 'si-emerald',Math.round((d.checked_in/Math.max(d.total_sold,1))*100)+'% rate','up')}
        ${statCard('Today\'s Revenue',  '₱' + parseFloat(d.today_revenue||0).toLocaleString(),  'fas fa-chart-line','si-amber',  'as of today','neutral')}
    `;
}

function statCard(label, val, icon, cls, sub, badge) {
    return `<div class="stat-card">
        <div class="stat-card-top">
            <span class="stat-label">${label}</span>
            <div class="stat-icon ${cls}"><i class="${icon}"></i></div>
        </div>
        <div class="stat-val">${val}</div>
        <div class="stat-sub"><span class="stat-badge ${badge}">${sub}</span></div>
    </div>`;
}

async function renderTicketTypesList() {
    if (!state.currentEvent) return;
    const r = await API.get('ticket_types.php', { action: 'list', event_id: state.currentEvent.id });
    const list = document.getElementById('ticket-types-list');
    if (!list || !r.success || !r.data.length) { if (list) list.innerHTML = '<p style="color:var(--text-dim);font-size:.85rem">No ticket types yet</p>'; return; }
    list.innerHTML = r.data.map(t => {
        const pct = parseFloat(t.sell_through_pct) || 0;
        return `<div class="tt-item">
            <div class="tt-item-left">
                <div class="tt-color-dot" style="background:${t.color}"></div>
                <div><div class="tt-info-name">${t.name}</div><div class="tt-info-meta">${t.description || '—'} · ${t.available_qty} remaining</div></div>
            </div>
            <div class="tt-item-right">
                <div class="tt-price">₱${parseFloat(t.price).toLocaleString()}</div>
                <div class="tt-avail">${t.sold_qty}/${t.total_qty} sold</div>
                <div class="tt-progress"><div class="tt-progress-fill" style="width:${pct}%"></div></div>
            </div>
        </div>`;
    }).join('');
}

async function renderRecentTransactions() {
    if (!state.currentEvent) return;
    const r = await API.get('transactions.php', { action: 'list', event_id: state.currentEvent.id });
    const list = document.getElementById('recent-tx-list');
    if (!list) return;
    const txs = (r.data || []).slice(0, 6);
    if (!txs.length) { list.innerHTML = '<p style="color:var(--text-dim);font-size:.85rem">No transactions yet</p>'; return; }
    list.innerHTML = txs.map(tx => `
        <div class="tx-item">
            <div class="tx-item-left">
                <div class="tx-dot"></div>
                <div><div class="tx-name">${tx.buyer_name || 'Walk-in'}</div><div class="tx-meta">${tx.receipt_no} · ${tx.payment_method}</div></div>
            </div>
            <div style="text-align:right">
                <div class="tx-amt">₱${parseFloat(tx.total_amount).toLocaleString()}</div>
                <div class="tx-time">${timeAgo(tx.created_at)}</div>
            </div>
        </div>`).join('');
}

async function renderDashboardCharts() {
    if (!state.currentEvent) return;
    destroyChart('salesChart'); destroyChart('checkinChart');
    const [salesR, ciR] = await Promise.all([
        API.get('reports.php', { action: 'sales_trend', event_id: state.currentEvent.id, range: 'month' }),
        API.get('reports.php', { action: 'checkins',    event_id: state.currentEvent.id }),
    ]);

    // Build 14-day labels
    const labels = [], salesMap = {}, ciMap = {};
    for (let i = 13; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        labels.push(d.toLocaleDateString('en',{month:'short',day:'numeric'}));
        const key = d.toISOString().split('T')[0];
        salesMap[key] = 0; ciMap[key] = 0;
    }
    (salesR.data || []).forEach(r => { salesMap[r.sale_date] = parseFloat(r.revenue); });
    (ciR.data || []).forEach(r => { const k = r.checkin_date; if (ciMap[k] !== undefined) ciMap[k] += parseInt(r.count); });

    const salesData  = labels.map((_, i) => { const d = new Date(); d.setDate(d.getDate() - (13 - i)); return salesMap[d.toISOString().split('T')[0]] || 0; });
    const ciData     = labels.map((_, i) => { const d = new Date(); d.setDate(d.getDate() - (13 - i)); return ciMap[d.toISOString().split('T')[0]] || 0; });

    const baseOpts = { responsive: true, plugins: { legend: { display: false } }, scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#7a7a9a', font: { size: 11 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#7a7a9a', font: { size: 11 } } }
    }};

    state.charts['salesChart'] = new Chart(document.getElementById('salesChart').getContext('2d'), {
        type: 'line',
        data: { labels, datasets: [{ data: salesData, borderColor: '#8b5cf6', backgroundColor: 'rgba(139,92,246,0.08)', tension: 0.4, fill: true, pointRadius: 4, pointBackgroundColor: '#8b5cf6' }] },
        options: { ...baseOpts }
    });
    state.charts['checkinChart'] = new Chart(document.getElementById('checkinChart').getContext('2d'), {
        type: 'bar',
        data: { labels, datasets: [{ data: ciData, backgroundColor: 'rgba(20,184,166,0.5)', borderColor: '#14b8a6', borderRadius: 6 }] },
        options: { ...baseOpts }
    });
}

function destroyChart(id) {
    if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
}

/* ── Admin Section Routing ───────────────────────────────────── */
function showAdminSection(sec) {
    document.querySelectorAll('.admin-section').forEach(s => s.classList.add('hidden'));
    document.getElementById('sec-' + sec)?.classList.remove('hidden');
}
function setAdminNav(navId) {
    document.querySelectorAll('#admin-sidebar .nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById(navId)?.classList.add('active');
}

/* ── Event Modal ─────────────────────────────────────────────── */
function openEventModal() {
    ['ev-name','ev-desc','ev-venue','ev-date','ev-time','ev-cap'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    openModal('event-modal');
}
async function handleCreateEvent(e) {
    e.preventDefault();
    const r = await API.post('events.php', { action: 'create' }, {
        name: document.getElementById('ev-name').value,
        description: document.getElementById('ev-desc').value,
        venue: document.getElementById('ev-venue').value,
        event_date: document.getElementById('ev-date').value,
        event_time: document.getElementById('ev-time').value,
        capacity: document.getElementById('ev-cap').value,
        status: document.getElementById('ev-status').value,
        color: state.selectedEvColor,
    });
    if (!r.success) { showToast(r.error || 'Failed to create event', 'error'); return; }
    showToast('Event created!', 'success');
    closeModal('event-modal');
    await loadEvents();
    const newEv = state.events.find(ev => ev.id == r.id);
    if (newEv) selectEvent(newEv);
}
function selectSwatch(el) {
    document.querySelectorAll('#ev-color-swatches .swatch').forEach(s => s.classList.remove('active'));
    el.classList.add('active'); state.selectedEvColor = el.dataset.color;
}
function selectTTSwatch(el) {
    document.querySelectorAll('#tt-color-swatches .swatch').forEach(s => s.classList.remove('active'));
    el.classList.add('active'); state.selectedTTColor = el.dataset.color;
}

/* ── Ticket Type Modal ───────────────────────────────────────── */
function openTicketTypeModal() {
    if (!state.currentEvent) { showToast('Select an event first', 'warning'); return; }
    ['tt-name','tt-price','tt-qty','tt-desc'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    openModal('ticket-type-modal');
}
async function handleCreateTicketType(e) {
    e.preventDefault();
    const r = await API.post('ticket_types.php', { action: 'create' }, {
        event_id: state.currentEvent.id,
        name: document.getElementById('tt-name').value,
        description: document.getElementById('tt-desc').value,
        price: document.getElementById('tt-price').value,
        total_qty: document.getElementById('tt-qty').value,
        color: state.selectedTTColor,
    });
    if (!r.success) { showToast(r.error || 'Failed', 'error'); return; }
    showToast('Ticket type added!', 'success');
    closeModal('ticket-type-modal');
    renderTicketTypesList();
    loadPOSTickets();
}

/* ── POS ─────────────────────────────────────────────────────── */
async function showPOS() {
    showPage('page-pos');
    setAdminNav('nav-pos');
    document.getElementById('pos-staff-name').textContent = state.user?.full_name || 'Staff';
    await loadEvents();
    if (state.currentEvent) loadPOSTickets();
}

async function loadPOSTickets() {
    if (!state.currentEvent) {
        document.getElementById('pos-ticket-grid').innerHTML = '<div class="grid-empty"><i class="fas fa-calendar-check"></i><p>Select an event above</p></div>';
        return;
    }
    const r = await API.get('ticket_types.php', { action: 'list', event_id: state.currentEvent.id });
    renderPOSTickets(r.success ? r.data : []);
}

let allPOSTickets = [];
function renderPOSTickets(tts) {
    allPOSTickets = tts;
    const grid = document.getElementById('pos-ticket-grid');
    if (!tts.length) { grid.innerHTML = '<div class="grid-empty"><i class="fas fa-ticket-alt"></i><p>No ticket types. Add some in the dashboard.</p></div>'; return; }
    grid.innerHTML = tts.map(t => {
        const avail = parseInt(t.available_qty) || 0;
        const isOut = avail <= 0;
        const isLow = avail > 0 && avail <= 10;
        return `<div class="tk-card ${isOut ? 'out-of-stock' : ''}" onclick="addToCart(${t.id})">
            <div style="position:absolute;top:0;left:0;right:0;height:3px;background:${t.color};border-radius:3px 3px 0 0"></div>
            <div class="tk-card-top">
                <div><div class="tk-name">${t.name}</div><div class="tk-desc">${t.description||''}</div></div>
                <span class="tk-avail-badge ${isOut?'out':isLow?'low':''}">${isOut?'Sold Out':isLow?'Only '+avail:avail+' left'}</span>
            </div>
            <div class="tk-card-bot">
                <span class="tk-price">₱${parseFloat(t.price).toLocaleString()}</span>
                <button class="add-btn" ${isOut?'disabled':''} title="Add"><i class="fas fa-plus"></i></button>
            </div>
        </div>`;
    }).join('');
}

function filterPOSTickets() {
    const q = document.getElementById('pos-search').value.toLowerCase();
    renderPOSTickets(q ? allPOSTickets.filter(t => t.name.toLowerCase().includes(q) || (t.description||'').toLowerCase().includes(q)) : allPOSTickets);
}

function addToCart(ttId) {
    const tt = allPOSTickets.find(t => t.id == ttId);
    if (!tt) return;
    const avail = parseInt(tt.available_qty) || 0;
    const inCart = state.cart.filter(c => c.ticket_type_id == ttId).reduce((s, c) => s + c.qty, 0);
    if (inCart >= avail) { showToast('No more available', 'warning'); return; }
    const existing = state.cart.find(c => c.ticket_type_id == ttId);
    if (existing) existing.qty++;
    else state.cart.push({ ticket_type_id: ttId, name: tt.name, price: parseFloat(tt.price), qty: 1, color: tt.color });
    renderCart();
    showToast(tt.name + ' added', 'success');
}

function removeFromCart(ttId) {
    state.cart = state.cart.filter(c => c.ticket_type_id != ttId);
    if (!state.cart.length) state.appliedCoupon = null;
    renderCart();
}
function changeQty(ttId, delta) {
    const item = state.cart.find(c => c.ticket_type_id == ttId);
    if (!item) return;
    item.qty += delta;
    if (item.qty <= 0) removeFromCart(ttId);
    else renderCart();
}

function renderCart() {
    const container = document.getElementById('cart-items');
    const footer    = document.getElementById('cart-footer');
    const totalQty  = state.cart.reduce((s, c) => s + c.qty, 0);
    document.getElementById('cart-count').textContent = totalQty;
    if (!state.cart.length) {
        container.innerHTML = '<div class="empty-cart"><i class="fas fa-shopping-basket"></i><p>Cart is empty</p><span>Add tickets to begin</span></div>';
        footer.style.display = 'none'; return;
    }
    footer.style.display = 'block';
    container.innerHTML = state.cart.map(item => `
        <div class="cart-item">
            <div class="ci-top">
                <div><div class="ci-name" style="color:${item.color}">${item.name}</div><div class="ci-unit">₱${item.price.toLocaleString()} each</div></div>
                <button class="ci-remove" onclick="removeFromCart(${item.ticket_type_id})"><i class="fas fa-times"></i></button>
            </div>
            <div class="ci-bot">
                <div class="qty-ctrl">
                    <button class="qty-btn" onclick="changeQty(${item.ticket_type_id},-1)"><i class="fas fa-minus"></i></button>
                    <span class="qty-num">${item.qty}</span>
                    <button class="qty-btn" onclick="changeQty(${item.ticket_type_id},1)"><i class="fas fa-plus"></i></button>
                </div>
                <span class="ci-total">₱${(item.price * item.qty).toLocaleString()}</span>
            </div>
        </div>`).join('');
    updateCartTotals();
}

function updateCartTotals() {
    const sub  = state.cart.reduce((s, c) => s + c.price * c.qty, 0);
    let   disc = 0;
    if (state.appliedCoupon) {
        disc = state.appliedCoupon.discount_type === 'percent'
            ? Math.round(sub * state.appliedCoupon.discount_value / 100)
            : Math.min(parseFloat(state.appliedCoupon.discount_value), sub);
    }
    const total = sub - disc;
    document.getElementById('cart-subtotal').textContent = '₱' + sub.toLocaleString();
    document.getElementById('cart-total').textContent    = '₱' + total.toLocaleString();
    const row = document.getElementById('discount-row');
    row.style.display = disc > 0 ? 'flex' : 'none';
    if (disc > 0) document.getElementById('cart-discount-amt').textContent = '-₱' + disc.toLocaleString();
}

async function applyCoupon() {
    const code = document.getElementById('coupon-code').value.trim().toUpperCase();
    if (!code) return;
    const r = await API.post('transactions.php', { action: 'validate_coupon' }, { code, event_id: state.currentEvent?.id });
    if (!r.success) { showToast(r.error || 'Invalid coupon', 'error'); return; }
    state.appliedCoupon = r.data;
    showToast('Coupon applied: ' + r.data.discount_value + (r.data.discount_type === 'percent' ? '% off' : '₱ off'), 'success');
    updateCartTotals();
}

/* ── Checkout ─────────────────────────────────────────────────── */
function openCheckoutModal() {
    if (!state.cart.length) return;
    const sub  = state.cart.reduce((s, c) => s + c.price * c.qty, 0);
    let   disc = 0;
    if (state.appliedCoupon) {
        disc = state.appliedCoupon.discount_type === 'percent'
            ? Math.round(sub * state.appliedCoupon.discount_value / 100)
            : Math.min(parseFloat(state.appliedCoupon.discount_value), sub);
    }
    const total = sub - disc;
    document.getElementById('checkout-items-list').innerHTML = state.cart.map(item =>
        `<div class="co-item"><div><div class="co-item-name">${item.name}</div><div class="co-item-qty">×${item.qty}</div></div><span>₱${(item.price*item.qty).toLocaleString()}</span></div>`
    ).join('');
    document.getElementById('co-subtotal').textContent = '₱' + sub.toLocaleString();
    document.getElementById('co-total').textContent    = '₱' + total.toLocaleString();
    const dr = document.getElementById('co-discount-row');
    dr.style.display = disc > 0 ? 'flex' : 'none';
    if (disc > 0) document.getElementById('co-discount').textContent = '-₱' + disc.toLocaleString();
    ['buyer-name','buyer-email','buyer-phone','cash-tendered','card-number','card-expiry','card-cvc','card-name'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('change-amount').textContent = '₱0.00';
    document.getElementById('cash-change-calc').classList.remove('hidden');
    document.getElementById('paymongo-card-fields').classList.add('hidden');
    document.getElementById('paymongo-redirect-notice').classList.add('hidden');
    document.querySelector('input[name="pay-method"][value="cash"]').checked = true;
    openModal('checkout-modal');
}

function calcChange() {
    const sub  = state.cart.reduce((s, c) => s + c.price * c.qty, 0);
    let   disc = 0;
    if (state.appliedCoupon) {
        disc = state.appliedCoupon.discount_type === 'percent'
            ? Math.round(sub * state.appliedCoupon.discount_value / 100)
            : Math.min(parseFloat(state.appliedCoupon.discount_value), sub);
    }
    const total    = sub - disc;
    const tendered = parseFloat(document.getElementById('cash-tendered').value) || 0;
    const change   = tendered - total;
    const el = document.getElementById('change-amount');
    el.textContent = '₱' + Math.max(0, change).toFixed(2);
    el.style.color = change >= 0 ? 'var(--emerald)' : 'var(--red)';
}

/* ── Payment method UI toggle ────────────────────────────────── */
function onPayMethodChange(method) {
    const isCard     = method === 'card';
    const isDigital  = method === 'gcash' || method === 'paymaya';
    const isCash     = method === 'cash';
    document.getElementById('cash-change-calc').classList.toggle('hidden', !isCash);
    document.getElementById('paymongo-card-fields').classList.toggle('hidden', !isCard);
    document.getElementById('paymongo-redirect-notice').classList.toggle('hidden', !isDigital);
}

function formatCardNumber(el) {
    let v = el.value.replace(/\D/g, '').slice(0, 16);
    el.value = v.replace(/(\d{4})/g, '$1 ').trim();
}
function formatExpiry(el) {
    let v = el.value.replace(/\D/g, '').slice(0, 4);
    if (v.length >= 3) v = v.slice(0,2) + ' / ' + v.slice(2);
    el.value = v;
}

/* ── Checkout (cash path OR PayMongo path) ──────────────────── */
async function handleCheckout(e) {
    e.preventDefault();
    if (!state.currentEvent) { showToast('No event selected', 'error'); return; }

    const payMethod = document.querySelector('input[name="pay-method"]:checked').value;
    const sub       = state.cart.reduce((s, c) => s + c.price * c.qty, 0);
    let disc = 0;
    if (state.appliedCoupon) {
        disc = state.appliedCoupon.discount_type === 'percent'
            ? Math.round(sub * state.appliedCoupon.discount_value / 100)
            : Math.min(parseFloat(state.appliedCoupon.discount_value), sub);
    }
    const total = sub - disc;

    const commonFields = {
        event_id:    state.currentEvent.id,
        buyer_name:  document.getElementById('buyer-name').value,
        buyer_email: document.getElementById('buyer-email').value,
        buyer_phone: document.getElementById('buyer-phone').value,
        coupon_code: state.appliedCoupon?.code || '',
        items: state.cart.map(c => ({ ticket_type_id: c.ticket_type_id, quantity: c.qty })),
    };

    // ── Cash path ────────────────────────────────────────────
    if (payMethod === 'cash') {
        const tendered = parseFloat(document.getElementById('cash-tendered').value) || 0;
        if (tendered < total) { showToast('Cash tendered is insufficient', 'error'); return; }
        const r = await API.post('transactions.php', { action: 'checkout' }, { ...commonFields, payment_method: 'cash' });
        if (!r.success) { showToast(r.error || 'Checkout failed', 'error'); return; }
        finishCheckout(r);
        return;
    }

    // ── Card path (PayMongo) ─────────────────────────────────
    if (payMethod === 'card') {
        const cardNum  = document.getElementById('card-number').value.replace(/\s/g, '');
        const expiry   = document.getElementById('card-expiry').value.replace(/\s/g, '').replace('/', '');
        const cvc      = document.getElementById('card-cvc').value.trim();
        const cardName = document.getElementById('card-name').value.trim();
        const email    = document.getElementById('buyer-email').value.trim();

        if (cardNum.length < 15 || expiry.length < 4 || cvc.length < 3 || !cardName) {
            showToast('Please fill in all card details', 'error'); return;
        }

        const btn = document.querySelector('.checkout-btn');
        btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';

        try {
            // Step 1: Create PaymentIntent on our backend
            const intentR = await API.post('transactions.php', { action: 'paymongo_intent' }, {
                amount: total, payment_method_type: 'card',
                description: `${state.currentEvent.name} — ${commonFields.buyer_name || 'Walk-in'}`,
            });
            if (!intentR.success) { showToast(intentR.error || 'Payment init failed', 'error'); return; }

            const { client_key, payment_intent_id, public_key } = intentR;
            const expMonth = parseInt(expiry.slice(0,2));
            const expYear  = parseInt('20' + expiry.slice(2,4));

            // Step 2: Create PaymentMethod (card) — uses PUBLIC key
            const pmRes = await fetch('https://api.paymongo.com/v1/payment_methods', {
                method: 'POST',
                headers: {
                    'Authorization': 'Basic ' + btoa(public_key + ':'),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ data: { attributes: {
                    type: 'card',
                    details: { card_number: cardNum, exp_month: expMonth, exp_year: expYear, cvc },
                    billing: { name: cardName, email: email || undefined },
                }}}),
            });
            const pmData = await pmRes.json();
            if (pmData.errors) { showToast(pmData.errors[0]?.detail || 'Card error', 'error'); return; }
            const paymentMethodId = pmData.data.id;

            // Step 3: Attach PaymentMethod to Intent — uses PUBLIC key
            const attachRes = await fetch(`https://api.paymongo.com/v1/payment_intents/${payment_intent_id}/attach`, {
                method: 'POST',
                headers: {
                    'Authorization': 'Basic ' + btoa(public_key + ':'),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ data: { attributes: { payment_method: paymentMethodId, client_key } } }),
            });
            const attachData = await attachRes.json();
            const piStatus   = attachData.data?.attributes?.status;

            if (piStatus === 'awaiting_next_action') {
                // 3D Secure — open in popup then poll for result
                const redirectUrl = attachData.data.attributes.next_action.redirect.url;
                const popup = window.open(redirectUrl, '3ds', 'width=500,height=700');
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Waiting for 3DS...';
                await poll3DS(popup, payment_intent_id, public_key);
            } else if (piStatus !== 'succeeded') {
                showToast('Card declined. Please try another card.', 'error');
                return;
            }

            // Step 4: Our backend verifies + saves the transaction
            const r = await API.post('transactions.php', { action: 'paymongo_complete' }, {
                ...commonFields, payment_intent_id, payment_method: 'card',
            });
            if (!r.success) { showToast(r.error || 'Checkout failed', 'error'); return; }
            finishCheckout(r);

        } catch (err) {
            showToast('Payment error: ' + err.message, 'error');
        } finally {
            btn.disabled = false; btn.innerHTML = '<i class="fas fa-check-circle"></i> Complete Sale';
        }
        return;
    }

    // ── GCash / Maya path (PayMongo redirect) ────────────────
    if (payMethod === 'gcash' || payMethod === 'paymaya') {
        const btn = document.querySelector('.checkout-btn');
        btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Redirecting...';

        try {
            // Step 1: Create PaymentIntent
            const intentR = await API.post('transactions.php', { action: 'paymongo_intent' }, {
                amount: total, payment_method_type: payMethod,
                description: `${state.currentEvent.name} — ${commonFields.buyer_name || 'Walk-in'}`,
            });
            if (!intentR.success) { showToast(intentR.error || 'Payment init failed', 'error'); return; }

            const { client_key, payment_intent_id, public_key } = intentR;
            const returnUrl = location.origin + location.pathname + '?paymongo_result=1&pi=' + payment_intent_id;

            // Step 2: Create PaymentMethod (gcash / paymaya)
            const pmRes = await fetch('https://api.paymongo.com/v1/payment_methods', {
                method: 'POST',
                headers: {
                    'Authorization': 'Basic ' + btoa(public_key + ':'),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ data: { attributes: {
                    type: payMethod,
                    billing: { name: commonFields.buyer_name || 'Walk-in', email: commonFields.buyer_email || undefined },
                }}}),
            });
            const pmData = await pmRes.json();
            if (pmData.errors) { showToast(pmData.errors[0]?.detail || 'Payment method error', 'error'); return; }

            // Step 3: Attach to Intent
            const attachRes = await fetch(`https://api.paymongo.com/v1/payment_intents/${payment_intent_id}/attach`, {
                method: 'POST',
                headers: {
                    'Authorization': 'Basic ' + btoa(public_key + ':'),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ data: { attributes: {
                    payment_method: pmData.data.id, client_key, return_url: returnUrl,
                }}}),
            });
            const attachData = await attachRes.json();
            const redirectUrl = attachData.data?.attributes?.next_action?.redirect?.url;

            // Save pending cart data to sessionStorage so we can complete after redirect
            localStorage.setItem('pending_checkout', JSON.stringify({
                ...commonFields, payment_method: payMethod, payment_intent_id,
            }));

            if (redirectUrl) window.location.href = redirectUrl;
            else showToast('Could not get redirect URL from PayMongo', 'error');

        } catch (err) {
            showToast('Payment error: ' + err.message, 'error');
            btn.disabled = false; btn.innerHTML = '<i class="fas fa-check-circle"></i> Complete Sale';
        }
        return;
    }
}

/* ── Poll for 3DS completion ────────────────────────────────── */
async function poll3DS(popup, paymentIntentId, publicKey) {
    return new Promise(resolve => {
        const interval = setInterval(async () => {
            if (popup.closed) {
                clearInterval(interval);
                resolve();
            }
            try {
                const res  = await fetch(`https://api.paymongo.com/v1/payment_intents/${paymentIntentId}`, {
                    headers: { 'Authorization': 'Basic ' + btoa(publicKey + ':') },
                });
                const data = await res.json();
                if (data.data?.attributes?.status === 'succeeded') {
                    clearInterval(interval);
                    popup.close();
                    resolve();
                }
            } catch {}
        }, 2000);
    });
}
async function handlePayMongoReturn() {
    const urlParams = new URLSearchParams(location.search);
    const intentId = urlParams.get('pi');
    const isReturn = urlParams.get('paymongo_result');

    if (!intentId || !isReturn) return false;

    history.replaceState({}, '', location.pathname);
    showToast('Verifying payment...', 'info');

    // Retrieve the saved cart data from before the redirect
   // ✅ NEW
const pending = JSON.parse(localStorage.getItem('pending_checkout') || '{}');
localStorage.removeItem('pending_checkout');
console.log('Pending checkout data:', pending);
    // Merge payment_intent_id WITH the full cart payload
    const status = await API.post('transactions.php', { action: 'paymongo_complete' }, {
        ...pending,
        payment_intent_id: intentId,
    });

    if (status.success) {
        showToast('Payment successful!', 'success');
        finishCheckout(status);
        return true;
    } else {
        showToast('Payment verification failed: ' + (status.error || 'Unknown error'), 'error');
        return false;
    }
}

/* ── Shared post-checkout finish ────────────────────────────── */
function finishCheckout(r) {
    window._lastCheckoutTickets = r.tickets;
    closeModal('checkout-modal');
    showReceipt(r);
    state.cart = []; state.appliedCoupon = null;
    renderCart();
    addActivity('sale', `Sold ${r.tickets.length} ticket(s) to ${r.buyer_name}`, '₱' + parseFloat(r.total_amount).toLocaleString());
    if (state.role === 'admin') { renderDashboardStats(); renderTicketTypesList(); renderRecentTransactions(); loadPOSTickets(); }
    else initStaffDashboard();
}

/* ── Receipt ─────────────────────────────────────────────────── */
function showReceipt(r) {
    const ev = state.currentEvent;
    document.getElementById('receipt-content').innerHTML = `
        <div class="receipt-header">
            <div class="receipt-event">${ev?.name || 'Event'}</div>
            <div class="receipt-ref">${r.receipt_no} · ${new Date().toLocaleString()}</div>
        </div>
        <div class="receipt-buyer">
            <div class="receipt-buyer-info">
                <p><i class="fas fa-user"></i> <strong>${r.buyer_name}</strong></p>
                ${r.buyer_email ? `<span>${r.buyer_email}</span>` : ''}
                ${r.buyer_phone ? `<span> · ${r.buyer_phone}</span>` : ''}
            </div>
            <span class="receipt-payment-badge">${r.payment_method.toUpperCase()}</span>
        </div>
        <div class="receipt-tickets-section" id="receipt-tix"></div>
        <div class="receipt-total-row">
            <span class="rt-label">Total Paid</span>
            <span class="rt-amount">₱${parseFloat(r.total_amount).toLocaleString()}</span>
        </div>
        <div class="receipt-footer-note">Show QR code at the entrance. Each code is valid for one-time use only.</div>
    `;
    const tixDiv = document.getElementById('receipt-tix');
    r.tickets.forEach(t => {
        const div = document.createElement('div');
        div.className = 'receipt-ticket-item';
        div.innerHTML = `
            <div class="rti-head">
                <div class="rti-name" style="color:${t.type_color}">${t.type_name}</div>
                <span class="rti-price">₱${parseFloat(t.unit_price).toLocaleString()}</span>
            </div>
            <div class="rti-code">${t.ticket_code}</div>
            <div class="rti-qr" id="qr-${t.id}"></div>
        `;
        tixDiv.appendChild(div);
        setTimeout(() => {
            try { new QRCode(document.getElementById('qr-' + t.id), { text: t.ticket_code, width: 120, height: 120, colorDark: '#000', colorLight: '#fff' }); }
            catch { document.getElementById('qr-' + t.id).textContent = t.ticket_code; }
        }, 50);
    });
    openModal('receipt-modal');
}
function closeReceiptAndReset() { closeModal('receipt-modal'); }
function printReceipt() {
    const tickets = window._lastCheckoutTickets;
    if (!tickets || !tickets.length) { alert('No tickets to print.'); return; }

    const ev = state.currentEvent;
    const buyerName = document.querySelector('.receipt-buyer-info strong')?.textContent || '';

    // Remove old frame
    const old = document.getElementById('qr-print-frame');
    if (old) old.remove();

    // Build print frame
    const frame = document.createElement('div');
    frame.id = 'qr-print-frame';

    let cards = '';
    tickets.forEach(t => {
        cards += `<div class="qr-print-card">
            <div class="qp-event">${ev?.name || ''}</div>
            <div class="qp-type">${t.type_name}</div>
            <div class="qp-buyer">${buyerName}</div>
            <div class="qp-qr" id="pqr-${t.ticket_code}"></div>
            <div class="qp-code">${t.ticket_code}</div>
            <div class="qp-note">Show at entrance &middot; One-time use only</div>
        </div>`;
    });

    frame.innerHTML = `<div class="qr-print-page"><div class="qr-cards-wrap">${cards}</div></div>`;
    document.body.appendChild(frame);

    // Generate QR into each card
    tickets.forEach(t => {
        const el = document.getElementById('pqr-' + t.ticket_code);
        if (el) {
            try {
                new QRCode(el, { text: t.ticket_code, width: 160, height: 160, colorDark: '#000', colorLight: '#fff' });
            } catch(e) { el.textContent = t.ticket_code; }
        }
    });

    // Wait for QR to render, then print
    setTimeout(() => {
        document.body.classList.add('printing-qr');
        window.print();
        setTimeout(() => {
            document.body.classList.remove('printing-qr');
            frame.remove();
        }, 1500);
    }, 700);
}

/* ── Scanner ─────────────────────────────────────────────────── */
async function showScanner() {
    showPage('page-scanner');
    setAdminNav('nav-scanner');
    document.getElementById('scanner-staff-name').textContent = state.user?.full_name || 'Staff';
    await loadEvents();
    state.scanCounts = { valid: 0, used: 0, invalid: 0 };
    updateScanCounters();
    setScanMode('camera');
}

function setScanMode(mode) {
    document.getElementById('camera-view').classList.toggle('hidden', mode !== 'camera');
    document.getElementById('manual-view').classList.toggle('hidden', mode !== 'manual');
    document.getElementById('tab-cam').classList.toggle('active',    mode === 'camera');
    document.getElementById('tab-manual').classList.toggle('active', mode === 'manual');
    if (mode === 'camera') startCamera();
    else { stopCamera(); setTimeout(() => document.getElementById('manual-code')?.focus(), 100); }
}

function startCamera() {
    if (!state.html5QrCode) state.html5QrCode = new Html5Qrcode('qr-reader');
    if (state.cameraRunning) return;
    state.html5QrCode.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (code) => { if (!state.scanLock) await processTicketCode(code); },
        () => {}
    ).then(() => state.cameraRunning = true)
     .catch(() => { showToast('Camera unavailable — use manual mode', 'warning'); setScanMode('manual'); });
}

function stopCamera() {
    if (state.html5QrCode && state.cameraRunning) {
        state.html5QrCode.stop().catch(() => {});
        state.cameraRunning = false;
    }
}

async function handleManualScan(e) {
    e.preventDefault();
    const code = document.getElementById('manual-code').value.trim().toUpperCase();
    if (!code) return;
    await processTicketCode(code);
    document.getElementById('manual-code').value = '';
}

async function processTicketCode(code) {
    if (!state.currentEvent) { showToast('Select an event first', 'warning'); return; }
    state.scanLock = true;
    setTimeout(() => { state.scanLock = false; }, 2500);

    const r = await API.post('scanner.php', { action: 'scan' }, {
        ticket_code: code, event_id: state.currentEvent.id,
    });
    if (!r.success) { showToast('Scan error: ' + r.error, 'error'); return; }

    const result  = r.result;
    const data    = r.data;
    const overlay = document.getElementById('scan-overlay');
    const resBox  = document.getElementById('scan-result-box');

    const cfg = {
        valid:        { bg: 'valid-bg',   icon: 'fa-check-circle',        title: 'Valid Ticket!',   msg: data.buyer_name || 'Welcome!' },
        already_used: { bg: 'used-bg',    icon: 'fa-exclamation-triangle', title: 'Already Used',   msg: 'Checked in at ' + (data.checked_in_at || '') },
        invalid:      { bg: 'invalid-bg', icon: 'fa-times-circle',         title: 'Invalid Ticket', msg: 'Code not found in system' },
        wrong_event:  { bg: 'invalid-bg', icon: 'fa-times-circle',         title: 'Wrong Event',    msg: data.correct_event || 'Different event' },
    };
    const c = cfg[result] || cfg.invalid;

    overlay.className = 'scan-overlay ' + c.bg;
    overlay.classList.remove('hidden');
    resBox.innerHTML  = `<i class="fas ${c.icon}"></i><h3>${c.title}</h3><p>${c.msg}</p>`;
    setTimeout(() => overlay.classList.add('hidden'), 2500);

    // Detail panel
    const typeMap = { valid: 'valid', already_used: 'used', invalid: 'invalid', wrong_event: 'invalid' };
    const detType = typeMap[result] || 'invalid';
    const iconMap = { valid: 'fa-check-circle', used: 'fa-exclamation-circle', invalid: 'fa-times-circle' };
    const statMap = { valid: 'Checked In', used: 'Already Used', invalid: 'Invalid' };
    let detailRows = [['fas fa-barcode', code]];
    if (data.type_name)    detailRows.push(['fas fa-ticket-alt', data.type_name]);
    if (data.buyer_name)   detailRows.push(['fas fa-user', data.buyer_name]);
    if (data.checked_in_at) detailRows.push(['fas fa-clock', 'First check-in: ' + new Date(data.checked_in_at).toLocaleString()]);
    if (result === 'valid') detailRows.push(['fas fa-clock', 'Entry: ' + new Date().toLocaleString()]);
    if (data.correct_event) detailRows.push(['fas fa-calendar', 'Belongs to: ' + data.correct_event]);

    document.getElementById('ticket-detail-panel').innerHTML = `
        <div class="ticket-detail-card ${detType}-card">
            <div class="detail-card-head">
                <div class="detail-status-icon dsi-${detType}"><i class="fas ${iconMap[detType]}"></i></div>
                <div><div class="detail-name">${statMap[detType]}</div><div class="detail-sub">${code}</div></div>
            </div>
            ${detailRows.map(([ic, txt]) => `<div class="detail-row"><i class="${ic}"></i><span>${txt}</span></div>`).join('')}
        </div>`;

    // Counters
    if (result === 'valid') state.scanCounts.valid++;
    else if (result === 'already_used') state.scanCounts.used++;
    else state.scanCounts.invalid++;
    updateScanCounters();
    addToRecentScans(code, result === 'valid' ? 'valid' : result === 'already_used' ? 'used' : 'invalid');
    if (result === 'valid') addActivity('scan', 'Checked in: ' + (data.buyer_name || 'Guest'), data.type_name || 'Ticket');
}

function addToRecentScans(code, type) {
    const list = document.getElementById('recent-scans-list');
    const el   = document.createElement('div');
    el.className = 'scan-entry';
    el.innerHTML = `<span class="scan-entry-code">${code}</span><span class="scan-entry-status ${type}">${type.toUpperCase()}</span>`;
    list.insertBefore(el, list.firstChild);
    if (list.children.length > 8) list.removeChild(list.lastChild);
    document.getElementById('scan-count-badge').textContent = list.children.length;
}

function updateScanCounters() {
    document.getElementById('scan-valid-count').textContent   = state.scanCounts.valid;
    document.getElementById('scan-used-count').textContent    = state.scanCounts.used;
    document.getElementById('scan-invalid-count').textContent = state.scanCounts.invalid;
}

function resetScanner() {
    state.scanCounts = { valid: 0, used: 0, invalid: 0 };
    updateScanCounters();
    document.getElementById('ticket-detail-panel').innerHTML = '<div class="detail-empty"><i class="fas fa-id-card"></i><p>Scan a ticket to see details</p></div>';
    document.getElementById('recent-scans-list').innerHTML = '';
    document.getElementById('scan-count-badge').textContent = '0';
    document.getElementById('scan-overlay').classList.add('hidden');
    showToast('Scanner reset', 'info');
}

/* ── Reports ─────────────────────────────────────────────────── */
async function showReports() {
    showPage('page-reports');
    setAdminNav('nav-reports');
    await loadEvents();
    if (state.currentEvent) document.getElementById('rpt-event-sel').value = state.currentEvent.id;
    loadReportData();
}

async function loadReportData() {
    const evId    = document.getElementById('rpt-event-sel')?.value;
    const range   = document.getElementById('rpt-range')?.value   || 'all';
    const payment = document.getElementById('rpt-payment')?.value || 'all';
    if (!evId) return;

    const [statsR, salesR, ciR, breakR, payR, txR] = await Promise.all([
        API.get('reports.php',      { action: 'dashboard',   event_id: evId }),
        API.get('reports.php',      { action: 'sales_trend', event_id: evId, range }),
        API.get('reports.php',      { action: 'checkins',    event_id: evId }),
        API.get('reports.php',      { action: 'breakdown',   event_id: evId }),
        API.get('reports.php',      { action: 'payments',    event_id: evId }),
        API.get('transactions.php', { action: 'list', event_id: evId, range, payment }),
    ]);

    // Stats
    const d = statsR.data || {};
    document.getElementById('report-stats').innerHTML = `
        ${statCard('Total Revenue',    '₱' + parseFloat(d.total_revenue||0).toLocaleString(),    'fas fa-peso-sign','si-violet', d.total_transactions+' transactions','neutral')}
        ${statCard('Tickets Sold',      d.total_sold||0,                                          'fas fa-ticket-alt','si-blue',  d.total_capacity+' capacity','neutral')}
        ${statCard('Checked In',        d.checked_in||0,                                          'fas fa-door-open', 'si-emerald',Math.round((d.checked_in/Math.max(d.total_sold,1))*100)+'%','up')}
        ${statCard('Avg Transaction',  '₱' + Math.round(parseFloat(d.avg_transaction||0)).toLocaleString(),'fas fa-receipt','si-amber','per sale','neutral')}
    `;

    // Sales chart
    destroyChart('rptSalesChart');
    const days = []; const salesMap = {};
    for (let i = 29; i >= 0; i--) {
        const d2 = new Date(); d2.setDate(d2.getDate() - i);
        days.push(d2.toLocaleDateString('en',{month:'short',day:'numeric'}));
        salesMap[d2.toISOString().split('T')[0]] = 0;
    }
    (salesR.data||[]).forEach(r => { salesMap[r.sale_date] = parseFloat(r.revenue); });
    const salesVals = Object.values(salesMap);
    state.charts['rptSalesChart'] = new Chart(document.getElementById('rptSalesChart').getContext('2d'), {
        type:'line', data:{ labels:days, datasets:[{ data:salesVals, borderColor:'#8b5cf6', backgroundColor:'rgba(139,92,246,0.08)', tension:0.4, fill:true, pointRadius:3, pointBackgroundColor:'#8b5cf6' }] },
        options: rptOpts('₱')
    });

    // Checkin chart
    destroyChart('rptCheckinChart');
    const ciMap = {};
    days.forEach((_, i) => { const d2 = new Date(); d2.setDate(d2.getDate() - (29-i)); ciMap[d2.toISOString().split('T')[0]] = 0; });
    (ciR.data||[]).forEach(r => { const k = r.checkin_date; if (ciMap[k] !== undefined) ciMap[k] += parseInt(r.count); });
    state.charts['rptCheckinChart'] = new Chart(document.getElementById('rptCheckinChart').getContext('2d'), {
        type:'bar', data:{ labels:days, datasets:[{ data:Object.values(ciMap), backgroundColor:'rgba(20,184,166,0.5)', borderColor:'#14b8a6', borderRadius:5 }] },
        options: rptOpts('')
    });

    // Breakdown donut
    destroyChart('rptBreakdownChart');
    const bd = breakR.data || [];
    state.charts['rptBreakdownChart'] = new Chart(document.getElementById('rptBreakdownChart').getContext('2d'), {
        type:'doughnut', data:{ labels:bd.map(x=>x.name), datasets:[{ data:bd.map(x=>x.sold_qty), backgroundColor:bd.map(x=>x.color+'cc'), borderColor:bd.map(x=>x.color), borderWidth:2 }] },
        options:{ responsive:true, plugins:{ legend:{ labels:{ color:'#a0a0b0', font:{ size:12 } } } } }
    });

    // Payment pie
    destroyChart('rptPaymentChart');
    const pd = payR.data || [];
    state.charts['rptPaymentChart'] = new Chart(document.getElementById('rptPaymentChart').getContext('2d'), {
        type:'pie', data:{ labels:pd.map(x=>x.payment_method.toUpperCase()), datasets:[{ data:pd.map(x=>parseFloat(x.revenue)), backgroundColor:['#10b981bb','#3b82f6bb','#8b5cf6bb','#ec4899bb'], borderWidth:2 }] },
        options:{ responsive:true, plugins:{ legend:{ labels:{ color:'#a0a0b0', font:{ size:12 } } } } }
    });

    // Transaction table
    const txs   = txR.data || [];
    const tbody = document.getElementById('tx-tbody');
    document.getElementById('tx-count-badge').textContent = txs.length + ' records';
    document.getElementById('tx-empty').classList.toggle('hidden', txs.length > 0);
    tbody.innerHTML = txs.map(tx => `<tr>
        <td><span style="font-family:'Courier New';font-size:.78rem;color:var(--violet)">${tx.receipt_no}</span></td>
        <td>${tx.buyer_name||'—'}</td>
        <td style="color:var(--text-dim)">${tx.buyer_email||'—'}</td>
        <td>${tx.items_summary||'—'}</td>
        <td>${tx.total_tickets||0}</td>
        <td style="color:var(--emerald);font-weight:700">₱${parseFloat(tx.total_amount).toLocaleString()}</td>
        <td><span class="status-badge neutral" style="text-transform:uppercase">${tx.payment_method}</span></td>
        <td style="color:var(--text-dim)">${tx.staff_name||'—'}</td>
        <td style="color:var(--text-dim);font-size:.78rem">${new Date(tx.created_at).toLocaleString()}</td>
    </tr>`).join('');
}

function rptOpts(prefix) {
    return { responsive:true, plugins:{ legend:{ display:false } }, scales:{
        x:{ grid:{ color:'rgba(255,255,255,0.04)' }, ticks:{ color:'#7a7a9a', font:{ size:10 } } },
        y:{ grid:{ color:'rgba(255,255,255,0.04)' }, ticks:{ color:'#7a7a9a', font:{ size:10 }, callback: v => prefix + v.toLocaleString() } }
    }};
}

function showRptTab(tab, el) {
    ['sales','checkins','breakdown','payment'].forEach(t => document.getElementById('rpt-'+t)?.classList.toggle('hidden', t !== tab));
    document.querySelectorAll('.report-chart-tabs .tab-btn').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
}

function exportCSV() {
    const evId = document.getElementById('rpt-event-sel')?.value;
    API.get('transactions.php', { action:'list', event_id: evId||'' }).then(r => {
        const rows = [['Receipt#','Buyer','Email','Phone','Items','Total','Payment','Staff','Date']];
        (r.data||[]).forEach(tx => rows.push([tx.receipt_no, tx.buyer_name||'', tx.buyer_email||'', tx.buyer_phone||'', tx.items_summary||'', tx.total_amount, tx.payment_method, tx.staff_name||'', tx.created_at]));
        const csv = rows.map(r => r.map(v => '"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
        a.download = 'transactions.csv'; a.click();
        showToast('CSV exported', 'success');
    });
}
function exportPDF() { window.print(); showToast('Opening print dialog','info'); }

/* ── Attendees ───────────────────────────────────────────────── */
async function initAttendeesSection() {
    showAdminSection('attendees');
    setAdminNav('nav-attendees');
    await loadEvents();
    renderAttendeesTable();
}

async function renderAttendeesTable() {
    const evId   = state.currentEvent?.id || '';
    const search = document.getElementById('attendee-search')?.value || '';
    const r      = await API.get('reports.php', { action:'attendees', event_id: evId, search });
    const tbody  = document.getElementById('attendee-tbody');
    const empty  = document.getElementById('attendee-empty');
    const data   = r.data || [];
    empty.classList.toggle('hidden', data.length > 0);
    tbody.innerHTML = data.map(t => `<tr>
        <td><span style="font-family:'Courier New';font-size:.78rem;color:var(--violet)">${t.ticket_code}</span></td>
        <td><strong>${t.buyer_name||'—'}</strong></td>
        <td style="color:var(--text-dim)">${t.buyer_email||'—'}</td>
        <td style="color:var(--text-dim)">${t.buyer_phone||'—'}</td>
        <td><span style="font-weight:600">${t.ticket_type||'—'}</span></td>
        <td style="color:var(--emerald)">₱${parseFloat(t.ticket_price||0).toLocaleString()}</td>
        <td><span class="status-badge neutral" style="text-transform:uppercase">${t.payment_method||'—'}</span></td>
        <td>${t.status==='checked_in' ? '<span class="status-badge checked"><i class="fas fa-check"></i> Checked In</span>' : '<span class="status-badge pending"><i class="fas fa-clock"></i> Pending</span>'}</td>
        <td style="color:var(--text-dim);font-size:.78rem">${t.sold_at ? new Date(t.sold_at).toLocaleString() : '—'}</td>
    </tr>`).join('');
}

function filterAttendees() { renderAttendeesTable(); }

function exportAttendeesCSV() {
    const evId = state.currentEvent?.id || '';
    API.get('reports.php', { action:'attendees', event_id:evId }).then(r => {
        const rows = [['Ticket Code','Name','Email','Phone','Type','Price','Payment','Status','Sold At']];
        (r.data||[]).forEach(t => rows.push([t.ticket_code, t.buyer_name||'', t.buyer_email||'', t.buyer_phone||'', t.ticket_type||'', t.ticket_price||0, t.payment_method||'', t.status, t.sold_at||'']));
        const csv = rows.map(r => r.map(v => '"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download = 'attendees.csv'; a.click();
        showToast('Exported', 'success');
    });
}

/* ── Staff Dashboard ─────────────────────────────────────────── */
async function initStaffDashboard() {
    await loadEvents();
    if (state.events.length && !state.currentEvent) state.currentEvent = state.events.find(e => e.status === 'active') || state.events[0];
    const evId = state.currentEvent?.id;
    const r    = evId ? await API.get('reports.php', { action:'dashboard', event_id:evId }) : { data:{} };
    const d    = r.data || {};
    const today = evId ? await API.get('transactions.php',{ action:'list', event_id:evId, range:'today' }) : { data:[] };
    const todayTxs = today.data || [];
    document.getElementById('staff-stats-grid').innerHTML = `
        ${staffStatCard("Today's Sales",   todayTxs.length, 'fas fa-receipt', 'si-violet')}
        ${staffStatCard('Checked In',       d.checked_in||0, 'fas fa-door-open', 'si-emerald')}
        ${staffStatCard("Today's Revenue", '₱'+todayTxs.reduce((s,t)=>s+parseFloat(t.total_amount||0),0).toLocaleString(), 'fas fa-peso-sign','si-amber')}
    `;
    renderActivityFeed();
}

function staffStatCard(label, val, icon, cls) {
    return `<div class="stat-card" style="display:flex;align-items:center;gap:1rem">
        <div class="stat-icon ${cls}" style="flex-shrink:0"><i class="${icon}"></i></div>
        <div><div class="stat-val" style="font-size:1.4rem">${val}</div><div class="stat-label">${label}</div></div>
    </div>`;
}

function addActivity(type, text, sub) {
    state.activityLog.unshift({ type, text, sub, time: new Date() });
    if (state.activityLog.length > 20) state.activityLog.pop();
    renderActivityFeed();
}

function renderActivityFeed() {
    const feed = document.getElementById('staff-activity-feed');
    if (!feed) return;
    if (!state.activityLog.length) { feed.innerHTML = '<div class="feed-empty"><i class="fas fa-history"></i><p>No activity yet</p></div>'; return; }
    feed.innerHTML = state.activityLog.slice(0,8).map(a => `
        <div class="feed-item">
            <div class="feed-icon ${a.type}"><i class="fas fa-${a.type==='sale'?'cash-register':'qrcode'}"></i></div>
            <div style="flex:1"><div class="feed-text">${a.text}</div><div class="feed-sub">${a.sub}</div></div>
            <span class="feed-time">${timeAgo(a.time)}</span>
        </div>`).join('');
}

/* ── Modal helpers ───────────────────────────────────────────── */
function openModal(id) { const el = document.getElementById(id); el.style.display='flex'; el.classList.add('active'); }
function closeModal(id) { const el = document.getElementById(id); el.style.display='none'; el.classList.remove('active'); }
document.addEventListener('click', e => { if (e.target.classList.contains('modal-overlay')) closeModal(e.target.id); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.active').forEach(m => closeModal(m.id)); });

/* ── Toast ───────────────────────────────────────────────────── */
function showToast(msg, type = 'success') {
    const icons = { success:'check-circle', error:'exclamation-circle', warning:'exclamation-triangle', info:'info-circle' };
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.innerHTML = `<i class="fas fa-${icons[type]||'info-circle'}"></i> ${msg}`;
    document.getElementById('toast-container').appendChild(t);
    setTimeout(() => t.remove(), 3100);
}

/* ── Utilities ───────────────────────────────────────────────── */
function timeAgo(date) {
    const diff = Date.now() - new Date(date).getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
    return new Date(date).toLocaleDateString();
}

/* ── Check-in Management ──────────────────────────────────── */
async function showCheckinSection() {
    showPage('page-admin');
    showAdminSection('checkin');
    setAdminNav('nav-checkin');
    await loadEvents();
    renderEventTabs('checkin-event-tabs');
    const c = document.getElementById('checkin-event-tabs');
    if (c) c.querySelectorAll('.event-tab').forEach(btn => {
        btn.onclick = () => {
            const ev = state.events.find(e => e.name === btn.textContent.trim());
            if (ev) { state.currentEvent = ev; renderAllEventTabs(); loadCheckinStats(); loadCheckinList(); }
        };
    });
    if (state.currentEvent) { loadCheckinStats(); loadCheckinList(); }
}

async function loadCheckinStats() {
    if (!state.currentEvent) return;
    const r = await API.get('checkin.php', { action: 'stats', event_id: state.currentEvent.id });
    if (!r.success) return;
    const d = r.data;
    document.getElementById('checkin-stats-row').innerHTML = `
        ${statCard('Total Tickets',  d.total_tickets || 0, 'fas fa-ticket-alt', 'si-blue',   'issued tickets', 'neutral')}
        ${statCard('Checked In',     d.checked_in    || 0, 'fas fa-check-circle','si-emerald', d.checkin_rate + '% rate', 'up')}
        ${statCard('Still Pending',  d.pending       || 0, 'fas fa-clock',       'si-amber',  'not yet entered', 'neutral')}
    `;
}

async function loadCheckinList() {
    if (!state.currentEvent) return;
    const status  = document.getElementById('checkin-status-filter')?.value || 'all';
    const search  = document.getElementById('checkin-search')?.value || '';
    const loading = document.getElementById('checkin-loading');
    const empty   = document.getElementById('checkin-empty');
    const tbody   = document.getElementById('checkin-tbody');

    loading.classList.remove('hidden');
    empty.classList.add('hidden');
    tbody.innerHTML = '';

    const r = await API.get('checkin.php', { action: 'list', event_id: state.currentEvent.id, status, search });
    loading.classList.add('hidden');

    if (!r.success || !r.data.length) { empty.classList.remove('hidden'); return; }

    tbody.innerHTML = r.data.map(t => {
        const isChecked = t.status === 'checked_in';
        const checkedTime = t.checked_in_at ? new Date(t.checked_in_at).toLocaleString() : '';
        const actionBtn = isChecked
            ? `<div class="already-checked"><i class="fas fa-check-circle"></i> Done
               <span class="checkin-time">${checkedTime}</span></div>
               <button class="btn btn-sm btn-danger" style="margin-top:.25rem;font-size:.7rem" onclick="undoCheckin(${t.id}, this)">
                   <i class="fas fa-undo"></i> Undo
               </button>`
            : `<button class="checkin-btn" onclick="checkInTicket('${t.ticket_code}', this)">
                   <i class="fas fa-check"></i> Check In
               </button>`;

        return `<tr id="ci-row-${t.id}">
            <td><span style="font-family:'Courier New';font-size:.78rem;color:var(--violet)">${t.ticket_code}</span></td>
            <td><strong>${t.buyer_name || '—'}</strong></td>
            <td><span style="color:${t.ticket_color};font-weight:600">${t.ticket_type}</span></td>
            <td style="color:var(--text-dim)">${t.buyer_email || '—'}</td>
            <td style="color:var(--text-dim)">${t.buyer_phone || '—'}</td>
            <td>${isChecked
                ? '<span class="status-badge checked"><i class="fas fa-check"></i> Checked In</span>'
                : '<span class="status-badge pending"><i class="fas fa-clock"></i> Pending</span>'}</td>
            <td style="font-size:.78rem;color:var(--text-dim)">${checkedTime || '—'}</td>
            <td id="ci-action-${t.id}">${actionBtn}</td>
        </tr>`;
    }).join('');
}

// Check in a single ticket from the table button
async function checkInTicket(code, btnEl) {
    if (!state.currentEvent) return;
    btnEl.disabled = true;
    btnEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Checking...';

    const r = await API.post('checkin.php', { action: 'checkin' }, {
        ticket_code: code, event_id: state.currentEvent.id
    });

    if (r.success) {
        showToast('✅ ' + r.message, 'success');
        addActivity('scan', r.message, code);
        loadCheckinStats();
        loadCheckinList(); // refresh table
    } else {
        if (r.result === 'already_used') {
            showToast('⚠️ Already checked in', 'warning');
        } else {
            showToast(r.error || 'Check-in failed', 'error');
        }
        btnEl.disabled = false;
        btnEl.innerHTML = '<i class="fas fa-check"></i> Check In';
    }
}

// Undo check-in button
async function undoCheckin(ticketId, btnEl) {
    if (!confirm('Undo this check-in? The ticket will be set back to Pending.')) return;
    btnEl.disabled = true;
    const r = await API.post('checkin.php', { action: 'undo' }, { ticket_id: ticketId });
    if (r.success) {
        showToast('Check-in undone', 'info');
        loadCheckinStats();
        loadCheckinList();
    } else {
        showToast(r.error || 'Failed', 'error');
        btnEl.disabled = false;
    }
}

// Manual check-in by typing code into the form
async function manualCheckinByCode(e) {
    e.preventDefault();
    const code = document.getElementById('checkin-code-input').value.trim().toUpperCase();
    if (!code || !state.currentEvent) return;

    const r = await API.post('checkin.php', { action: 'checkin' }, {
        ticket_code: code, event_id: state.currentEvent.id
    });

    const banner = document.getElementById('checkin-result-banner');
    banner.classList.remove('hidden', 'valid', 'used', 'invalid');

    if (r.success) {
        banner.className = 'checkin-banner valid';
        banner.innerHTML = `<i class="fas fa-check-circle"></i> <strong>Checked In!</strong> — ${r.message}`;
        document.getElementById('checkin-code-input').value = '';
        loadCheckinStats();
        loadCheckinList();
        addActivity('scan', r.message, code);
    } else if (r.result === 'already_used') {
        banner.className = 'checkin-banner used';
        banner.innerHTML = `<i class="fas fa-exclamation-triangle"></i> <strong>Already Used</strong> — ${r.error}`;
    } else {
        banner.className = 'checkin-banner invalid';
        banner.innerHTML = `<i class="fas fa-times-circle"></i> <strong>Invalid</strong> — ${r.error}`;
    }

    setTimeout(() => banner.classList.add('hidden'), 5000);
}