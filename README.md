# EMWD Water Usage Scraper for Home Assistant

A Dockerized Node.js application that scrapes water usage data from EMWD (Eastern Municipal Water District) customer portal and publishes it to MQTT for Home Assistant integration.

## Features

- 🔐 Secure authentication with EMWD portal
- 📡 MQTT publishing with Home Assistant auto-discovery
- ⏰ Configurable scheduling (default: every 10 minutes)  
- 🐳 Docker containerized for easy deployment
- 🏠 Ready for Home Assistant integration

## Quick Start

1. **Clone and setup**:
   ```bash
   git clone <repository>
   cd emwd-scraper
   cp .env.example .env
   ```

2. **Configure environment**:
   Edit `.env` file with your credentials:
   ```bash
   EMWD_USERNAME=your_username
   EMWD_PASSWORD=your_password
   EMWD_METER_ID=400027755
   MQTT_HOST=10.33.103.125
   ```

3. **Run with Docker**:
   ```bash
   docker-compose up -d
   ```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `EMWD_USERNAME` | - | Your EMWD portal username |
| `EMWD_PASSWORD` | - | Your EMWD portal password |
| `EMWD_METER_ID` | `400027755` | Your water meter ID |
| `MQTT_HOST` | `10.33.103.125` | MQTT broker hostname/IP |
| `MQTT_PORT` | `1883` | MQTT broker port |
| `MQTT_USERNAME` | - | MQTT username (if required) |
| `MQTT_PASSWORD` | - | MQTT password (if required) |
| `MQTT_TOPIC` | `home/sensor/water` | MQTT topic for publishing data |
| `CRON_SCHEDULE` | `*/10 * * * *` | Cron schedule for scraping |
| `TZ` | `America/Los_Angeles` | Timezone |

### Schedule Configuration

The `CRON_SCHEDULE` uses standard cron format:
```
minute hour day month day-of-week
```

Examples:
- `*/10 * * * *` - Every 10 minutes
- `0 */1 * * *` - Every hour
- `0 6,18 * * *` - Twice daily at 6 AM and 6 PM
- `0 6 * * *` - Once daily at 6 AM

## Home Assistant Integration

The scraper automatically publishes Home Assistant discovery configuration. Once running, the sensor should appear automatically in Home Assistant as:

- **Entity**: `sensor.emwd_water_usage`
- **Device**: `EMWD Meter [meter_id]`
- **Unit**: Gallons
- **Device Class**: Water
- **State Class**: Total Increasing

## Data Format

MQTT payload structure:
```json
{
  "timestamp": "2025-01-05T10:30:00.000Z",
  "meterId": "400027755", 
  "usage": [actual_usage_data_from_emwd]
}
```

## Running without Docker

If you prefer to run without Docker:

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Set environment variables**:
   ```bash
   export EMWD_USERNAME=your_username
   export EMWD_PASSWORD=your_password
   # ... other variables
   ```

3. **Run**:
   ```bash
   node index.mjs
   ```

## Troubleshooting

### Common Issues

1. **MQTT connection failed**: Verify MQTT broker IP and port
2. **Login failed**: Check EMWD credentials and meter ID
3. **No data in Home Assistant**: Ensure MQTT integration is enabled

### Logs

View container logs:
```bash
docker-compose logs -f emwd-scraper
```

### Manual Test

Test without scheduling:
```bash
docker run --rm -e EMWD_USERNAME=user -e EMWD_PASSWORD=pass emwd-scraper
```

## Security Notes

⚠️ **Important**: This application contains sensitive credentials. Use environment variables and never commit credentials to version control.

For production deployment:
- Use Docker secrets or external secret management
- Consider running on a secure internal network
- Regularly rotate credentials

## License

MIT License - see LICENSE file for details