// ============================================================
//  Easy2 → Pipedrive  |  Webhook Server
//  Receives booking events from Easy2, saves to Pipedrive
// ============================================================

require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Global Request Logger ─────────────────────────────────────
// Logs EVERY incoming request — method, url, headers, body, query
app.use((req, res, next) => {
    console.log('\n' + '▓'.repeat(60));
    console.log(`📡 INCOMING REQUEST  [${new Date().toISOString()}]`);
    console.log(`▸ Method:       ${req.method}`);
    console.log(`▸ URL:          ${req.originalUrl}`);
    console.log(`▸ IP:           ${req.ip}`);
    console.log(`▸ Content-Type: ${req.headers['content-type'] || 'none'}`);
    console.log(`▸ User-Agent:   ${req.headers['user-agent'] || 'none'}`);
    console.log('▸ Headers:', JSON.stringify(req.headers, null, 2));
    console.log('▸ Query Params:', JSON.stringify(req.query, null, 2));
    console.log('▸ Body:', JSON.stringify(req.body, null, 2));
    console.log('▓'.repeat(60) + '\n');
    next();
});

const PORT = process.env.PORT || 3000;
const PIPEDRIVE_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const PIPEDRIVE_DOMAIN = process.env.PIPEDRIVE_DOMAIN; // e.g. "yourcompany"

// ── Helpers ──────────────────────────────────────────────────

function log(label, data) {
    console.log('\n' + '='.repeat(55));
    console.log(`[${new Date().toISOString()}]  ${label}`);
    if (data) console.log(JSON.stringify(data, null, 2));
    console.log('='.repeat(55));
}

async function pipedrivePost(endpoint, body) {
    const url = `https://${PIPEDRIVE_DOMAIN}.pipedrive.com/api/v1/${endpoint}?api_token=${PIPEDRIVE_TOKEN}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.success) {
        throw new Error(`Pipedrive error on ${endpoint}: ${JSON.stringify(json.error)}`);
    }
    return json.data;
}

// ── Extract fields from Easy2 payload ────────────────────────
// Easy2 sends different shapes depending on what triggered it.
// We try every common field name so the code works regardless.

function extractBooking(body) {
    // Easy2 may wrap data inside body.data or send it flat
    const d = body.data || body;

    return {
        // Contact info
        name: d.name || d.contact_name || d.full_name || d.customer_name || 'Unknown',
        email: d.email || d.contact_email || d.customer_email || '',
        phone: d.phone || d.contact_phone || d.customer_phone || '',

        // Appointment info
        service: d.service || d.service_name || d.appointment_type || d.type || 'Appointment',
        startDate: d.start_date || d.date || d.appointment_date || '',
        startTime: d.start_time || d.time || d.appointment_time || '',
        notes: d.notes || d.message || d.description || '',

        // Raw event type e.g. "appointment.created"
        event: body.event || body.type || 'booking',
    };
}

// ── Main Pipedrive save function ──────────────────────────────

async function saveToPipedrive(booking) {
    log('Saving to Pipedrive', booking);

    // 1. Create Person (contact)
    const person = await pipedrivePost('persons', {
        name: booking.name,
        email: booking.email ? [{ value: booking.email, primary: true }] : undefined,
        phone: booking.phone ? [{ value: booking.phone, primary: true }] : undefined,
    });
    log('✅ Person created', { id: person.id, name: person.name });

    // 2. Create Deal linked to Person
    const deal = await pipedrivePost('deals', {
        title: `${booking.service} — ${booking.name}`,
        person_id: person.id,
    });
    log('✅ Deal created', { id: deal.id, title: deal.title });

    // 3. Create Activity (the actual meeting slot)
    const activity = await pipedrivePost('activities', {
        subject: `📅 ${booking.service} with ${booking.name}`,
        type: 'meeting',
        due_date: booking.startDate || undefined,
        due_time: booking.startTime || undefined,
        person_id: person.id,
        deal_id: deal.id,
        note: [
            `Booked via Easy2`,
            booking.notes ? `Notes: ${booking.notes}` : '',
            `Email: ${booking.email}`,
            `Phone: ${booking.phone}`,
        ].filter(Boolean).join('\n'),
    });
    log('✅ Activity created', { id: activity.id, subject: activity.subject });

    return { person, deal, activity };
}

// ── Routes ────────────────────────────────────────────────────

// Health check — visit this in your browser to confirm server is up
app.get('/', (req, res) => {
    log('🏠 Health check hit', { ip: req.ip, userAgent: req.headers['user-agent'] });
    res.json({
        status: 'running',
        message: 'Easy2 → Pipedrive webhook server is live',
        time: new Date().toISOString(),
    });
});

// ✅  MAIN WEBHOOK ENDPOINT  — paste this URL into Easy2
app.post('/webhook', async (req, res) => {
    console.log('\n=======================================================');
    console.log('🚀 FULL RAW INCOMING REQUEST DATA:');
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Query parameters:', JSON.stringify(req.query, null, 2));
    console.log('Parsed Body:', JSON.stringify(req.body, null, 2));
    console.log('=======================================================\n');

    log('📩 Incoming webhook from Easy2', req.body);

    // Always respond 200 immediately so Easy2 doesn't retry
    res.status(200).json({ received: true });

    // Guard: skip if no body
    if (!req.body || Object.keys(req.body).length === 0) {
        console.log('⚠️  Empty body received — nothing to process');
        return;
    }

    // Guard: check credentials are configured
    if (!PIPEDRIVE_TOKEN || !PIPEDRIVE_DOMAIN) {
        console.error('❌  PIPEDRIVE_API_TOKEN or PIPEDRIVE_DOMAIN not set in .env');
        return;
    }

    try {
        const booking = extractBooking(req.body);
        const result = await saveToPipedrive(booking);
        log('🎉 All done! Saved to Pipedrive successfully', {
            personId: result.person.id,
            dealId: result.deal.id,
            activityId: result.activity.id,
        });
    } catch (err) {
        console.error('❌  Error saving to Pipedrive:', err.message);
    }
});

// Test endpoint — send a fake booking without needing Easy2
app.post('/test', async (req, res) => {
    log('🧪 Test endpoint hit');

    const fakeBooking = {
        event: 'appointment.created',
        data: {
            name: 'Test User',
            email: 'test@example.com',
            phone: '+2348012345678',
            service: 'Strategy Call',
            start_date: new Date().toISOString().split('T')[0],
            start_time: '10:00',
            notes: 'This is a test booking from the /test endpoint',
        },
    };

    log('Fake payload being processed', fakeBooking);

    if (!PIPEDRIVE_TOKEN || !PIPEDRIVE_DOMAIN) {
        return res.status(500).json({
            error: 'PIPEDRIVE_API_TOKEN or PIPEDRIVE_DOMAIN not set in .env file',
        });
    }

    try {
        const booking = extractBooking(fakeBooking);
        const result = await saveToPipedrive(booking);
        res.json({
            success: true,
            message: 'Test booking saved to Pipedrive!',
            personId: result.person.id,
            dealId: result.deal.id,
            activityId: result.activity.id,
        });
    } catch (err) {
        console.error('❌  Test failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Start ─────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log('\n' + '='.repeat(55));
    console.log(`🚀  Server running on http://localhost:${PORT}`);
    console.log(`📬  Webhook endpoint: http://localhost:${PORT}/webhook`);
    console.log(`🧪  Test endpoint:    http://localhost:${PORT}/test  (POST)`);
    console.log(`❤️   Health check:    http://localhost:${PORT}/`);
    console.log('='.repeat(55) + '\n');
});