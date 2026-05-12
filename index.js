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

/**
 * Pipedrive GET helper — used to search for existing contacts
 */
async function pipedriveGet(endpoint) {
    const url = `https://${PIPEDRIVE_DOMAIN}.pipedrive.com/api/v1/${endpoint}${endpoint.includes('?') ? '&' : '?'}api_token=${PIPEDRIVE_TOKEN}`;
    const res = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
    });
    const json = await res.json();
    return json;
}

/**
 * Pipedrive POST helper
 */
async function pipedrivePost(endpoint, body) {
    const url = `https://${PIPEDRIVE_DOMAIN}.pipedrive.com/api/v1/${endpoint}?api_token=${PIPEDRIVE_TOKEN}`;
    log(`📤 Pipedrive POST → ${endpoint}`, body);
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.success) {
        log(`❌ Pipedrive error on ${endpoint}`, json);
        throw new Error(`Pipedrive error on ${endpoint}: ${JSON.stringify(json.error || json)}`);
    }
    return json.data;
}

// ── Extract fields from Easy2 payload ────────────────────────
// Easy2 booking_created webhook sends:
// {
//   id, eventId, start (unix), end (unix),
//   eventData: { name },
//   operator: { id, name, email, description },
//   fromAnswers: [{ value, field }],
//   contact: { id, name, email, phone, note, address, city, ... tags, properties, subscriberLists }
// }

function extractBooking(body) {
    const contact = body.contact || {};
    const eventData = body.eventData || {};
    const operator = body.operator || {};
    const fromAnswers = body.fromAnswers || [];

    // Extract answers from the booking form (Easy2 fromAnswers array)
    const answersMap = {};
    fromAnswers.forEach(a => {
        if (a.field && a.value) {
            answersMap[a.field.toLowerCase()] = a.value;
        }
    });

    // Prefer contact-level data, fall back to fromAnswers
    const email = contact.email || answersMap['e-mail'] || answersMap['email'] || '';
    const phone = contact.phone || answersMap['telefon'] || answersMap['phone'] || '';
    const name  = contact.name  || answersMap['name']    || answersMap['vorname'] || 'Unknown Contact';

    // Convert unix timestamps to date/time strings for Pipedrive
    let startDate = '';
    let startTime = '';
    let endTime   = '';
    let durationMinutes = 0;

    if (body.start) {
        const startDt = new Date(body.start * 1000);
        startDate = startDt.toISOString().split('T')[0];                  // "2026-05-12"
        startTime = startDt.toISOString().split('T')[1].substring(0, 5);  // "14:30"
    }
    if (body.end) {
        const endDt = new Date(body.end * 1000);
        endTime = endDt.toISOString().split('T')[1].substring(0, 5);
    }
    if (body.start && body.end) {
        durationMinutes = Math.round((body.end - body.start) / 60);
    }

    // Tags from contact
    const tags = (contact.tags || []).join(', ');

    return {
        // Contact
        name:  name || 'Unknown Contact',
        email,
        phone,

        // Event
        service:    eventData.name || 'Booking',
        startDate,
        startTime,
        endTime,
        durationMinutes,

        // Operator (the advisor / team member)
        operatorName:  operator.name || '',
        operatorEmail: operator.email || '',
        operatorDesc:  operator.description || '',

        // Metadata
        bookingId: body.id || '',
        eventId:   body.eventId || '',
        tags,

        // Notes
        notes: contact.note || '',

        // Raw event type from webhook header
        event: 'booking_created',
    };
}

// ── Main Pipedrive save function ──────────────────────────────

