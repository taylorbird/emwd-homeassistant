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
1. Connects to MQTT broker and publishes Home Assistant discovery config
2. Fetches the login page to extract CSRF token from `jspCSRFToken` input field
3. Performs form-based login with credentials and CSRF token
4. Extracts and formats session cookies from the login response
5. Uses the authenticated session to fetch usage data from the smart meter API endpoint
6. Publishes usage data to MQTT topic
7. Repeats on schedule (default: every 10 minutes)

## Configuration

All configuration is via environment variables:
- `EMWD_USERNAME` - EMWD portal username
- `EMWD_PASSWORD` - EMWD portal password  
- `EMWD_METER_ID` - Water meter ID (default: 400027755)
- `MQTT_HOST` - MQTT broker host (default: 10.33.103.125)
- `MQTT_PORT` - MQTT broker port (default: 1883)
- `MQTT_USERNAME` - MQTT username (optional)
- `MQTT_PASSWORD` - MQTT password (optional)
- `MQTT_TOPIC` - MQTT topic for publishing (default: home/sensor/water)
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

The scraper automatically publishes Home Assistant discovery configuration on startup. The water usage sensor will appear as:
- Entity: `sensor.emwd_water_usage`
- Device: `EMWD Meter [meter_id]`
- Unit: Gallons
- Device Class: Water
- State Class: Total Increasing

## API Endpoints

- **Login**: `https://myaccount.emwd.org/app/capricorn?para=index`
- **Usage Data**: `https://myaccount.emwd.org/app/capricorn?para=editCustomEvents&meterId={meterId}&viewInChart=TOU&onSeriesID=consumptionData&_={timestamp}`

## Development Notes

- No build process required - runs directly with Node.js
- No test framework configured
- No linting configuration present
- Uses URLSearchParams for form encoding
- Implements custom cookie parsing from Set-Cookie headers
- Includes health check in Docker container
- Runs as non-root user in container for security
- Schedule managed by node-cron within the Node.js process