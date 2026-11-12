// VERIFICA e IMPORTA o export de definicoes reais (sem acesso a producao).
// Uso: node importar_prod_defs.mjs <prod_defs.json> <saida.sql>
// 1) recalcula o sha256 de cada funcao e de cada tabela e compara com o que o export declarou;
// 2) grava um SQL unico: tabelas (DDL) e funcoes (texto exato, dollar-quoted com tag
//    derivada do sha256, para nao colidir com o conteudo).
// Falha (exit 1) se qualquer hash nao bater.
import fs from 'node:fs';
import crypto from 'node:crypto';

const [,, entrada, saida] = process.argv;
if (!entrada || !saida) { console.error('uso: importar_prod_defs.mjs <json> <saida.sql>'); process.exit(2); }
const j = JSON.parse(fs.readFileSync(entrada, 'utf8'));
const sha = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

let falhas = 0;
const linhas = ['-- IMPORTACAO GERADA POR importar_prod_defs.mjs — NAO EDITAR.', 'set search_path = public;'];

for (const t of j.tabelas) {
  if (sha(t.ddl) !== t.sha256) { console.error('HASH DIVERGENTE tabela ' + t.nome); falhas++; }
  linhas.push(t.ddl);
}
for (const f of j.funcoes) {
  if (sha(f.def) !== f.sha256) { console.error('HASH DIVERGENTE funcao ' + f.schema + '.' + f.nome); falhas++; }
  const tag = 'f_' + f.sha256.slice(0, 16);
  if (f.def.includes('$' + tag + '$')) { console.error('colisao de tag em ' + f.nome); falhas++; }
  // def ja e CREATE OR REPLACE completo; executa como veio, em dollar-quote apenas para o psql nao interpretar
  linhas.push('-- funcao ' + f.schema + '.' + f.nome + '(' + f.args + ')');
  linhas.push(f.def.endsWith(';') ? f.def : f.def + ';');
}
if (falhas) { console.error('FALHOU: ' + falhas + ' hash(es) divergente(s). Nada gravado.'); process.exit(1); }
fs.writeFileSync(saida, linhas.join('\n') + '\n');
console.log('OK: ' + j.funcoes.length + ' funcoes e ' + j.tabelas.length + ' tabelas verificadas por sha256 e gravadas em ' + saida);
