import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import mqtt from 'mqtt';
import cron from 'node-cron';

// Configuration from environment variables
const config = {
  emwd: {
    username: process.env.EMWD_USERNAME,
    password: process.env.EMWD_PASSWORD,
    meterId: process.env.EMWD_METER_ID || '400027755',
    loginUrl: 'https://myaccount.emwd.org/app/capricorn?para=index'
  },
  mqtt: {
    host: process.env.MQTT_HOST || '10.33.103.125',
    port: parseInt(process.env.MQTT_PORT || '1883'),
    username: process.env.MQTT_USERNAME || '',
    password: process.env.MQTT_PASSWORD || '',
    topic: process.env.MQTT_TOPIC || 'home/sensor/water'
  },
  schedule: process.env.CRON_SCHEDULE || '*/10 * * * *' // Every 10 minutes
};

let mqttClient;

// Initialize MQTT connection
const connectMQTT = () => {
  const mqttUrl = `mqtt://${config.mqtt.host}:${config.mqtt.port}`;
  const options = {};
  
  if (config.mqtt.username) {
    options.username = config.mqtt.username;
    options.password = config.mqtt.password;
  }

  mqttClient = mqtt.connect(mqttUrl, options);
  
  mqttClient.on('connect', () => {
    console.log('📡 Connected to MQTT broker');
    // Publish Home Assistant discovery config on connect
    setTimeout(publishHADiscovery, 1000); // Small delay to ensure connection is stable
  });
  
  mqttClient.on('error', (err) => {
    console.error('❌ MQTT connection error:', err.message);
  });
};

// Publish Home Assistant discovery config
const publishHADiscovery = () => {
  if (!mqttClient || !mqttClient.connected) return;

  const deviceId = `emwd_meter_${config.emwd.meterId}`;
  const discoveryTopic = `homeassistant/sensor/${deviceId}/config`;
  
  const discoveryConfig = {
    name: "EMWD Water Usage",
    unique_id: deviceId,
    state_topic: config.mqtt.topic,
    value_template: "{{ value_json.usage }}",
    unit_of_measurement: "gal",
    device_class: "water",
    state_class: "total_increasing",
    device: {
      identifiers: [deviceId],
      name: `EMWD Meter ${config.emwd.meterId}`,
      manufacturer: "Eastern Municipal Water District",
      model: "Smart Water Meter"
    }
  };

  mqttClient.publish(discoveryTopic, JSON.stringify(discoveryConfig), { retain: true }, (err) => {
    if (err) {
      console.error('❌ Failed to publish HA discovery:', err.message);
    } else {
      console.log('🏠 Published Home Assistant discovery config');
    }
  });
};

// Publish data to MQTT
const publishToMQTT = (data) => {
  if (!mqttClient || !mqttClient.connected) {
    console.error('❌ MQTT client not connected');
    return;
  }

  const payload = {
    timestamp: new Date().toISOString(),
    meterId: config.emwd.meterId,
    usage: data
  };

  mqttClient.publish(config.mqtt.topic, JSON.stringify(payload), (err) => {
    if (err) {
      console.error('❌ Failed to publish to MQTT:', err.message);
    } else {
      console.log('📡 Published to MQTT:', config.mqtt.topic);
    }
  });
};

