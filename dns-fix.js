/**
 * DNS Fix — Force Node.js to prefer IPv4 over IPv6.
 * Prevents ECONNREFUSED on some Windows/cloud environments
 * where localhost resolves to ::1 (IPv6) instead of 127.0.0.1.
 */
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
