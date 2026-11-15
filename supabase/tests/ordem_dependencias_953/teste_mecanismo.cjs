// Mecanismo de ordem da #953: usa o TEXTO REAL das guardas e dos blocos de rollback dos arquivos.
// Objetos são stubs (só existem para os nomes); a validação de corpo NÃO é coberta aqui.
const fs = require("fs"); const { Client } = require("/private/tmp/claude-501/-Users-amandapradoseibel-Documents-crm-reativa-atual/4d7863e1-dc3d-4aba-8437-c22598a1151b/scratchpad/pg2/node_modules/pg");
const R = process.argv[2]; const D = R + "/supabase/aguardando_aprovacao/";
const rd = (f) => fs.readFileSync(D + f, "utf8");
const pick = (s, re) => { const m = s.match(re); if (!m) throw new Error("bloco nao encontrado: " + re); return m[0]; };
const G_TETO = pick(rd("20261114110000_serializar_teto_todos_os_caminhos.sql.pendente"), /-- GUARDA DE ORDEM[\s\S]*?end \$g\$;/);
const G_PRAZO = pick(rd("20261114100000_alinhar_prazo_fidelizacao_data_brasilia.sql.pendente"), /-- GUARDA DE ORDEM[\s\S]*?end \$g\$;/);
const G_ASSUMIR = pick(rd("20261113120000_assumir_caso_fidelizacao_vencida.sql.pendente"), /-- GUARDA DE ORDEM[\s\S]*?end \$g\$;/);
const M_TETO = "comment on function public.trg_impor_teto_operador() is 'ordem-953:teto-20261114110000';";
const M_PRAZO = "comment on function public.caso_dentro_prazo_fidelizacao(date) is 'ordem-953:prazo-20261114100000';";
const RB_TETO = pick(rd("20261114110000_serializar_teto_todos_os_caminhos.rollback.sql"), /-- MARCADOR: reverte[\s\S]*?end \$rbm\$;/);
const RB_PRAZO = pick(rd("20261114100000_alinhar_prazo_fidelizacao_data_brasilia.rollback.sql"), /-- MARCADOR: reverte[\s\S]*?end \$rbm\$;/);
const resultados = []; let falhas = 0;
async function ok(c, nome, sql) { try { await c.query(sql); resultados.push("OK    " + nome); return true; } catch (e) { resultados.push("FAIL  " + nome + " -> " + e.message); falhas++; return false; } }
async function recusa(c, nome, sql, trecho) { try { await c.query(sql); resultados.push("FAIL  " + nome + " (deveria recusar)"); falhas++; } catch (e) { const bate = e.message.includes(trecho); resultados.push((bate ? "OK    " : "FAIL  ") + nome + " -> " + e.message.slice(0, 90)); if (!bate) falhas++; } }
(async () => {
  const admin = new Client({ host: "localhost", port: 5499, user: "postgres", password: "postgres", database: "postgres" }); await admin.connect();
  await admin.query("drop database if exists teste_ordem with (force)"); await admin.query("create database teste_ordem"); await admin.end();
  const c = new Client({ host: "localhost", port: 5499, user: "postgres", password: "postgres", database: "teste_ordem" }); await c.connect();
  await c.query(`create function public.aluno_retorno_operador_vigente(uuid) returns boolean language sql as 'select true';
    create function public.trg_impor_teto_operador() returns trigger language plpgsql as 'begin return new; end';
    create function public.caso_dentro_prazo_fidelizacao(date) returns boolean language sql as 'select true';
    create function public.assumir_caso_fidelizacao_vencida(uuid, text) returns boolean language sql as 'select true';`);
  await recusa(c, "prazo antes do teto: recusado por ORDEM (teto)", G_PRAZO, "ORDEM: teto");
  await recusa(c, "#953 antes do prazo: recusada por ORDEM (prazo)", G_ASSUMIR, "ORDEM: prazo");
  await ok(c, "teto: guarda passa (comentario anterior nulo)", G_TETO);
  await ok(c, "teto: marcador gravado", M_TETO);
  await recusa(c, "teto reaplicado: recusado (ja marcado)", G_TETO, "ja marcado");
  await ok(c, "prazo: guarda passa com teto marcado", G_PRAZO);
  await ok(c, "prazo: marcador gravado", M_PRAZO);
  await ok(c, "#953: guarda passa com prazo marcado", G_ASSUMIR);
  await recusa(c, "rollback do teto com prazo aplicado: recusado", RB_TETO, "prazo (20261114100000) ainda esta aplicado");
  await ok(c, "rollback do prazo: remove o marcador exato", RB_PRAZO);
  await ok(c, "rollback do teto: agora permitido (prazo revertido)", RB_TETO);
  await recusa(c, "apos reverter o teto, o prazo recusa (teto nao aplicado)", G_PRAZO, "ORDEM: teto");
  await ok(c, "reaplicacao: teto", G_TETO); await ok(c, "reaplicacao: marcador teto", M_TETO);
  await ok(c, "reaplicacao: prazo", G_PRAZO); await ok(c, "reaplicacao: marcador prazo", M_PRAZO);
  await ok(c, "reaplicacao: #953", G_ASSUMIR);
  await c.query("comment on function public.caso_dentro_prazo_fidelizacao(date) is 'alterado por terceiro'");
  await recusa(c, "rollback do prazo com comentario alterado por terceiro: recusado", RB_PRAZO, "nao remover");
  await c.end();
  console.log(resultados.join("\n")); console.log(falhas ? `\nFALHOU: ${falhas}` : `\nTodas passaram: ${resultados.length}`);
  process.exitCode = falhas ? 1 : 0;
})().catch((e) => { console.error("erro fatal:", e.message); process.exit(1); });
