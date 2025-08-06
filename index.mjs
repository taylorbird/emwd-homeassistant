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
    topicDaily: process.env.MQTT_TOPIC_DAILY || 'home/sensor/water/daily',
    topicHourly: process.env.MQTT_TOPIC_HOURLY || 'home/sensor/water/hourly'
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
    // Publish Home Assistant discovery configs on connect
    setTimeout(() => {
      publishHADiscovery('daily');
      publishHADiscovery('hourly');
    }, 1000); // Small delay to ensure connection is stable
  });
  
  mqttClient.on('error', (err) => {
    console.error('❌ MQTT connection error:', err.message);
  });
};

// Publish Home Assistant discovery config for both sensors
const publishHADiscovery = (dataType) => {
  if (!mqttClient || !mqttClient.connected) return;

  const sensorType = dataType === 'hourly' ? 'hourly' : 'daily';
  const deviceId = `emwd_meter_${config.emwd.meterId}_${sensorType}`;
  const discoveryTopic = `homeassistant/sensor/${deviceId}/config`;
  
  const discoveryConfig = {
    name: `EMWD Water Usage (${sensorType === 'hourly' ? 'Hourly' : 'Daily'})`,
    unique_id: deviceId,
    state_topic: sensorType === 'hourly' ? config.mqtt.topicHourly : config.mqtt.topicDaily,
    value_template: "{{ value_json.usage }}",
    unit_of_measurement: "gal",
    device_class: "water",
    state_class: sensorType === 'hourly' ? "measurement" : "total_increasing",
    device: {
      identifiers: [`emwd_meter_${config.emwd.meterId}`],
      name: `EMWD Meter ${config.emwd.meterId}`,
      manufacturer: "Eastern Municipal Water District",
      model: "Smart Water Meter",
      sw_version: "Dual Mode (Daily + Hourly)"
    },
    json_attributes_topic: sensorType === 'hourly' ? config.mqtt.topicHourly : config.mqtt.topicDaily,
    json_attributes_template: "{{ {'data_type': value_json.data_type, 'timestamp': value_json.data_timestamp, 'usage_cf': value_json.usage_cf} | tojson }}"
  };

  mqttClient.publish(discoveryTopic, JSON.stringify(discoveryConfig), { retain: true }, (err) => {
    if (err) {
      console.error(`❌ Failed to publish HA discovery for ${sensorType}:`, err.message);
    } else {
      console.log(`🏠 Published Home Assistant discovery config for ${sensorType} sensor`);
    }
  });
};

