/* 새 VAPID 키가 필요할 때 실행: node generate-vapid-keys.js
   외부 패키지 없이 Node 내장 crypto만 사용합니다.
   ⚠️ 새로 생성하면 public/app.js 의 PUBLIC_VAPID_KEY 값도 반드시 함께 교체해야 해요. */
const crypto = require('crypto');

function b64urlFromBuffer(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBuffer(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pubJwk = publicKey.export({ format: 'jwk' });
const privJwk = privateKey.export({ format: 'jwk' });

const x = b64urlToBuffer(pubJwk.x);
const y = b64urlToBuffer(pubJwk.y);
const uncompressedPoint = Buffer.concat([Buffer.from([0x04]), x, y]);

console.log('VAPID_PUBLIC_KEY=' + b64urlFromBuffer(uncompressedPoint));
console.log('VAPID_PRIVATE_KEY=' + privJwk.d.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
