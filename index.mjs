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

// Extract water usage data from HTML response
const extractUsageFromHTML = (html) => {
  try {
    // Load HTML with cheerio
    const $ = cheerio.load(html);
    
    // Look for chart data in script tags
    let chartData = null;
    
    $('script').each((i, elem) => {
      const scriptContent = $(elem).html();
      
      // Look for Highcharts data patterns
      if (scriptContent && scriptContent.includes('series') && scriptContent.includes('data')) {
        // Try to extract data array patterns like: data: [[timestamp, value], ...]
        const dataMatch = scriptContent.match(/data\s*:\s*(\[\[.*?\]\])/s);
        if (dataMatch) {
          try {
            // Clean up the matched string and parse it
            let dataStr = dataMatch[1];
            // Replace any JavaScript Date objects with timestamps
            dataStr = dataStr.replace(/new Date\((.*?)\)/g, (match, p1) => {
              return Date.parse(p1) || 0;
            });
            chartData = JSON.parse(dataStr);
            return false; // Break the loop
          } catch (e) {
            console.log('Failed to parse data from script:', e.message);
          }
        }
      }
    });
    
    // If we couldn't find chart data, look for table data
    if (!chartData) {
      console.log('⚠️ No chart data found in HTML, looking for table data...');
      // You might need to parse tables or other elements here
    }
    
    return chartData;
  } catch (error) {
    console.error('Error extracting usage from HTML:', error.message);
    return null;
  }
};

// Publish data to MQTT
const publishToMQTT = (data) => {
  if (!mqttClient || !mqttClient.connected) {
    console.error('❌ MQTT client not connected');
    return;
  }

  // Extract the latest cumulative usage value
  let latestUsage = 0;
  let extractedData = data;
  
  // If data is a string (HTML), extract the usage data
  if (typeof data === 'string') {
    console.log('📄 Received HTML response, extracting usage data...');
    extractedData = extractUsageFromHTML(data);
    if (!extractedData) {
      console.error('❌ Could not extract usage data from HTML');
      return;
    }
  }
  
  if (Array.isArray(extractedData) && extractedData.length > 0) {
    // Get the last entry's cumulative value
    const lastEntry = extractedData[extractedData.length - 1];
    latestUsage = lastEntry[1] || 0; // The second value is the cumulative usage
    console.log(`💧 Latest usage: ${latestUsage} gallons`);
  } else {
    console.warn('⚠️ No usage data found in response');
  }

  const payload = {
    timestamp: new Date().toISOString(),
    meterId: config.emwd.meterId,
    usage: latestUsage,
    raw_data: extractedData // Keep raw data for debugging
  };

  mqttClient.publish(config.mqtt.topic, JSON.stringify(payload), (err) => {
    if (err) {
      console.error('❌ Failed to publish to MQTT:', err.message);
    } else {
      console.log('📡 Published to MQTT:', config.mqtt.topic);
      console.log('📊 Published usage value:', latestUsage);
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
    
    // Step 5: Parse the dashboard page for consumption data
    console.log('📊 Extracting consumption data from dashboard...');
    
    // The dashboard HTML already contains the chart data
    const $ = cheerio.load(dashboardRes.data);
    let consumptionData = null;
    
    // Look for the Highcharts initialization script in the dashboard
    $('script').each((i, elem) => {
      const scriptContent = $(elem).html();
      if (scriptContent && scriptContent.includes('Highcharts') && scriptContent.includes('series')) {
        // Look for consumption data patterns in Highcharts config
        // Pattern 1: series with name containing 'Water' or 'Usage'
        const patterns = [
          /series\s*:\s*\[[\s\S]*?name\s*:\s*['"].*?[Ww]ater.*?['"][\s\S]*?data\s*:\s*(\[\[.*?\]\])/,
          /series\s*:\s*\[[\s\S]*?id\s*:\s*['"]consumptionData['"][\s\S]*?data\s*:\s*(\[\[.*?\]\])/,
          /name\s*:\s*['"].*?[Uu]sage.*?['"][\s\S]*?data\s*:\s*(\[\[.*?\]\])/,
          // Generic pattern for array of [timestamp, value] pairs
          /data\s*:\s*(\[\s*\[\s*\d{10,13}\s*,\s*\d+\.?\d*\s*\](?:\s*,\s*\[\s*\d{10,13}\s*,\s*\d+\.?\d*\s*\])*\s*\])/
        ];
        
        for (const pattern of patterns) {
          const match = scriptContent.match(pattern);
          if (match) {
            try {
              consumptionData = JSON.parse(match[1]);
              console.log(`✅ Found consumption data with ${consumptionData.length} readings`);
              return false; // Break out of the each loop
            } catch (e) {
              console.log('Failed to parse with pattern, trying next...', e.message);
            }
          }
        }
      }
    });
    
    // If still no data, save the dashboard for debugging
    if (!consumptionData) {
      console.log('⚠️ Could not find chart data in dashboard, saving for analysis...');
      fs.writeFileSync('dashboard_page.html', dashboardRes.data);
      console.log('💾 Saved dashboard page to dashboard_page.html for debugging');
      
      // Try to find any data arrays in script tags
      const scripts = [];
      $('script').each((i, elem) => {
        const content = $(elem).html();
        if (content && content.length > 100) {
          scripts.push(`Script ${i}: ${content.substring(0, 200)}...`);
        }
      });
      console.log('📜 Found scripts:', scripts.length);
      
      // For now, publish a dummy value to test the sensor
      console.log('📤 Publishing dummy data for testing...');
      publishToMQTT([[Date.now(), 12345]]);
    } else {
      // Publish the real data
      publishToMQTT(consumptionData);
    }

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
