const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3100;
const DATA_DIR = path.join(__dirname, '..', 'data');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json'
};

const https = require('https');

function fetchAsync(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function fetchHNStories() {
  const idsRes = await fetchAsync('https://hacker-news.firebaseio.com/v0/topstories.json');
  const ids = JSON.parse(idsRes).slice(0, 50);
  
  const stories = await Promise.all(ids.map(async (id) => {
    try {
      const storyRes = await fetchAsync(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      return JSON.parse(storyRes);
    } catch { return null; }
  }));
  
  return stories.filter(s => s);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const urlPath = url.pathname;
  
  // Root redirect to dashboard
  if (urlPath === '/') {
    res.writeHead(301, { 'Location': '/hn-dashboard.html' });
    res.end();
    return;
  }
  
  // API: Hacker News trending stories
  if (urlPath.startsWith('/api/hn-stories')) {
    const dateParam = url.searchParams.get('date');
    const today = new Date().toISOString().split('T')[0];
    const targetDate = dateParam || today;
    const dataFile = path.join(DATA_DIR, `hn-${targetDate}.json`);
    
    // Check if we have historical data
    if (dateParam && fs.existsSync(dataFile)) {
      const historicalData = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ stories: historicalData, date: targetDate, historical: true }));
      return;
    }
    
    // If requesting today's data and we already fetched recently (within 10 min), use cached
    const todayFile = path.join(DATA_DIR, `hn-${today}.json`);
    const TEN_MINUTES = 10 * 60 * 1000;
    if (!dateParam && fs.existsSync(todayFile)) {
      const stat = fs.statSync(todayFile);
      if (Date.now() - stat.mtime.getTime() < TEN_MINUTES) {
        const cachedData = JSON.parse(fs.readFileSync(todayFile, 'utf-8'));
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ stories: cachedData, date: today, historical: false }));
        return;
      }
    }
    
    // Fetch fresh data
    try {
      const stories = await fetchHNStories();
      
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(todayFile, JSON.stringify(stories));
      
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ stories, date: today, historical: false }));
    } catch (e) {
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // API: Available dates
  if (urlPath === '/api/hn-dates') {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('hn-') && f.endsWith('.json'));
    const dates = files.map(f => f.replace('hn-', '').replace('.json', '')).sort().reverse();
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ dates }));
    return;
  }
  
  // API: Hacker News jobs
  if (urlPath === '/api/hn-jobs') {
    try {
      const jobsRes = await fetchAsync('https://hacker-news.firebaseio.com/v0/jobstories.json');
      const jobIds = JSON.parse(jobsRes).slice(0, 50);
      
      const jobs = await Promise.all(jobIds.map(async (id) => {
        try {
          const jobRes = await fetchAsync(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
          return JSON.parse(jobRes);
        } catch { return null; }
      }));
      
      const validJobs = jobs.filter(j => j);
      
      // Save to history (jobs-YYYY-MM-DD.json)
      const today = new Date().toISOString().split('T')[0];
      const jobHistoryFile = path.join(DATA_DIR, `jobs-${today}.json`);
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(jobHistoryFile, JSON.stringify(validJobs));
      
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ jobs: validJobs, date: today }));
    } catch (e) {
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // API: Job history (last 7 days)
  if (urlPath === '/api/hn-jobs-history') {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('jobs-hn-') && f.endsWith('.json'));
    const dates = files.map(f => f.replace('jobs-hn-', '').replace('.json', '')).sort().reverse().slice(0, 7);
    const history = dates.map(date => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `jobs-hn-${date}.json`), 'utf-8'));
        return { date, count: data.length };
      } catch { return { date, count: 0 }; }
    });
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ history }));
    return;
  }
  
  // API:HN comments
  if (urlPath.startsWith('/api/hn-comments/')) {
    const id = urlPath.split('/').pop();
    try {
      const commentRes = await fetchAsync(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      const comment = JSON.parse(commentRes);
      
      const loadKids = async (kids) => {
        if (!kids) return [];
        const comments = [];
        for (const kidId of kids.slice(0, 10)) {
          try {
            const kidRes = await fetchAsync(`https://hacker-news.firebaseio.com/v0/item/${kidId}.json`);
            const kid = JSON.parse(kidRes);
            if (kid) {
              comments.push(kid);
              if (kid.kids) {
                kid.children = await loadKids(kid.kids);
              }
            }
          } catch {}
        }
        return comments;
      };
      
      const result = comment.kids ? await loadKids(comment.kids) : [];
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify([]));
    }
    return;
  }
  
  // Serve static files
  if (urlPath.startsWith('/') && !urlPath.startsWith('/api/')) {
    const staticFile = urlPath.substring(1);
    const staticPath = path.join(__dirname, '..', staticFile);
    if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      const ext = path.extname(staticPath);
      res.writeHead(200, {'Content-Type': MIME_TYPES[ext] || 'text/plain'});
      res.end(fs.readFileSync(staticPath));
      return;
    }
  }
  
  res.writeHead(404, {'Content-Type': 'text/plain'});
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`🚀 HN Dashboard running at http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/hn-dashboard.html`);
});