const scrapeData = async () => {
  try {
    console.log('🌐 Starting EMWD scrape...');
    // Step 0: First visit to establish initial session (like opening incognito)
    const initialVisit = await axios.get('https://myaccount.emwd.org/app/login.jsp', {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',  
        'Pragma': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"'
      }
    });

    console.log('Initial visit cookies:', initialVisit.headers['set-cookie']);
    
    // Collect initial cookies
    const initialCookies = initialVisit.headers['set-cookie'] || [];
    const initialCookieStr = initialCookies
      .map(c => c.split(';')[0])
      .join('; ');

    // Step 1: Get CSRF token (now with initial cookies)
    const loginPage = await axios.get(config.emwd.loginUrl, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Cookie': initialCookieStr,
        'Pragma': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate', 
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"'
      }
    });

    const $ = cheerio.load(loginPage.data);
    const token = $('input[name=jspCSRFToken]').val();
    console.log('🔑 CSRF token extracted:', token);
    if (!token) throw new Error('CSRF token not found');
    
    console.log('Login page response length:', loginPage.data.length);
    console.log('Login page cookies:', loginPage.headers['set-cookie']);

    // Use the LATEST cookies from login page (not initial visit)
    const loginPageCookies = loginPage.headers['set-cookie'] || [];
    console.log('Using cookies from login page:', loginPageCookies);
    
    const combinedCookieStr = loginPageCookies
      .map(c => c.split(';')[0])
      .filter(c => !c.includes('Max-Age=0')) // Filter out deleted cookies
      .join('; ');

    console.log('Combined cookies for login:', combinedCookieStr);

    // Step 2: Log in and get raw set-cookie headers
    const postData = {
      jspCSRFToken: token,
      accessCode: config.emwd.username,
      password: config.emwd.password,
      nextPara: '',
      nextPara_attr1: ''
    };
    console.log('📤 Login POST data:', postData);
    
    const loginRes = await axios.post(config.emwd.loginUrl, new URLSearchParams(postData).toString(), {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': combinedCookieStr,
        'Origin': 'https://myaccount.emwd.org',
        'Pragma': 'no-cache',
        'Referer': 'https://myaccount.emwd.org/app/login.jsp',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"'
      },
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400
    });

    // Step 3: Debug login response and build Cookie header
    console.log('\n🔍 Login response debug:');
    console.log('Status:', loginRes.status);
    console.log('Headers:', JSON.stringify(loginRes.headers, null, 2));
    console.log('Raw Set-Cookie headers:', loginRes.headers['set-cookie']);
    console.log('Response body length:', loginRes.data.length);
    console.log('Response body preview:', loginRes.data.substring(0, 500));
    
    // Check if this is an error page by looking for error messages
    if (loginRes.data.includes('session has expired') || loginRes.data.includes('Session Expired')) {
      console.log('🚨 Login failed: Session expired message detected');
    }
    if (loginRes.data.includes('Invalid') || loginRes.data.includes('error') || loginRes.data.includes('Error')) {
      console.log('🚨 Login may have failed: Error message detected');
    }
    
    // Look for successful login indicators
    if (loginRes.data.includes('dashboard') || loginRes.data.includes('Welcome') || loginRes.data.includes('My Account')) {
      console.log('✅ Login may have succeeded: Dashboard content detected');
    }
    
    // Save the full login response for analysis
    fs.writeFileSync('login_response.html', loginRes.data);
    console.log('💾 Saved full login response to login_response.html');
    
    // Look for localStorage or session setup in the response
    if (loginRes.data.includes('localStorage')) {
      console.log('\n🔍 Found localStorage references in login response!');
      const localStorageMatches = loginRes.data.match(/localStorage[^;]*;/g);
      if (localStorageMatches) {
        console.log('localStorage statements:', localStorageMatches);
      }
    }
    
    // Look for any JavaScript that might set session data
    const scriptMatches = loginRes.data.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    if (scriptMatches) {
      console.log('\n🔍 Found', scriptMatches.length, 'script tags in login response');
      scriptMatches.forEach((script, i) => {
        if (script.includes('localStorage') || script.includes('sessionStorage') || script.includes('setItem')) {
          console.log(`Script ${i + 1} contains storage operations:`, script.substring(0, 200) + '...');
        }
      });
    }
    
    const rawSetCookies = loginRes.headers['set-cookie'] || [];
    
    // Combine all cookies: login page + login response  
    const allCookies = [...loginPageCookies, ...rawSetCookies];
    const cookieMap = new Map();
    
    // Process cookies in order, letting later ones override earlier ones
    allCookies.forEach(cookieStr => {
      const [keyValue] = cookieStr.split(';');
      const [key, value] = keyValue.split('=');
      if (key && value !== undefined) {
        cookieMap.set(key.trim(), keyValue.trim());
      }
    });
    
    const cookieStr = Array.from(cookieMap.values()).join('; ');

    console.log('\n✅ Login successful! All cookies:');
    console.log(`Cookie: ${cookieStr}\n`);
    
    // Check if we need to follow redirects or make intermediate requests
    if (loginRes.status >= 300 && loginRes.status < 400) {
      console.log('🔄 Redirect detected, Location:', loginRes.headers.location);
    }

    // Manually set capricornWCMid to username since server is clearing it
    let updatedCookieStr = cookieStr.replace('capricornWCMid=', `capricornWCMid=${config.emwd.username}`);
    
    // Add some basic tracking cookies that might be required
    const timestamp = Date.now();
    const trackingCookies = [
      `_ga=GA1.1.${Math.floor(Math.random() * 1000000000)}.${Math.floor(timestamp/1000)}`,
      `_ga_9WV8SZK6XB=GS2.1.s${Math.floor(timestamp/1000)}$o1$g0$t${Math.floor(timestamp/1000)}$j60$l0$h0`,
      `vxu=UBNJIPwTN137Nytopp3aKg`,
      `vxr=52.7`,
      `vxp=1`
    ];
    
    updatedCookieStr += '; ' + trackingCookies.join('; ');
    
    console.log('Final cookie string:', updatedCookieStr);

    // Step 4: Visit the main dashboard first (natural browser flow after login)
    console.log('🏠 Visiting main dashboard to establish session...\n');
    
    const dashboardUrl = 'https://myaccount.emwd.org/app/capricorn?para=smartMeterConsum&inquiryType=water&tab=WATSMCON';
    
    const dashboardRes = await axios.get(dashboardUrl, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Cookie': updatedCookieStr,
        'Pragma': 'no-cache',
        'Referer': config.emwd.loginUrl,
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"'
      }
    });

    console.log('Dashboard response status:', dashboardRes.status);
    console.log('Dashboard response length:', dashboardRes.data.length);
    
    // Check if dashboard loaded successfully (should be much larger than session expired page)
    if (dashboardRes.data.length < 5000) {
      console.log('⚠️  Dashboard response seems too small, might be session expired');
      console.log('Dashboard response preview:', dashboardRes.data.substring(0, 500));
      return;
    }

    console.log('✅ Dashboard loaded successfully!\n');

    // Step 5: Now use the cookies to fetch usage data
    const usageUrl = `https://myaccount.emwd.org/app/capricorn?para=editCustomEvents&meterId=${config.emwd.meterId}&viewInChart=TOU&onSeriesID=consumptionData&_=${Date.now()}`;
    
    console.log('🔄 Fetching usage data...\n');
    
    const usageRes = await axios.get(usageUrl, {
      headers: {
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Cookie': updatedCookieStr,
        'Pragma': 'no-cache',
        'Referer': 'https://myaccount.emwd.org/app/capricorn?para=smartMeterConsum&inquiryType=water&tab=WATSMCON',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest',
        'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"'
      }
    });

    console.log('📊 Usage data response:');
    console.log('Status:', usageRes.status);
    console.log('Content-Type:', usageRes.headers['content-type']);
    console.log('Data length:', typeof usageRes.data === 'string' ? usageRes.data.length : JSON.stringify(usageRes.data).length);
    console.log('\n📋 Response data:');
    console.log(typeof usageRes.data === 'object' ? JSON.stringify(usageRes.data, null, 2) : usageRes.data);

    // Publish to MQTT
    publishToMQTT(usageRes.data);

  } catch (err) {
    console.error('💥 Error:', err.message);
  }
};

// Main execution
const main = () => {
  console.log('🚀 Starting EMWD Water Usage Scraper');
  console.log(`📅 Schedule: ${config.schedule}`);
  console.log(`🏠 MQTT: ${config.mqtt.host}:${config.mqtt.port} -> ${config.mqtt.topic}`);
  console.log(`💧 Meter ID: ${config.emwd.meterId}\n`);

  // Connect to MQTT
  connectMQTT();

  // Run immediately on startup
  scrapeData();

  // Schedule regular runs
  cron.schedule(config.schedule, () => {
    console.log('\n⏰ Scheduled scrape starting...');
    scrapeData();
  });

  console.log('✅ Scheduler started successfully');
};

main();
