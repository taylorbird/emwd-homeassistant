import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';

// Test credentials
const username = process.env.EMWD_USERNAME || 'taylorlbird';
const password = process.env.EMWD_PASSWORD || 'xut2cyx.zrp9bgk.KAE';
const meterId = '400027755';

console.log('🔧 EMWD Scraper Test - Finding the data...\n');

async function testScraper() {
  try {
    // Step 1: Initial visit
    console.log('1️⃣ Initial visit to establish session...');
    const initialVisit = await axios.get('https://myaccount.emwd.org/app/login.jsp', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      }
    });
    
    const initialCookies = initialVisit.headers['set-cookie'] || [];
    const initialCookieStr = initialCookies.map(c => c.split(';')[0]).join('; ');
    console.log('Initial cookies:', initialCookieStr);

    // Step 2: Get login page and CSRF token
    console.log('\n2️⃣ Getting login page...');
    const loginUrl = 'https://myaccount.emwd.org/app/capricorn?para=index';
    const loginPage = await axios.get(loginUrl, {
      headers: {
        'Cookie': initialCookieStr,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      }
    });

    const $ = cheerio.load(loginPage.data);
    const token = $('input[name=jspCSRFToken]').val();
    console.log('CSRF token:', token);

    const loginPageCookies = loginPage.headers['set-cookie'] || [];
    const combinedCookieStr = loginPageCookies
      .map(c => c.split(';')[0])
      .filter(c => !c.includes('Max-Age=0'))
      .join('; ');

    // Step 3: Login
    console.log('\n3️⃣ Logging in...');
    const postData = {
      jspCSRFToken: token,
      accessCode: username,
      password: password,
      nextPara: '',
      nextPara_attr1: ''
    };

    const loginRes = await axios.post(loginUrl, new URLSearchParams(postData).toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': combinedCookieStr,
        'Referer': 'https://myaccount.emwd.org/app/login.jsp',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      },
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400
    });

    console.log('Login response status:', loginRes.status);
    
    // Build final cookie string
    const allCookies = [...loginPageCookies, ...(loginRes.headers['set-cookie'] || [])];
    const cookieMap = new Map();
    allCookies.forEach(cookieStr => {
      const [keyValue] = cookieStr.split(';');
      const [key, value] = keyValue.split('=');
      if (key && value !== undefined) {
        cookieMap.set(key.trim(), keyValue.trim());
      }
    });
    
    let cookieStr = Array.from(cookieMap.values()).join('; ');
    cookieStr = cookieStr.replace('capricornWCMid=', `capricornWCMid=${username}`);
    console.log('Session cookies:', cookieStr);

    // Step 4: Load dashboard
    console.log('\n4️⃣ Loading water consumption dashboard...');
    const dashboardUrl = 'https://myaccount.emwd.org/app/capricorn?para=smartMeterConsum&inquiryType=water&tab=WATSMCON';
    
    const dashboardRes = await axios.get(dashboardUrl, {
      headers: {
        'Cookie': cookieStr,
        'Referer': loginUrl,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      }
    });

    console.log('Dashboard response size:', dashboardRes.data.length);
    
    // Save dashboard HTML for analysis
    fs.writeFileSync('dashboard.html', dashboardRes.data);
    console.log('💾 Saved dashboard.html for analysis');

    // Step 5: Look for chart data
    console.log('\n5️⃣ Searching for consumption data patterns...\n');
    
    const $dashboard = cheerio.load(dashboardRes.data);
    
    // Search all scripts for data patterns
    let foundData = false;
    $dashboard('script').each((i, elem) => {
      const script = $dashboard(elem).html();
      if (!script || script.length < 100) return;
      
      // Look for various data patterns
      const patterns = [
        /series\s*:\s*\[([\s\S]*?)\]/g,  // Highcharts series
        /data\s*:\s*(\[\[.*?\]\])/g,      // Data arrays
        /consumptionData/g,               // Consumption data references
        /\[\s*\[\s*\d{10,13}\s*,\s*\d+/g, // Timestamp,value patterns
        /Water Usage/gi,                  // Water usage text
        /chartData/gi,                    // Chart data variables
        /Highcharts\.chart/g,            // Highcharts initialization
      ];
      
      patterns.forEach(pattern => {
        const matches = script.match(pattern);
        if (matches) {
          console.log(`Found pattern in script ${i}:`, pattern.source);
          console.log('Match preview:', matches[0].substring(0, 200));
          foundData = true;
        }
      });
    });
    
    if (!foundData) {
      console.log('❌ No chart data patterns found in scripts');
      
      // Look for other data locations
      console.log('\n6️⃣ Looking for alternative data sources...');
      
      // Check for iframes
      const iframes = $dashboard('iframe');
      if (iframes.length > 0) {
        console.log(`Found ${iframes.length} iframe(s)`);
        iframes.each((i, elem) => {
          console.log(`  Iframe ${i}: src="${$dashboard(elem).attr('src')}"`);
        });
      }
      
      // Check for AJAX endpoints in scripts
      const ajaxPatterns = [
        /url\s*:\s*["']([^"']*?)["']/g,
        /\.ajax\s*\(\s*{[^}]*url[^}]*}/g,
        /fetch\s*\(["']([^"']*?)["']/g,
      ];
      
      $dashboard('script').each((i, elem) => {
        const script = $dashboard(elem).html();
        if (!script) return;
        
        ajaxPatterns.forEach(pattern => {
          const matches = [...script.matchAll(pattern)];
          if (matches.length > 0) {
            console.log(`Found AJAX calls in script ${i}:`);
            matches.forEach(m => console.log('  ', m[1] || m[0].substring(0, 100)));
          }
        });
      });
      
      // Check for data attributes
      const dataElements = $dashboard('[data-chart], [data-series], [data-consumption]');
      if (dataElements.length > 0) {
        console.log(`Found ${dataElements.length} elements with data attributes`);
      }
    }
    
    // Step 7: Try alternative endpoints
    console.log('\n7️⃣ Trying alternative data endpoints...\n');
    
    const endpoints = [
      '/app/capricorn?para=getChartData',
      '/app/capricorn?para=waterConsumptionData', 
      '/app/capricorn?para=smartMeterData',
      '/app/capricorn?para=consumptionDataAjax',
    ];
    
    for (const endpoint of endpoints) {
      try {
        const url = `https://myaccount.emwd.org${endpoint}&meterId=${meterId}&_=${Date.now()}`;
        console.log(`Trying: ${endpoint}`);
        
        const response = await axios.get(url, {
          headers: {
            'Cookie': cookieStr,
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': dashboardUrl,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
          },
          validateStatus: () => true
        });
        
        console.log(`  Status: ${response.status}, Size: ${JSON.stringify(response.data).length}, Type: ${typeof response.data}`);
        
        if (response.status === 200 && response.data) {
          const dataStr = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
          if (dataStr.includes('[') || dataStr.includes('data') || dataStr.includes('consumption')) {
            console.log(`  ✅ Potential data found!`);
            fs.writeFileSync(`endpoint_${endpoint.split('=')[1]}.json`, dataStr);
          }
        }
      } catch (e) {
        console.log(`  Error: ${e.message}`);
      }
    }
    
    console.log('\n✅ Test complete! Check the saved files for analysis.');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data preview:', JSON.stringify(error.response.data).substring(0, 500));
    }
  }
}

testScraper();