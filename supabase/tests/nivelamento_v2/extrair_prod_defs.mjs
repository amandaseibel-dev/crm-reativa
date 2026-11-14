// EXTRACAO SOMENTE LEITURA, SEM psql. Grava em arquivo temporario, verifica, e so
// entao substitui prod_defs.json. Falha sem tocar o arquivo final.
// Uso (na raiz do repositorio):
//   PROD_READONLY_URL=<url de leitura> node supabase/tests/nivelamento_v2/extrair_prod_defs.mjs
// Requer o driver 'pg' (ex.: npm install --no-save pg). A URL nunca e impressa.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const D = 'supabase/tests/nivelamento_v2';
const FINAL = path.join(D, 'prod_defs.json');
const url = process.env.PROD_READONLY_URL;
if (!url) {
  console.error('PENDENTE: PROD_READONLY_URL nao definida no ambiente. Nada alterado.');
  process.exit(3);
}
let pg;
// PG_DRIVER: caminho absoluto para o modulo pg (ex.: <dir>/node_modules/pg/lib/index.js) ou nome do pacote.
const driver = process.env.PG_DRIVER || 'pg';
const spec = path.isAbsolute(driver) ? pathToFileURL(driver).href : driver;
try { pg = (await import(spec)).default; }
catch (e) { console.error('PENDENTE: driver pg nao carregou de ' + driver + ' (' + e.code + '). Nada alterado.'); process.exit(3); }

const tmp = FINAL + '.tmp-' + process.pid;
const tmpSql = tmp + '.sql';
const limpar = () => { for (const f of [tmp, tmpSql, tmp + '.sql.hashes.sql']) { try { fs.rmSync(f, { force: true }); } catch {} } };
process.on('exit', (code) => { if (code !== 0) limpar(); });

// TLS segue o sslmode da propria URL (ex.: sslmode=require); nao forcamos aqui.
const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  await client.query('set default_transaction_read_only = on');
  const sql = fs.readFileSync(process.env.EXPORT_SQL || path.join(D, 'export_prod_defs.sql'), 'utf8');
  const { rows } = await client.query(sql.replace(/^begin read only;\s*/m, '').replace(/^commit;\s*$/m, ''));
  const json = rows[0][Object.keys(rows[0])[0]];
  if (typeof json !== 'string' || json.length < 10) throw new Error('export sem saida JSON');
  fs.writeFileSync(tmp, json);
} catch (e) {
  console.error('FALHOU na extracao: ' + String(e.message).split(url).join('<URL>') + '. Nada alterado.');
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
try {
  execFileSync('node', [path.join(D, 'importar_prod_defs.mjs'), tmp, tmpSql], { stdio: 'inherit' });
} catch {
  console.error('FALHOU na verificacao (hashes/segredos). prod_defs.json nao foi substituido.');
  process.exit(1);
}
fs.renameSync(tmp, FINAL);
limpar();
console.log('OK: ' + FINAL + ' gravado e verificado.');