// Extract water usage data from dashboard HTML
const extractUsageFromDashboard = (html, expectedType = null) => {
  try {
    const $ = cheerio.load(html);
    let categories = null;
    let usageData = null;
    let chartTitle = null;
    let chartFound = false;
    
    // Look for the Highcharts configuration script
    $('script').each((i, elem) => {
      const script = $(elem).html();
      if (!script) return;
      
      // Check for Highcharts in multiple formats
      if (script.includes('Highcharts.Chart') || script.includes('Highcharts.chart') || script.includes('new Highcharts')) {
        chartFound = true;
        console.log(`🔍 Found Highcharts in script block ${i + 1}`);
        
        // Extract chart title to know if it's hourly or daily
        const titleMatch = script.match(/title\s*:\s*{[^}]*text\s*:\s*["']([^"']+)["']/);
        if (titleMatch) {
          chartTitle = titleMatch[1];
          console.log(`📊 Chart title: "${chartTitle}"`);
        }
        
        // Extract categories (dates for daily, hours for hourly) - try multiple patterns
        let categoriesMatch = script.match(/categories\s*:\s*(\[[\s\S]*?\])/);
        if (!categoriesMatch) {
          // Try alternative pattern for categories in xAxis
          categoriesMatch = script.match(/xAxis\s*:\s*{[^}]*categories\s*:\s*(\[[\s\S]*?\])/);
        }
        
        if (categoriesMatch) {
          try {
            // Replace single quotes with double quotes for valid JSON
            const validJson = categoriesMatch[1].replace(/'/g, '"');
            categories = JSON.parse(validJson);
            const isHourly = (chartTitle && chartTitle.toLowerCase().includes('hourly')) || 
                           (categories.length > 0 && (categories[0].includes('AM') || categories[0].includes('PM')));
            if (isHourly) {
              console.log(`✅ Found ${categories.length} hourly data points`);
              if (categories.length > 0) {
                console.log(`   First: ${categories[0]}, Last: ${categories[categories.length-1]}`);
              }
            } else {
              console.log(`✅ Found ${categories.length} dates from ${categories[0]} to ${categories[categories.length-1]}`);
            }
          } catch (e) {
            console.error('Failed to parse categories:', e.message);
            console.log('Raw categories string:', categoriesMatch[1].substring(0, 200));
          }
        } else {
          console.log('⚠️ No categories found in this script block');
        }
        
        // Extract usage data from the "Usage" series - try multiple patterns
        let usageMatch = script.match(/name\s*:\s*["']Usage["'][\s\S]*?data\s*:\s*(\[[^\]]+\])/);
        if (!usageMatch) {
          // Try without quotes around Usage
          usageMatch = script.match(/name\s*:\s*Usage[\s\S]*?data\s*:\s*(\[[^\]]+\])/);
        }
        if (!usageMatch) {
          // Try to find any series data
          usageMatch = script.match(/series\s*:\s*\[[\s\S]*?data\s*:\s*(\[[^\]]+\])/);
        }
        
        if (usageMatch) {
          try {
            usageData = JSON.parse(usageMatch[1]);
            console.log(`✅ Found ${usageData.length} usage values (in cubic feet)`);
          } catch (e) {
            console.error('Failed to parse usage data:', e.message);
            console.log('Raw usage data string:', usageMatch[1].substring(0, 200));
          }
        } else {
          console.log('⚠️ No usage data found in this script block');
        }
      }
    });
    
    if (!chartFound) {
      console.log('❌ No Highcharts configuration found in HTML');
      // Save a snippet of the HTML for debugging
      console.log('HTML preview:', html.substring(0, 1000));
    }
    
    if (categories && usageData && categories.length === usageData.length) {
      // Convert from cubic feet to gallons and combine with timestamps
      const CF_TO_GALLONS = 7.48052;
      
      const isHourly = chartTitle && chartTitle.toLowerCase().includes('hourly');
      
      // Validate that we got the expected type of data
      if (expectedType && ((expectedType === 'hourly') !== isHourly)) {
        console.warn(`⚠️ Expected ${expectedType} data but got ${isHourly ? 'hourly' : 'daily'} data`);
      }
      
      const combinedData = categories.map((timestamp, i) => ({
        timestamp: timestamp,  // Will be hour (e.g., "12:00 AM") for hourly or date for daily
        usage_cf: usageData[i],
        usage_gallons: Math.round(usageData[i] * CF_TO_GALLONS),
        type: isHourly ? 'hourly' : 'daily'
      }));
      
      return combinedData;
    }
    
    return null;
  } catch (error) {
    console.error('Error extracting usage from dashboard:', error.message);
    return null;
  }
};

// Publish data to MQTT
const publishToMQTT = (data, dataType) => {
  if (!mqttClient || !mqttClient.connected) {
    console.error('❌ MQTT client not connected');
    return;
  }

  let latestUsage = 0;
  let extractedData = data;
  
  // If data is a string (HTML), extract the usage data from dashboard
  if (typeof data === 'string') {
    console.log(`📄 Received HTML response for ${dataType} data, extracting usage data...`);
    extractedData = extractUsageFromDashboard(data, dataType);
    if (!extractedData) {
      console.error(`❌ Could not extract ${dataType} usage data from HTML`);
      return;
    }
  }
  
  if (Array.isArray(extractedData) && extractedData.length > 0) {
    // Get the latest usage in gallons from the extracted dashboard data
    const lastEntry = extractedData[extractedData.length - 1];
    latestUsage = lastEntry.usage_gallons || 0;
    const timeLabel = lastEntry.type === 'hourly' ? 'hour' : 'date';
    console.log(`💧 Latest ${dataType} usage: ${lastEntry.usage_cf} CF = ${latestUsage} gallons (${timeLabel}: ${lastEntry.timestamp})`);
  } else {
    console.warn(`⚠️ No ${dataType} usage data found in response`);
    return;
  }

  const payload = {
    timestamp: new Date().toISOString(),
    meterId: config.emwd.meterId,
    usage: latestUsage,
    data_timestamp: extractedData[extractedData.length - 1]?.timestamp,
    usage_cf: extractedData[extractedData.length - 1]?.usage_cf,
    data_type: extractedData[extractedData.length - 1]?.type || 'unknown',
    recent_data: dataType === 'hourly' 
      ? extractedData.slice(-24) // Last 24 hours for hourly data
      : extractedData.slice(-7)   // Last 7 days for daily data
  };

  const topic = dataType === 'hourly' ? config.mqtt.topicHourly : config.mqtt.topicDaily;
  
  mqttClient.publish(topic, JSON.stringify(payload), (err) => {
    if (err) {
      console.error(`❌ Failed to publish ${dataType} data to MQTT:`, err.message);
    } else {
      console.log(`📡 Published ${dataType} data to MQTT:`, topic);
      console.log(`📊 Published ${dataType} usage value:`, latestUsage, 'gallons');
    }
  });
};

// Fetch dashboard data with authentication cookies
const fetchDashboardData = async (cookieStr, dataType = 'daily') => {
  try {
    console.log(`\n📊 Fetching ${dataType} usage data...`);
    
    // Build URL based on data type
    const baseUrl = 'https://myaccount.emwd.org/app/capricorn?para=smartMeterConsum&inquiryType=water&tab=WATSMCON';
    
    // For hourly data, we need to specify a day parameter (using yesterday's date)
    let dashboardUrl = baseUrl;
    if (dataType === 'hourly') {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const dayParam = yesterday.toISOString().split('T')[0]; // Format: YYYY-MM-DD
      dashboardUrl = `${baseUrl}&type=hourly&day=${dayParam}&selectedMeterId=${config.emwd.meterId}&selectedRegisterNumber=`;
      console.log(`📅 Fetching hourly data for date: ${dayParam}`);
    }
    
    const dashboardRes = await axios.get(dashboardUrl, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Cookie': cookieStr,
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

    console.log(`${dataType} dashboard response status:`, dashboardRes.status);
    console.log(`${dataType} dashboard response length:`, dashboardRes.data.length);
    
    // Check if dashboard loaded successfully (should be much larger than session expired page)
    if (dashboardRes.data.length < 5000) {
      console.log(`⚠️ ${dataType} dashboard response seems too small, might be session expired`);
      console.log('Dashboard response preview:', dashboardRes.data.substring(0, 500));
      return null;
    }

    console.log(`✅ ${dataType} dashboard loaded successfully!`);
    
    // Save hourly dashboard for debugging if extraction fails
    if (dataType === 'hourly') {
      fs.writeFileSync('hourly_dashboard.html', dashboardRes.data);
      console.log('💾 Saved hourly dashboard to hourly_dashboard.html for debugging');
    }
    
    // Extract and publish the data
    publishToMQTT(dashboardRes.data, dataType);
    
    return dashboardRes.data;
    
  } catch (error) {
    console.error(`❌ Error fetching ${dataType} dashboard:`, error.message);
    return null;
  }
};

const scrapeData = async () => {
  try {
    console.log('🌐 Starting EMWD scrape (daily + hourly data)...');
    
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

    const $loginPage = cheerio.load(loginPage.data);
    const token = $loginPage('input[name=jspCSRFToken]').val();
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

    // Step 4: Fetch both daily and hourly data
    console.log('🏠 Fetching water usage data from dashboard...\n');
    
    // Fetch daily data first
    await fetchDashboardData(updatedCookieStr, 'daily');
    
    // Small delay between requests to avoid overwhelming the server
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Then fetch hourly data
    await fetchDashboardData(updatedCookieStr, 'hourly');

  } catch (err) {
    console.error('💥 Error:', err.message);
  }
};

// Main execution
const main = () => {
  console.log('🚀 Starting EMWD Water Usage Scraper (Dual Mode)');
  console.log(`📅 Schedule: ${config.schedule}`);
  console.log(`🏠 MQTT Daily: ${config.mqtt.host}:${config.mqtt.port} -> ${config.mqtt.topicDaily}`);
  console.log(`🏠 MQTT Hourly: ${config.mqtt.host}:${config.mqtt.port} -> ${config.mqtt.topicHourly}`);
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