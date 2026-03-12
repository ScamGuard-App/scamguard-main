const test = require('node:test');
const assert = require('node:assert/strict');

// Minimal env bootstrap so server module can initialize clients during tests.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';

const { isUuid, parseAllowedOrigins, extractBearerToken } = require('../server');

test('isUuid accepts valid UUID values', () => {
    assert.equal(isUuid('550e8400-e29b-41d4-a716-446655440000'), true);
    assert.equal(isUuid('550E8400-E29B-41D4-A716-446655440000'), true);
});

test('isUuid rejects invalid identifiers', () => {
    assert.equal(isUuid('not-a-uuid'), false);
    assert.equal(isUuid('12345'), false);
    assert.equal(isUuid('550e8400-e29b-41d4-a716-44665544000'), false);
});

test('parseAllowedOrigins splits and trims origin list', () => {
    const actual = parseAllowedOrigins(' http://localhost:3000, https://example.com ,, ');
    assert.deepEqual(actual, ['http://localhost:3000', 'https://example.com']);
});

test('extractBearerToken returns token when Authorization header is bearer', () => {
    const req = {
        headers: {
            authorization: 'Bearer my-token-value',
        },
    };

    assert.equal(extractBearerToken(req), 'my-token-value');
});

test('extractBearerToken returns empty string when header missing', () => {
    const req = { headers: {} };
    assert.equal(extractBearerToken(req), '');
});
