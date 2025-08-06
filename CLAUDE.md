# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Dockerized Node.js web scraper for the EMWD (Eastern Municipal Water District) portal that publishes water usage data to MQTT for Home Assistant integration. The project authenticates with the EMWD customer portal, fetches water usage data, and publishes it via MQTT with Home Assistant auto-discovery.

## Architecture

- **Main application**: `index.mjs` - handles authentication, scraping, MQTT publishing, and scheduling
- **ES modules**: Uses `.mjs` extension and ES6 import syntax
- **Docker**: Containerized with Dockerfile and docker-compose.yml
- **Scheduling**: Built-in cron scheduler using node-cron package
- **MQTT Integration**: Publishes to MQTT broker with Home Assistant auto-discovery

## Dependencies

The project uses:
- `axios` - HTTP client with cookie handling
- `cheerio` - Server-side jQuery-like HTML parsing
- `mqtt` - MQTT client for publishing data
- `node-cron` - Cron-like scheduler for Node.js

## Core Workflow

The scraper follows this process:
1. Connects to MQTT broker and publishes Home Assistant discovery configs for both sensors
2. Establishes initial session by visiting login page
3. Fetches the login page to extract CSRF token from `jspCSRFToken` input field
4. Performs form-based login with credentials and CSRF token
5. Extracts and formats session cookies from the login response
6. Fetches daily usage dashboard (`para=smartMeterConsum&inquiryType=water&tab=WATSMCON`)
7. Parses the dashboard HTML to extract Highcharts configuration containing daily usage data
8. Fetches hourly usage dashboard (`para=smartMeterConsum&inquiryType=water&tab=WATSMCON&type=hourly`)
9. Parses the dashboard HTML to extract Highcharts configuration containing hourly usage data
10. Converts both datasets from cubic feet to gallons (1 CF = 7.48052 gallons)
11. Publishes daily data to `home/sensor/water/daily` with last 7 days of history
12. Publishes hourly data to `home/sensor/water/hourly` with last 24 hours of history
13. Repeats on schedule (default: every 10 minutes)

## Configuration

All configuration is via environment variables:
- `EMWD_USERNAME` - EMWD portal username
- `EMWD_PASSWORD` - EMWD portal password  
- `EMWD_METER_ID` - Water meter ID (default: 400027755)
- `MQTT_HOST` - MQTT broker host (default: 10.33.103.125)
- `MQTT_PORT` - MQTT broker port (default: 1883)
- `MQTT_USERNAME` - MQTT username (optional)
- `MQTT_PASSWORD` - MQTT password (optional)
- `MQTT_TOPIC_DAILY` - MQTT topic for daily data (default: home/sensor/water/daily)
- `MQTT_TOPIC_HOURLY` - MQTT topic for hourly data (default: home/sensor/water/hourly)
- `CRON_SCHEDULE` - Cron schedule expression (default: */10 * * * *)

## Running the Application

### With Docker (recommended):
```bash
cp .env.example .env
# Edit .env with credentials
docker-compose up -d
```

### Without Docker:
```bash
npm install
export EMWD_USERNAME=your_username
export EMWD_PASSWORD=your_password
node index.mjs
```

## Home Assistant Integration

The scraper automatically publishes Home Assistant discovery configuration on startup for two sensors:

**Daily Usage Sensor:**
- Entity: `sensor.emwd_water_usage_daily`
- Device: `EMWD Meter [meter_id]`
- Unit: Gallons
- Device Class: Water
- State Class: Total Increasing
- Topic: `home/sensor/water/daily`

**Hourly Usage Sensor:**
- Entity: `sensor.emwd_water_usage_hourly`
- Device: `EMWD Meter [meter_id]`
- Unit: Gallons
- Device Class: Water
- State Class: Measurement
- Topic: `home/sensor/water/hourly`

## API Endpoints

- **Initial Session**: `https://myaccount.emwd.org/app/login.jsp`
- **Login Page**: `https://myaccount.emwd.org/app/capricorn?para=index`
- **Daily Dashboard**: `https://myaccount.emwd.org/app/capricorn?para=smartMeterConsum&inquiryType=water&tab=WATSMCON`
- **Hourly Dashboard**: `https://myaccount.emwd.org/app/capricorn?para=smartMeterConsum&inquiryType=water&tab=WATSMCON&type=hourly`

## Data Extraction

The scraper extracts water usage data from the Highcharts configuration embedded in the dashboard HTML:

- **Data Source**: Highcharts series with `name: "Usage"` 
- **Format**: Array of daily usage values in cubic feet
- **Categories**: Array of date strings (YYYY-MM-DD format)
- **Conversion**: 1 cubic foot = 7.48052 gallons
- **Output**: Latest daily usage in gallons plus 7-day history

### Sample MQTT Payload:
```json
{
  "timestamp": "2025-08-06T05:52:00.000Z",
  "meterId": "400027755", 
  "usage": 217,
  "date": "2025-08-04",
  "usage_cf": 29,
  "recent_data": [
    {"date": "2025-07-29", "usage_cf": 61, "usage_gallons": 456},
    {"date": "2025-07-30", "usage_cf": 124, "usage_gallons": 928},
    {"date": "2025-07-31", "usage_cf": 61, "usage_gallons": 456},
    {"date": "2025-08-01", "usage_cf": 37, "usage_gallons": 277},
    {"date": "2025-08-02", "usage_cf": 80, "usage_gallons": 598},
    {"date": "2025-08-03", "usage_cf": 90, "usage_gallons": 673},
    {"date": "2025-08-04", "usage_cf": 29, "usage_gallons": 217}
  ]
}

## Development Notes

- No build process required - runs directly with Node.js
- No test framework configured
- No linting configuration present
- Uses URLSearchParams for form encoding
- Implements custom cookie parsing from Set-Cookie headers
- Includes health check in Docker container
- Runs as non-root user in container for security
- Schedule managed by node-cron within the Node.js process

## Troubleshooting

### Common Issues:
1. **Sensor shows "unavailable"**: Check MQTT connection and credentials
2. **Wrong usage values**: Ensure unit conversion is working (CF → gallons)
3. **Login failures**: Verify EMWD credentials in .env file
4. **Session expired**: Dashboard response will be small (~1-2KB vs normal ~66KB)

### Testing Locally:
```bash
# Install dependencies
npm install

# Set credentials and run
EMWD_USERNAME=your_username EMWD_PASSWORD=your_password node index.mjs
```

### Debug Files:
- `dashboard_page.html` - Saved when data extraction fails
- `login_response.html` - Saved during login process for debugging

### Schedule Configuration:
- Default: `*/10 * * * *` (every 10 minutes)
- Hourly: `0 * * * *`
- Every 5 minutes: `*/5 * * * *`
- Twice daily: `0 9,21 * * *`