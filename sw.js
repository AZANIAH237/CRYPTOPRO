// Service Worker for NeoTrade - Binance Futures Pro
const CACHE_NAME = 'neotrade-v4';
const STATIC_CACHE_NAME = 'neotrade-static-v4';
const DYNAMIC_CACHE_NAME = 'neotrade-dynamic-v4';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap'
];

// Install event
self.addEventListener('install', (event) => {
  console.log('Service Worker installing...');
  event.waitUntil(
    caches.open(STATIC_CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate event
self.addEventListener('activate', (event) => {
  console.log('Service Worker activating...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== STATIC_CACHE_NAME && cacheName !== DYNAMIC_CACHE_NAME) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch event with network-first strategy for API calls, cache-first for static assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Skip non-GET requests
  if (event.request.method !== 'GET') return;
  
  // Handle API calls with network-first strategy
  if (url.hostname.includes('binance.com') || 
      url.hostname.includes('binance.me')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Cache successful API responses for 30 seconds
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(DYNAMIC_CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // If network fails, try cache
          return caches.match(event.request);
        })
    );
    return;
  }
  
  // For static assets, use cache-first strategy
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Update cache in background
        fetch(event.request).then((response) => {
          if (response.ok) {
            const responseToCache = response.clone();
            caches.open(STATIC_CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
        });
        return cachedResponse;
      }
      
      return fetch(event.request).then((response) => {
        // Don't cache if not a successful response
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        
        const responseToCache = response.clone();
        caches.open(STATIC_CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        
        return response;
      });
    })
  );
});

// Background sync for offline trades
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-trades') {
    console.log('Background sync: syncing trades...');
    event.waitUntil(syncTrades());
  }
});

// Push notifications
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  
  const options = {
    body: data.body || 'New trade notification',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: 'trade-notification',
      tradeId: data.tradeId,
      symbol: data.symbol,
      type: data.type
    },
    actions: [
      {
        action: 'open',
        title: 'Open Trade'
      },
      {
        action: 'close',
        title: 'Dismiss'
      }
    ]
  };
  
  event.waitUntil(
    self.registration.showNotification(data.title || 'NeoTrade Alert', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  
  if (event.action === 'open' || event.action === 'open-trade') {
    event.waitUntil(
      clients.matchAll({ type: 'window' }).then((clientList) => {
        for (const client of clientList) {
          if (client.url.includes('/') && 'focus' in client) {
            client.postMessage({
              type: 'notification-click',
              action: 'open-trade',
              tradeId: event.notification.data.tradeId,
              symbol: event.notification.data.symbol
            });
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow('/');
        }
      })
    );
  }
});

// Message event for communication with the app
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Functions for background tasks
async function syncTrades() {
  try {
    // Get all clients
    const clients = await self.clients.matchAll();
    
    // Request trade data from each client
    for (const client of clients) {
      client.postMessage({
        type: 'SYNC_TRADES_REQUEST'
      });
    }
  } catch (error) {
    console.error('Background sync failed:', error);
  }
}

// Check for version updates
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({
      version: '4.0.0',
      cacheName: CACHE_NAME
    });
  }
});

// Clear old cache entries periodically
async function cleanupOldCache() {
  const cache = await caches.open(DYNAMIC_CACHE_NAME);
  const requests = await cache.keys();
  
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes
  
  for (const request of requests) {
    const url = new URL(request.url);
    
    // Only clean Binance API calls
    if (url.hostname.includes('binance.com')) {
      const response = await cache.match(request);
      if (response) {
        const dateHeader = response.headers.get('date');
        if (dateHeader) {
          const fetchedDate = new Date(dateHeader).getTime();
          if (now - fetchedDate > maxAge) {
            await cache.delete(request);
          }
        }
      }
    }
  }
}

// Run cleanup every hour
setInterval(cleanupOldCache, 60 * 60 * 1000);
