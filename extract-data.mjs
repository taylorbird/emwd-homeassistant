import fs from 'fs';
import * as cheerio from 'cheerio';

// Read the dashboard HTML
const html = fs.readFileSync('dashboard.html', 'utf-8');
const $ = cheerio.load(html);

console.log('📊 Extracting EMWD Water Usage Data\n');

// Find the Highcharts configuration script
let chartData = null;
let categories = null;
let usage = null;

$('script').each((i, elem) => {
  const script = $(elem).html();
  if (!script || (!script.includes('Highcharts.Chart') && !script.includes('Highcharts.chart'))) return;
  
  // Extract categories (dates) - more flexible pattern
  const categoriesMatch = script.match(/categories\s*:\s*(\[[\s\S]*?\])/);
  if (categoriesMatch) {
    try {
      // Replace single quotes with double quotes for valid JSON
      const validJson = categoriesMatch[1].replace(/'/g, '"');
      categories = JSON.parse(validJson);
      console.log(`✅ Found ${categories.length} dates from ${categories[0]} to ${categories[categories.length-1]}`);
    } catch (e) {
      console.error('Failed to parse categories:', e.message);
      console.log('Categories match:', categoriesMatch[1].substring(0, 200));
    }
  }
  
  // Extract usage data - more flexible pattern
  const usageMatch = script.match(/name\s*:\s*"Usage"[\s\S]*?data\s*:\s*(\[[^\]]+\])/);
  if (usageMatch) {
    try {
      usage = JSON.parse(usageMatch[1]);
      console.log(`✅ Found ${usage.length} usage values`);
      console.log(`Latest: ${usage[usage.length-1]} gallons`);
    } catch (e) {
      console.error('Failed to parse usage data:', e.message);
      console.log('Usage match:', usageMatch[1].substring(0, 200));
    }
  }
});

if (categories && usage) {
  // Combine dates with usage values
  const combined = categories.map((date, i) => ({
    date: date,
    usage: usage[i] || 0
  }));
  
  console.log('\n📈 Last 7 days of water usage:');
  console.log('================================');
  combined.slice(-7).forEach(entry => {
    console.log(`${entry.date}: ${entry.usage} gallons`);
  });
  
  // Calculate total and average
  const total = usage.reduce((sum, val) => sum + val, 0);
  const average = total / usage.length;
  const latest = usage[usage.length - 1];
  
  console.log('\n📊 Statistics:');
  console.log('================================');
  console.log(`Latest reading: ${latest} gallons`);
  console.log(`30-day total: ${total.toFixed(0)} gallons`);
  console.log(`Daily average: ${average.toFixed(1)} gallons`);
  
  // This is what we need for MQTT
  console.log('\n🔌 For Home Assistant:');
  console.log('================================');
  console.log(`Current usage value to publish: ${latest} gallons`);
  console.log(`Timestamp: ${categories[categories.length - 1]}`);
  
  // Save the extracted data
  const extractedData = {
    latest_usage: latest,
    latest_date: categories[categories.length - 1],
    total_30_days: total,
    daily_average: average,
    full_data: combined
  };
  
  fs.writeFileSync('extracted_data.json', JSON.stringify(extractedData, null, 2));
  console.log('\n💾 Saved extracted data to extracted_data.json');
  
} else {
  console.error('❌ Could not extract data from dashboard');
}