require('dotenv').config();
const axios = require('axios');

const CALENDLY_TOKEN = process.env.CALENDLY_ACCESS_TOKEN;
const SERVER_URL = process.argv[2]; // Passed from command line

if (!CALENDLY_TOKEN || CALENDLY_TOKEN === 'your_calendly_personal_access_token') {
    console.error('❌ Error: Please set CALENDLY_ACCESS_TOKEN in your .env file.');
    process.exit(1);
}

if (!SERVER_URL) {
    console.error('❌ Error: Please provide your public server URL.');
    console.log('Usage: node setup-webhook.js https://your-domain.com');
    process.exit(1);
}

async function setupWebhook() {
    try {
        // 1. Get the current user's organization URI
        console.log('Fetching your Calendly organization details...');
        const userRes = await axios.get('https://api.calendly.com/users/me', {
            headers: { Authorization: `Bearer ${CALENDLY_TOKEN}` }
        });
        const organizationUri = userRes.data.resource.current_organization;

        // 2. Register the webhook
        console.log(`Registering webhook for URL: ${SERVER_URL}/webhook/calendly ...`);
        const webhookRes = await axios.post('https://api.calendly.com/webhook_subscriptions', {
            url: `${SERVER_URL}/webhook/calendly`,
            events: ["invitee.created"],
            organization: organizationUri,
            scope: "organization"
        }, {
            headers: { Authorization: `Bearer ${CALENDLY_TOKEN}` }
        });

        console.log('✅ Success! Webhook subscribed.');
        console.log('Subscription Details:', webhookRes.data.resource);

    } catch (error) {
        console.error('❌ Failed to setup webhook.');
        console.error(error.response?.data || error.message);
    }
}

setupWebhook();
