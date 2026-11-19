// VERIFICA e IMPORTA o export de definicoes reais. Sem acesso a producao, sem credenciais.
// Uso: node importar_prod_defs.mjs <export.json> <saida.sql>
// Falha (exit 1) e NAO grava saida se:
//  - versao_export != 2, JSON invalido ou campos ausentes;
//  - sha256 recalculado de qualquer tipo, tabela ou funcao diverge do declarado;
//  - algum texto contem padrao de segredo (JWT, chave, URL com senha, senha literal).
// Ordem do SQL gerado: tipos -> tabelas -> funcoes (texto exato de pg_get_functiondef).
import fs from 'node:fs';
import crypto from 'node:crypto';

const [,, entrada, saida] = process.argv;
if (!entrada || !saida) { console.error('uso: importar_prod_defs.mjs <export.json> <saida.sql>'); process.exit(2); }

const sha = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
let j;
try { j = JSON.parse(fs.readFileSync(entrada, 'utf8')); }
catch (e) { console.error('FALHOU: JSON invalido: ' + e.message); process.exit(1); }
if (j.checagens) {
  for (const k of ['dinamicas', 'nao_resolvidas']) {
    if (Array.isArray(j.checagens[k]) && j.checagens[k].length) { console.error('EXPORT RECUSADO: ' + k + ': ' + j.checagens[k].join(', ')); process.exit(1); }
  }
}
if (j.versao_export !== 2) { console.error('FALHOU: versao_export esperada 2, obtida ' + j.versao_export); process.exit(1); }
for (const campo of ['tipos', 'tabelas', 'funcoes']) {
  if (!Array.isArray(j[campo])) { console.error('FALHOU: campo ausente ou invalido: ' + campo); process.exit(1); }
}

const SEGREDOS = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,   // JWT
  /\bsk_(live|test)_[A-Za-z0-9]{8,}/,                                // chave Stripe-like
  /postgres(ql)?:\/\/[^\s:]+:[^\s@]+@/i,                             // URL com senha
  /\b(password|senha|secret|api[_-]?key|service_role_key)\s*[:=]\s*['"][^'"]{6,}['"]/i,
];
const erros = [];
const checa = (rotulo, texto, hashDeclarado) => {
  if (typeof texto !== 'string') { erros.push(rotulo + ': texto ausente'); return; }
  if (sha(texto) !== hashDeclarado) erros.push('HASH DIVERGENTE: ' + rotulo);
  for (const re of SEGREDOS) if (re.test(texto)) erros.push('POSSIVEL SEGREDO em ' + rotulo + ' (' + re + ')');
};
j.tipos.forEach((t) => checa('tipo ' + t.nome, t.ddl, t.sha256));
j.tabelas.forEach((t) => checa('tabela ' + t.nome, t.ddl, t.sha256));
j.funcoes.forEach((f) => checa('funcao ' + f.schema + '.' + f.nome, f.def, f.sha256));
if (erros.length) {
  console.error('FALHOU (' + erros.length + '):\n  ' + erros.join('\n  '));
  console.error('Nada gravado.');
  process.exit(1);
}

const out = ['-- IMPORTACAO GERADA POR importar_prod_defs.mjs — NAO EDITAR.',
             'create schema if not exists internal;',
             'set search_path = public;'];
j.tipos.forEach((t) => out.push(t.ddl.replace(/^create type /, 'do $ begin create type ').replace(/;$/, '; exception when duplicate_object then null; end $;')));
j.tabelas.forEach((t) => out.push(t.ddl.replace(/^create table public/, 'create table if not exists public')));
j.funcoes.forEach((f) => {
  out.push('-- funcao ' + f.schema + '.' + f.nome + '(' + f.args + ')');
  out.push(f.def.trimEnd().endsWith(';') ? f.def : f.def + ';');
});
fs.writeFileSync(saida, out.join('\n') + '\n');
const lit = (x) => "'" + String(x).replace(/'/g, "''") + "'";
const esperados = j.funcoes.map((f) => "(" + [f.schema, f.nome, f.args, f.sha256].map(lit).join(", ") + ")");
fs.writeFileSync(saida + ".hashes.sql", "-- Confere, no banco importado, o sha256 de pg_get_functiondef de cada funcao.\n" +
  "create temp table _esperado(schema_nome text, nome text, args text, sha text);\n" +
  (esperados.length ? "insert into _esperado values\n  " + esperados.join(",\n  ") + ";\n" : ""));
console.log('OK: ' + j.tipos.length + ' tipos, ' + j.tabelas.length + ' tabelas, ' + j.funcoes.length + ' funcoes verificadas por sha256; sem padrao de segredo. Gravado em ' + saida);
