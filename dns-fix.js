/**
 * DNS IPv4 Preload Script
 * ─────────────────────────
 * Must be loaded BEFORE any module via: node --import ./dns-fix.js server.js
 * Forces Node to resolve DNS with IPv4 first, preventing ENETUNREACH errors
 * on cloud platforms (Render, Railway, etc.) that lack IPv6 networking.
 */
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
console.log('[dns-fix] DNS resolution order set to ipv4first');
