import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml, safeHttpUrl } from './emailService';

test('HTML escaping encodes text and attribute metacharacters', () => {
  assert.equal(escapeHtml(`<tag attr="value" & 'other'>`), '&lt;tag attr=&quot;value&quot; &amp; &#39;other&#39;&gt;');
});

test('email links allow only HTTP and HTTPS schemes', () => {
  assert.equal(safeHttpUrl('javascript:alert(1)', 'https://eventlink.example/claim'), 'https://eventlink.example/claim');
  assert.equal(safeHttpUrl('https://eventlink.example/claim?a=1&b=2', ''), 'https://eventlink.example/claim?a=1&amp;b=2');
});