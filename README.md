# easy2

Easy2 → Pipedrive Webhook Server

Receives booking events from Easy2 calendar and automatically saves them to Pipedrive CRM (Person + Deal + Activity).

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in your Pipedrive credentials
3. `npm start`

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check |
| POST | `/webhook` | Main webhook — point Easy2 here |
| POST | `/test` | Send a fake booking to test Pipedrive integration |
