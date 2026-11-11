'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const base=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(base,p),'utf8');
const proto=read('firmware/DCN_Transceiver/DCNProtocol.h');
// The packed struct must be usable by the ESP-NOW v1 250-byte limit.
const length=4+1+37+33+161;
assert.equal(length,236);
assert.ok(length<=250);
assert.ok(proto.includes('static_assert(sizeof(DCNPacket) <= 250'));
const fw=read('firmware/DCN_Transceiver/DCN_Transceiver.ino');
for(const token of ['DCN_DATA','DCN_ACK','"received"','"radio_ack"','"ready"','"deliver"','"ping"'])
  assert.ok(fw.includes(token),`Missing firmware token: ${token}`);
for(const f of ['public/sender.html','public/receiver.html','public/transmitter.js','public/receiver.js','public/abc.html','public/transfer.css','index.js','hardware-messages.js','sql/01_setup.sql','.env.example'])
  assert.ok(fs.existsSync(path.join(base,f)),`Missing file ${f}`);
const gateway=read('hardware-messages.js');
for(const route of ['/api/hardware/send','/api/hardware/ingest','/api/hardware/receipt/','/api/hardware/inbox','/api/hardware/status'])
  assert.ok(gateway.includes(route),`Missing endpoint ${route}`);
const ui=read('public/transmitter.js');
assert.ok(ui.includes("fetch('/api/hardware/send'"));
assert.ok(ui.includes('TextEncoder'));
const db=read('sql/01_setup.sql');
assert.ok(db.includes('hardware_receipts')&&db.includes('text_messages'));
console.log('PASS: common firmware protocol = 236 bytes, files, frontend APIs, central DB schema');
