import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';

// Configuration
const config = {
  username: process.env.EMWD_USERNAME || 'taylorlbird',
  password: process.env.EMWD_PASSWORD || 'xut2cyx.zrp9bgk.KAE',
  meterId: '400027755'
};

console.log('💧 EMWD Water Usage Scraper');
console.log('==============================\n');

async function scrapeWaterUsage() {
  try {
    // Step 1: Initial session establishment
    console.log('1️⃣ Establishing session...');
    const initialResponse = await axios.get('https://myaccount.emwd.org/app/login.jsp', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      }
    });
    
    const initialCookies = initialResponse.headers['set-cookie'] || [];
    const initialCookieStr = initialCookies.map(c => c.split(';')[0]).join('; ');

    // Step 2: Get login page with CSRF token
    console.log('2️⃣ Getting CSRF token...');
    const loginUrl = 'https://myaccount.emwd.org/app/capricorn?para=index';
    const loginPage = await axios.get(loginUrl, {
      headers: {
        'Cookie': initialCookieStr,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      }
    });

    const $ = cheerio.load(loginPage.data);
    const csrfToken = $('input[name=jspCSRFToken]').val();
    
    if (!csrfToken) {
      throw new Error('CSRF token not found');
    }

    const loginPageCookies = loginPage.headers['set-cookie'] || [];
    const combinedCookieStr = loginPageCookies
      .map(c => c.split(';')[0])
      .filter(c => !c.includes('Max-Age=0'))
      .join('; ');

    // Step 3: Authenticate
    console.log('3️⃣ Authenticating...');
    const loginData = {
      jspCSRFToken: csrfToken,
      accessCode: config.username,
      password: config.password,
      nextPara: '',
      nextPara_attr1: ''
    };

    const loginResponse = await axios.post(loginUrl, new URLSearchParams(loginData).toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': combinedCookieStr,
        'Referer': 'https://myaccount.emwd.org/app/login.jsp',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      },
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400
    });

    // Build session cookies
    const allCookies = [...loginPageCookies, ...(loginResponse.headers['set-cookie'] || [])];
    const cookieMap = new Map();
    allCookies.forEach(cookieStr => {
      const [keyValue] = cookieStr.split(';');
      const [key, value] = keyValue.split('=');
      if (key && value !== undefined) {
        cookieMap.set(key.trim(), keyValue.trim());
      }
    });
    
    let sessionCookies = Array.from(cookieMap.values()).join('; ');
    sessionCookies = sessionCookies.replace('capricornWCMid=', `capricornWCMid=${config.username}`);

    // Step 4: Load water consumption dashboard
    console.log('4️⃣ Loading consumption dashboard...');
    const dashboardUrl = 'https://myaccount.emwd.org/app/capricorn?para=smartMeterConsum&inquiryType=water&tab=WATSMCON';
    
    const dashboardResponse = await axios.get(dashboardUrl, {
      headers: {
        'Cookie': sessionCookies,
        'Referer': loginUrl,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      }
    });

    if (dashboardResponse.data.length < 10000) {
      throw new Error('Dashboard response too small - possible session expired');
    }

    // Step 5: Extract consumption data
    console.log('5️⃣ Extracting water usage data...');
    
    const $dashboard = cheerio.load(dashboardResponse.data);
    let categories = null;
    let usageData = null;

    // Find the Highcharts script and extract data
    $dashboard('script').each((i, elem) => {
      const script = $dashboard(elem).html();
      if (!script || (!script.includes('Highcharts.Chart') && !script.includes('Highcharts.chart'))) return;
      
      // Extract date categories
      const categoriesMatch = script.match(/categories\s*:\s*(\[[\s\S]*?\])/);
      if (categoriesMatch) {
        try {
          const validJson = categoriesMatch[1].replace(/'/g, '"');
          categories = JSON.parse(validJson);
        } catch (e) {
          console.error('Failed to parse categories:', e.message);
        }
      }
      
      // Extract usage data
      const usageMatch = script.match(/name\s*:\s*"Usage"[\s\S]*?data\s*:\s*(\[[^\]]+\])/);
      if (usageMatch) {
        try {
          usageData = JSON.parse(usageMatch[1]);
        } catch (e) {
          console.error('Failed to parse usage data:', e.message);
        }
      }
    });

    if (!categories || !usageData) {
      throw new Error('Could not extract water usage data from dashboard');
    }

    // Step 6: Process and display results
    // Convert from cubic feet to gallons (1 CF = 7.48052 gallons)
    const CF_TO_GALLONS = 7.48052;
    
    const latestUsageCF = usageData[usageData.length - 1];
    const latestUsage = Math.round(latestUsageCF * CF_TO_GALLONS);
    const latestDate = categories[categories.length - 1];
    
    const totalUsageCF = usageData.reduce((sum, val) => sum + val, 0);
    const totalUsage = Math.round(totalUsageCF * CF_TO_GALLONS);
    const averageUsage = totalUsage / usageData.length;

    console.log('\\n✅ Successfully extracted water usage data!');
    console.log('==========================================');
    console.log(`📅 Latest date: ${latestDate}`);
    console.log(`💧 Latest usage: ${latestUsageCF} CF = ${latestUsage} gallons`);
    console.log(`📊 30-day total: ${totalUsageCF.toFixed(1)} CF = ${totalUsage} gallons`);
    console.log(`📈 Daily average: ${averageUsage.toFixed(1)} gallons`);

    // Show last 5 days
    console.log('\\n📈 Recent usage:');
    console.log('================');
    for (let i = Math.max(0, usageData.length - 5); i < usageData.length; i++) {
      const gallons = Math.round(usageData[i] * CF_TO_GALLONS);
      console.log(`${categories[i]}: ${usageData[i]} CF = ${gallons} gallons`);
    }

    // Return structured data
    return {
      success: true,
      data: {
        latest_usage: latestUsage,
        latest_date: latestDate,
        total_30_days: totalUsage,
        daily_average: averageUsage,
        recent_usage: usageData.slice(-7).map((usage, i) => ({
          date: categories[categories.length - 7 + i],
          usage_cf: usage,
          usage_gallons: Math.round(usage * CF_TO_GALLONS)
        }))
      }
    };

  } catch (error) {
    console.error('❌ Error:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// Execute the scraper
scrapeWaterUsage().then(result => {
  if (result.success) {
    // Save the data
    fs.writeFileSync('latest_water_data.json', JSON.stringify(result.data, null, 2));
    console.log('\\n💾 Data saved to latest_water_data.json');
    console.log('\\n🎉 Scraping completed successfully!');
  } else {
    console.log('\\n💥 Scraping failed!');
    process.exit(1);
  }
}).catch(console.error);