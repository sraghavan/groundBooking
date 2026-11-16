import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseCell, parseWorkbook, prettyName, type ImportConfig } from './import/excel.js';

test('parseCell reads the workbook conventions', () => {
  assert.deepEqual(parseCell('micc vs spn champs'), { kind: 'match', teams: ['micc', 'spn champs'] });
  assert.deepEqual(parseCell('Delhi defenders Vs'), { kind: 'match', teams: ['Delhi defenders'] });
  assert.deepEqual(parseCell(' vs Pawan dsk'), { kind: 'match', teams: ['Pawan dsk'] });
  assert.deepEqual(parseCell('rakshit both teams'), { kind: 'event', holder: 'rakshit', both: true });
  assert.deepEqual(parseCell('Rana Both'), { kind: 'event', holder: 'Rana', both: true });
  assert.deepEqual(parseCell('rana '), { kind: 'event', holder: 'rana', both: false });
  assert.equal(parseCell('SLOT 1'), null);
  assert.equal(parseCell('  '), null);
});

test('prettyName', () => {
  assert.equal(prettyName('msp united'), 'MSP United');
  assert.equal(prettyName('micc'), 'MICC');
  assert.equal(prettyName('saurabh team 92'), 'Saurabh Team 92');
  assert.equal(prettyName('Royal SC'), 'Royal SC');
});

test('parseWorkbook handles month blocks, day rollover and real dates', () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('G');
  ws.addRow([null, 'JANUARY']);
  ws.addRow(['DATE', new Date(Date.UTC(1899, 11, 30, 8)), new Date(Date.UTC(1899, 11, 30, 12))]);
  ws.addRow([1, 'a vs b']);           // 2024-01-01
  ws.addRow([31, null, 'c vs']);      // 2024-01-31
  ws.addRow(['1 Thursday', 'rana']);  // no title: rolls over to 2024-02-01 (a Thursday)
  ws.addRow([new Date(Date.UTC(2025, 2, 9)), 'A vs B']);
  const cfg: ImportConfig = {
    orgName: 'X', city: 'Y',
    slots: { m: { name: 'Morning', start: '08:00', end: '12:00' }, s: { name: 'Second', start: '12:00', end: '16:00' } },
    grounds: [{ name: 'G', sources: [{ sheet: 'G', dateCol: 'A', startYear: 2024, columns: { B: 'm', C: 's' } }] }],
  };
  const p = parseWorkbook(wb, cfg, '2025-03-01');
  assert.deepEqual(p.issues, []);
  assert.deepEqual(p.bookings.map((b) => [b.date, b.slotKey, b.kind, b.teams.length]), [
    ['2024-01-01', 'm', 'match', 2], ['2024-01-31', 's', 'match', 1], ['2024-02-01', 'm', 'event', 1], ['2025-03-09', 'm', 'match', 2],
  ]);
  assert.equal(p.teams.size, 4); // a/A and b/B merge; c; rana
  assert.equal(p.grounds[0].slots.find((s) => s.key === 'm')?.active, true);
});
