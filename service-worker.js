// service-worker.js
const CACHE_NAME = 'neotrade-v1.0.0';
const CACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];

// Install event
self.addEventListener('install', event => {
  console.log('Service Worker installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// Activate event
self.addEventListener('activate', event => {
  console.log('Service Worker activating...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event with network-first strategy for API, cache-first for assets
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // API requests - network first, then cache
  if (url.pathname.includes('/api/') || url.hostname === 'fapi.binance.com') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Cache successful responses
          if (response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // Fallback to cache if network fails
          return caches.match(event.request);
        })
    );
  } else {
    // Static assets - cache first
    event.respondWith(
      caches.match(event.request)
        .then(response => response || fetch(event.request))
    );
  }
});

// Background sync for offline trades
self.addEventListener('sync', event => {
  console.log('Background sync:', event.tag);
  
  if (event.tag === 'offline-trades') {
    event.waitUntil(syncOfflineTrades());
  }
});

// Periodic sync for market data
self.addEventListener('periodicsync', event => {
  if (event.tag === 'market-data-sync') {
    console.log('Periodic sync for market data');
    event.waitUntil(syncMarketData());
  }
});

// Push notifications
self.addEventListener('push', event => {
  console.log('Push notification received:', event);
  
  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    data = {
      title: 'NeoTrade',
      body: event.data.text(),
      icon: '/icon-192.png'
    };
  }
  
  const options = {
    body: data.body,
    icon: data.icon || '/icon-192.png',
    badge: '/badge-72.png',
    vibrate: [100, 50, 100],
    data: data.data || {},
    actions: [
      {
        action: 'view-trade',
        title: 'View Trade'
      },
      {
        action: 'dismiss',
        title: 'Dismiss'
      }
    ],
    requireInteraction: true
  };
  
  event.waitUntil(
    self.registration.showNotification(data.title || 'NeoTrade', options)
  );
});

// Notification click handler
self.addEventListener('notificationclick', event => {
  console.log('Notification clicked:', event);
  
  event.notification.close();
  
  const notificationData = event.notification.data;
  
  if (event.action === 'view-trade' && notificationData.symbol) {
    // Focus existing window or open new one
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then(windowClients => {
          if (windowClients.length > 0) {
            const client = windowClients[0];
            client.focus();
            client.postMessage({
              type: 'NOTIFICATION_CLICKED',
              data: notificationData
            });
          } else {
            clients.openWindow('/');
          }
        })
    );
  }
});

// Message handler from main thread
self.addEventListener('message', event => {
  console.log('Service Worker received message:', event.data);
  
  switch(event.data.type) {
    case 'SEND_NOTIFICATION':
      self.registration.showNotification(
        event.data.data.title,
        {
          body: event.data.data.body,
          icon: '/icon-192.png',
          badge: '/badge-72.png',
          data: event.data.data,
          requireInteraction: true
        }
      );
      break;
      
    case 'SAVE_OFFLINE_DATA':
      saveOfflineData(event.data.data);
      break;
      
    case 'SYNC_NOW':
      syncOfflineTrades();
      break;
  }
});

// Helper functions
async function syncOfflineTrades() {
  try {
    const cache = await caches.open('offline-data');
    const keys = await cache.keys();
    const tradeRequests = keys.filter(key => key.url.includes('/api/trades'));
    
    const results = await Promise.allSettled(
      tradeRequests.map(async request => {
        const response = await cache.match(request);
        const data = await response.json();
        
        // Send to server
        const serverResponse = await fetch('/api/trades/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        
        if (serverResponse.ok) {
          await cache.delete(request);
          return { success: true, data };
        } else {
          throw new Error('Sync failed');
        }
      })
    );
    
    const successCount = results.filter(r => r.status === 'fulfilled').length;
    
    // Notify main thread
    self.clients.matchAll().then(clients => {
      clients.forEach(client => {
        client.postMessage({
          type: 'SYNC_COMPLETED',
          data: { synced: successCount, total: tradeRequests.length }
        });
      });
    });
    
    console.log(`Synced ${successCount}/${tradeRequests.length} offline trades`);
    
  } catch (error) {
    console.error('Sync failed:', error);
    
    self.clients.matchAll().then(clients => {
      clients.forEach(client => {
        client.postMessage({
          type: 'SYNC_FAILED',
          data: { error: error.message }
        });
      });
    });
    
    throw error;
  }
}

async function syncMarketData() {
  try {
    const response = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
    const data = await response.json();
    
    const cache = await caches.open(CACHE_NAME);
    await cache.put(
      new Request('https://fapi.binance.com/fapi/v1/ticker/24hr'),
      new Response(JSON.stringify(data))
    );
    
    console.log('Market data synced');
    
  } catch (error) {
    console.error('Market data sync failed:', error);
  }
}

async function saveOfflineData(data) {
  const cache = await caches.open('offline-data');
  const timestamp = Date.now();
  const request = new Request(`/api/offline/${timestamp}`);
  const response = new Response(JSON.stringify(data));
  
  await cache.put(request, response);
  
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({
        type: 'OFFLINE_DATA_SAVED',
        data: { id: timestamp, type: data.type }
      });
    });
  });
}