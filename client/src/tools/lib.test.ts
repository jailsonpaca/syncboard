import { describe, expect, it } from 'vitest';
import * as L from './lib';

describe('json', () => {
  it('formata e minifica', () => {
    expect(L.formatJson('{"a":1,"b":[1,2]}', 2)).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    expect(L.minifyJson('{ "a": 1,\n "b": 2 }')).toBe('{"a":1,"b":2}');
  });
  it('rejeita JSON inválido', () => {
    expect(() => L.formatJson('{a:1}')).toThrow();
  });
});

describe('base64/url/html', () => {
  it('base64 com UTF-8', () => {
    expect(L.base64Encode('olá ✓')).toBe('b2zDoSDinJM=');
    expect(L.base64Decode('b2zDoSDinJM=')).toBe('olá ✓');
    expect(L.base64Decode('b2zDoSDinJM')).toBe('olá ✓'); // sem padding
  });
  it('url', () => {
    expect(L.urlDecode(L.urlEncode('a b&c=ç'))).toBe('a b&c=ç');
  });
  it('html', () => {
    expect(L.htmlEncode('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    expect(L.htmlDecode('&lt;b&gt; &amp;amp; &#65; &#x42;')).toBe('<b> &amp; A B');
  });
});

describe('jwt', () => {
  const tok =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0IiwiZXhwIjoxNzAwMDAwMDAwfQ.sig';
  it('decodifica header e payload', () => {
    const r = L.decodeJwt(tok);
    expect(r.header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(r.payload).toEqual({ sub: '1234', exp: 1700000000 });
    expect(r.expiresAt).toBe('2023-11-14T22:13:20.000Z');
  });
  it('rejeita token inválido', () => {
    expect(() => L.decodeJwt('abc')).toThrow();
  });
});

describe('hash', () => {
  it('MD5 conhecido', async () => {
    expect(await L.hashText('', 'MD5')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(await L.hashText('abc', 'MD5')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(await L.hashText('The quick brown fox jumps over the lazy dog', 'MD5')).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });
  it('MD5 de entrada longa (multi-bloco)', async () => {
    expect(await L.hashText('a'.repeat(1000), 'MD5')).toBe('cabe45dcc9ae5b66ba86600cca6b8ba8');
  });
  it('SHA-256 conhecido', async () => {
    expect(await L.hashText('abc', 'SHA-256')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('geradores', () => {
  it('uuid v4', () => {
    expect(L.uuidV4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('senha respeita tamanho e tipos', () => {
    const p = L.generatePassword({ length: 24, lower: true, upper: true, digits: true, symbols: false });
    expect(p).toHaveLength(24);
    expect(p).toMatch(/[a-z]/);
    expect(p).toMatch(/[A-Z]/);
    expect(p).toMatch(/\d/);
    expect(p).not.toMatch(/[^a-zA-Z0-9]/);
  });
  it('senha sem tipo selecionado falha', () => {
    expect(() => L.generatePassword({ length: 10, lower: false, upper: false, digits: false, symbols: false })).toThrow();
  });
  it('lorem gera N parágrafos', () => {
    expect(L.loremIpsum(3).split('\n\n')).toHaveLength(3);
  });
});

describe('conversores', () => {
  it('timestamp s/ms', () => {
    expect(L.timestampToDate('1700000000').iso).toBe('2023-11-14T22:13:20.000Z');
    expect(L.timestampToDate('1700000000000')).toMatchObject({ iso: '2023-11-14T22:13:20.000Z', unit: 'ms' });
    expect(L.dateToTimestamp('2023-11-14T22:13:20Z')).toEqual({ seconds: 1700000000, millis: 1700000000000 });
    expect(() => L.timestampToDate('x')).toThrow();
  });
  it('base numérica', () => {
    expect(L.convertBase('255', 10)).toEqual({ 2: '11111111', 8: '377', 10: '255', 16: 'FF' });
    expect(L.convertBase('0xff', 16)[10]).toBe('255');
    expect(L.convertBase('12345678901234567890', 10)[16]).toBe('AB54A98CEB1F0AD2');
    expect(() => L.convertBase('2', 2)).toThrow();
  });
  it('cores', () => {
    expect(L.parseColor('#6c5ce7')).toEqual({ r: 108, g: 92, b: 231 });
    expect(L.parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(L.rgbToHex({ r: 108, g: 92, b: 231 })).toBe('#6C5CE7');
    expect(L.rgbToHsl({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 100, l: 50 });
    expect(L.parseColor('hsl(120, 100%, 50%)')).toEqual({ r: 0, g: 255, b: 0 });
    expect(() => L.parseColor('azul')).toThrow();
  });
  it('case', () => {
    expect(L.caseConverters['camelCase']('hello world-foo_bar')).toBe('helloWorldFooBar');
    expect(L.caseConverters['PascalCase']('hello world')).toBe('HelloWorld');
    expect(L.caseConverters['snake_case']('helloWorld Foo')).toBe('hello_world_foo');
    expect(L.caseConverters['kebab-case']('Hello World')).toBe('hello-world');
    expect(L.caseConverters['CONSTANT_CASE']('hello world')).toBe('HELLO_WORLD');
  });
});

describe('diff e regex', () => {
  it('diff por linha', () => {
    expect(L.diffLines('a\nb\nc', 'a\nc\nd')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'same', text: 'c' },
      { type: 'add', text: 'd' },
    ]);
  });
  it('regex com grupos', () => {
    const m = L.runRegex('(\\d+)-(\\w+)', '', 'x 12-ab y 7-z');
    expect(m).toHaveLength(2);
    expect(m[0]).toEqual({ index: 2, text: '12-ab', groups: ['12', 'ab'] });
  });
  it('regex inválida lança', () => {
    expect(() => L.runRegex('(', 'g', 'x')).toThrow();
  });
});