async function saveToPipedrive(booking) {
    log('🔄 Saving to Pipedrive — extracted booking data', booking);

    // ── 1. Search for existing person by email to avoid duplicates ──
    let person = null;

    if (booking.email) {
        try {
            const searchResult = await pipedriveGet(`persons/search?term=${encodeURIComponent(booking.email)}&fields=email&limit=1`);
            if (searchResult.success && searchResult.data && searchResult.data.items && searchResult.data.items.length > 0) {
                person = searchResult.data.items[0].item;
                log('🔍 Found existing person in Pipedrive', { id: person.id, name: person.name });
            }
        } catch (err) {
            log('⚠️  Person search failed (will create new)', { error: err.message });
        }
    }

    // ── 2. Create Person if not found ──
    if (!person) {
        const personPayload = {
            name: booking.name || 'Unknown Contact',
        };
        if (booking.email) {
            personPayload.email = [{ value: booking.email, primary: true, label: 'work' }];
        }
        if (booking.phone) {
            personPayload.phone = [{ value: booking.phone, primary: true, label: 'mobile' }];
        }

        person = await pipedrivePost('persons', personPayload);
        log('✅ Person created', { id: person.id, name: person.name });
    }

    // ── 3. Create Deal linked to Person ──
    const dealTitle = booking.service
        ? `${booking.service} — ${booking.name}`
        : `Booking — ${booking.name}`;

    const deal = await pipedrivePost('deals', {
        title: dealTitle,
        person_id: person.id,
    });
    log('✅ Deal created', { id: deal.id, title: deal.title });

    // ── 4. Create Activity (the actual meeting slot) ──
    const activityNote = [
        `📅 Booked via Easy2`,
        `Service: ${booking.service}`,
        booking.operatorName  ? `Berater: ${booking.operatorName}` : '',
        booking.operatorDesc  ? `Rolle: ${booking.operatorDesc}` : '',
        booking.operatorEmail ? `Berater E-Mail: ${booking.operatorEmail}` : '',
        ``,
        `Kontakt E-Mail: ${booking.email}`,
        `Kontakt Telefon: ${booking.phone}`,
        booking.tags   ? `Tags: ${booking.tags}` : '',
        booking.notes  ? `Notizen: ${booking.notes}` : '',
        ``,
        `Booking ID: ${booking.bookingId}`,
        `Event ID: ${booking.eventId}`,
        booking.startTime && booking.endTime ? `Zeit: ${booking.startTime} – ${booking.endTime} (${booking.durationMinutes} Min.)` : '',
    ].filter(Boolean).join('\n');

    const activityPayload = {
        subject: `📅 ${booking.service} — ${booking.name}`,
        type: 'meeting',
        person_id: person.id,
        deal_id: deal.id,
        note: activityNote,
        done: 0,    // 0 = scheduled, not completed
    };

    // Add date/time if available
    if (booking.startDate) activityPayload.due_date = booking.startDate;
    if (booking.startTime) activityPayload.due_time = booking.startTime;
    if (booking.durationMinutes > 0) {
        // Pipedrive expects duration in HH:MM format
        const hours = Math.floor(booking.durationMinutes / 60);
        const mins  = booking.durationMinutes % 60;
        activityPayload.duration = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
    }

    const activity = await pipedrivePost('activities', activityPayload);
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

// ── Webhook handler (shared logic) ──
async function handleWebhook(req, res) {
    console.log('\n' + '🔔'.repeat(30));
    console.log('🚀 WEBHOOK HIT — PROCESSING BOOKING');
    console.log('🔔'.repeat(30));

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
        log('🎉 ALL DONE! Booking saved to Pipedrive successfully', {
            personId:   result.person.id,
            personName: result.person.name,
            dealId:     result.deal.id,
            dealTitle:  result.deal.title,
            activityId: result.activity.id,
        });
    } catch (err) {
        console.error('❌  Error saving to Pipedrive:', err.message);
        console.error(err.stack);
    }
}

// ✅  MAIN WEBHOOK ENDPOINT  — paste this URL into Easy2
app.post('/webhook', handleWebhook);

// ✅  ALSO handle /webhooke (the URL Easy2 is currently hitting — typo in their config)
app.post('/webhooke', handleWebhook);

// Test endpoint — send a fake booking without needing Easy2
app.post('/test', async (req, res) => {
    log('🧪 Test endpoint hit');

    // Simulate the EXACT shape Easy2 sends
    const fakeBooking = {
        id: 999,
        eventId: 99999,
        start: Math.floor(Date.now() / 1000) + 86400,  // tomorrow
        end:   Math.floor(Date.now() / 1000) + 86400 + 900,  // +15 min
        eventData: {
            name: 'Kostenloses Beratungsgespräch pflege-auszahlung.de',
        },
        operator: {
            id: 37330,
            name: 'Matthias Pohl',
            email: 'zamir.koeksal68@gmail.com',
            description: 'Pflegegeld-Berater',
        },
        fromAnswers: [
            { value: 'test@example.com', field: 'E-Mail' },
            { value: '+4912345678', field: 'Telefon' },
        ],
        contact: {
            id: 9999,
            name: 'Test User',
            email: 'test@example.com',
            phone: '+4912345678',
            note: null,
            address: null,
            city: null,
            state: null,
            zip: null,
            country: null,
            companyName: null,
            createdOn: Math.floor(Date.now() / 1000),
            tags: ['Telefonat'],
            properties: [],
            subscribed: false,
            subscriberLists: [],
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
    console.log(`📬  Webhook (alt):    http://localhost:${PORT}/webhooke`);
    console.log(`🧪  Test endpoint:    http://localhost:${PORT}/test  (POST)`);
    console.log(`❤️   Health check:    http://localhost:${PORT}/`);
    console.log('='.repeat(55) + '\n');
});