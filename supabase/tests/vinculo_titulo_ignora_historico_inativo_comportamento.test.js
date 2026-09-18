// VINCULO DA MENSALIDADE: HISTORICO INATIVO NAO IMPEDE A AMARRA -- COMPORTAMENTO.
//
// Roda a migration REAL num PostgreSQL real (PGlite), sobre a bancada que ja
// carrega os corpos de PRODUCAO conferidos por md5 (previa do a vista, motor de
// baixa, vinculo do pagamento, gatilhos de parcela e acordo, recuperacao
// automatica). O estado "antes" e o proprio rollback: as mutacoes rodam o corpo
// de producao de hoje e mostram o defeito que a migration fecha.
//
// NENHUM DADO REAL.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { novoBanco, um, boletoDe, comoGestao } from "./fixtures/parcela_paga_antes_20260917/bancada.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const MIGRATION = ler("supabase/migrations/20260918120000_vinculo_titulo_ignora_historico_inativo.sql");
const ROLLBACK = ler("supabase/rollbacks/20260918120000_vinculo_titulo_ignora_historico_inativo.rollback.sql");

// So o bloco de uma funcao do rollback (para mutar UMA funcao e manter a outra).
function blocoDe(texto, nome) {
  const ini = texto.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${nome}\\s*\\(`, "i"));
  const resto = texto.slice(ini);
  const tag = /\bas\s+(\$[A-Za-z_]*\$)/i.exec(resto);
  const fim = resto.indexOf(tag[1], tag.index + tag[0].length);
  return resto.slice(0, resto.indexOf(";", fim + tag[1].length) + 1);
}
const VINCULAR_ANTIGO = blocoDe(ROLLBACK, "vincular_titulos_acordo");
const REGISTRAR_ANTIGO = blocoDe(ROLLBACK, "acordo_avista_registrar");

const OPERADOR = "cobranca12@aelbra.com.br";
const A = (n) => `00000000-0000-4000-8000-0000000${String(n).padStart(5, "0")}`;
const T = (n) => `00000000-0000-4000-a000-0000000${String(n).padStart(5, "0")}`;
const P = (n) => `00000000-0000-4000-9000-0000000${String(n).padStart(5, "0")}`;

// Producao tem o indice unico parcial; a bancada nao. Ele entra aqui porque a
// regra 5 conta com ele como guarda adicional.
async function banco({ nova = true, ligada = false } = {}) {
  const db = await novoBanco({ patch: true, encerrar: true, avista: true, etapaAvistaLigada: ligada });
  await db.exec(`create unique index ux_titulo_vinculo_ativo on public.acordo_titulo_vinculo (titulo_id) where ativo`);
  if (nova) await db.exec(MIGRATION);
  return db;
}

async function aluno(db, n) {
  const id = A(n);
  const numero = String(n);
  const cpf = `7${numero}00000`.slice(0, 11).padEnd(11, "0");
  const matricula = `20260${numero}`;
  const nome = `ALUNA DE TESTE ${numero}`;
  if (!(await um(db, `select count(*)::int from public.usuarios where email = $1`, [OPERADOR]))) {
    await db.query(`insert into public.usuarios (nome, email, perfil, ativo) values ('Operadora', $1, 'operador', true)`, [OPERADOR]);
  }
  await db.query(`insert into public.alunos (id, nome, cpf, cpf_mascarado, matricula, unidade, status_atual, saldo_total)
                  values ($1, $2, $3, '***', $4, 'CANOAS', 'AGUARDANDO_BAIXA', 1000)`, [id, nome, cpf, matricula]);
  await db.query(`insert into public.prime_contratos (cpf, registration) values ($1, $2)`, [cpf, matricula]);
  return { id, nome, matricula, numero };
}

async function titulo(db, al, n, valor = 1000) {
  await db.query(`insert into public.acordos_titulos (id, aluno_id, documento, vencimento, valor_original, saldo_corrigido,
                    situacao, status, tipo_boleto)
                  values ($1, $2, $3, '2026-08-05', $4, $4, 'ABERTO', 'em_aberto', 'Cursos de Graduação')`,
    [T(n), al.id, `doc${n}`, valor]);
  return T(n);
}

async function acordo(db, al, numero, status = "ATIVO") {
  // valor proprio por acordo: a trava de acordo duplicado (mesmo aluno, mesmo
  // valor, mesma quantidade) nao e o assunto deste teste
  return um(db, `insert into public.acordos (aluno_id, numero_ulbra, status, valor_total, qtd_parcelas, criado_por_email)
                 values ($1, $2, $3, $4, 1, 'importacao@sistema') returning id`, [al.id, String(numero), status, numero]);
}

// historico: um vinculo antigo, de um acordo que ja foi embora
async function historicoInativo(db, tituloId, acordoAntigo) {
  await db.query(`insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por, criado_em)
                  values ($1, $2, false, 'historico@teste', '2026-07-01')`, [acordoAntigo, tituloId]);
}

const vincular = (db, ids, acordoId) =>
  um(db, `select public.vincular_titulos_acordo($1::uuid[], $2)`, [ids, acordoId]);

const vinculos = (db, tituloId) => um(db, `select coalesce(jsonb_agg(jsonb_build_object(
    'acordo', v.acordo_id, 'ativo', v.ativo, 'por', v.vinculado_por) order by v.criado_em), '[]'::jsonb)
  from public.acordo_titulo_vinculo v where v.titulo_id = $1`, [tituloId]);

const ativosCom = (db, tituloId, acordoId) => um(db, `select count(*)::int from public.acordo_titulo_vinculo
  where titulo_id = $1 and acordo_id = $2 and coalesce(ativo, true)`, [tituloId, acordoId]);

const maxAtivosPorTitulo = (db) => um(db, `select coalesce(max(n), 0)::int from (
  select count(*) n from public.acordo_titulo_vinculo where coalesce(ativo, true) group by titulo_id) z`);

const fotoVinculo = (db) => um(db, `select jsonb_build_object(
  'titulos', (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.acordos_titulos t),
  'vinculos', (select md5(coalesce(string_agg(v::text, '|' order by v.id), '')) from public.acordo_titulo_vinculo v),
  'acordos', (select md5(coalesce(string_agg(a::text, '|' order by a.id), '')) from public.acordos a))`);

// ---------------------------------------------------------------------------
describe("vincular_titulos_acordo: a regra por mensalidade", () => {
  it("A. título sem histórico ganha o vínculo ativo com o acordo atual", async () => {
    const db = await banco();
    await comoGestao(db);
    const al = await aluno(db, 71001);
    const t = await titulo(db, al, 1);
    const ac = await acordo(db, al, 71001);

    const r = await vincular(db, [t], ac);
    expect(r).toMatchObject({ ok: true, vinculados: 1, ja_estavam: 0, vinculos_criados: 1, amarras_refeitas: 0 });
    expect(await ativosCom(db, t, ac)).toBe(1);
    expect(await um(db, `select situacao || '/' || status from public.acordos_titulos where id = $1`, [t])).toBe("NEGOCIADO/vinculada");
    await db.close();
  });

  it("B. título com vínculo antigo INATIVO ganha o vínculo ativo novo", async () => {
    const db = await banco();
    await comoGestao(db);
    const al = await aluno(db, 71002);
    const t = await titulo(db, al, 2);
    const antigo = await acordo(db, al, 60002, "CANCELADO");
    await historicoInativo(db, t, antigo);
    const ac = await acordo(db, al, 71002);

    const r = await vincular(db, [t], ac);
    expect(r).toMatchObject({ ok: true, vinculados: 1, vinculos_criados: 1 });
    expect(await ativosCom(db, t, ac)).toBe(1);
    await db.close();
  });

  it("B (mutação: corpo de produção de hoje). O mesmo cenário sai 'ok' e SEM vínculo — o defeito", async () => {
    const db = await banco({ nova: false });
    await comoGestao(db);
    const al = await aluno(db, 71002);
    const t = await titulo(db, al, 2);
    const antigo = await acordo(db, al, 60002, "CANCELADO");
    await historicoInativo(db, t, antigo);
    const ac = await acordo(db, al, 71002);

    const r = await vincular(db, [t], ac);
    expect(r).toMatchObject({ ok: true, vinculados: 1 });
    expect(await ativosCom(db, t, ac)).toBe(0); // mensalidade presa ao acordo, sem a linha
    expect(await um(db, `select acordo_id from public.acordos_titulos where id = $1`, [t])).toBe(ac);
    await db.close();
  });

  it("C. o histórico inativo fica exatamente como estava", async () => {
    const db = await banco();
    await comoGestao(db);
    const al = await aluno(db, 71003);
    const t = await titulo(db, al, 3);
    const antigo = await acordo(db, al, 60003, "CANCELADO");
    await historicoInativo(db, t, antigo);
    const antes = await um(db, `select to_jsonb(v) from public.acordo_titulo_vinculo v where titulo_id = $1`, [t]);
    const ac = await acordo(db, al, 71003);

    await vincular(db, [t], ac);
    const depois = await um(db, `select to_jsonb(v) from public.acordo_titulo_vinculo v where titulo_id = $1 and acordo_id = $2`, [t, antigo]);
    expect(depois).toEqual(antes);
    expect(await vinculos(db, t)).toEqual([
      { acordo: antigo, ativo: false, por: "historico@teste" },
      { acordo: ac, ativo: true, por: "amanda.seibel@aelbra.com.br" },
    ]);
    await db.close();
  });

  it("D. vínculo ativo no mesmo acordo é idempotente: nada duplica", async () => {
    const db = await banco();
    await comoGestao(db);
    const al = await aluno(db, 71004);
    const t = await titulo(db, al, 4);
    const ac = await acordo(db, al, 71004);

    await vincular(db, [t], ac);
    const antes = await fotoVinculo(db);
    const r2 = await vincular(db, [t], ac);
    expect(r2).toMatchObject({ ok: true, vinculados: 0, ja_estavam: 1 });
    expect(await ativosCom(db, t, ac)).toBe(1);
    expect(await um(db, `select count(*)::int from public.acordo_titulo_vinculo where titulo_id = $1`, [t])).toBe(1);
    expect(await fotoVinculo(db)).toEqual(antes);
    await db.close();
  });

  it("D2. acordo_id deste acordo SEM a linha do vínculo: só a linha nasce (amarra faltando)", async () => {
    const db = await banco();
    await comoGestao(db);
    const al = await aluno(db, 71014);
    const t = await titulo(db, al, 14);
    const ac = await acordo(db, al, 71014);
    await db.query(`update public.acordos_titulos set acordo_id = $2, situacao = 'NEGOCIADO', status = 'vinculada' where id = $1`, [t, ac]);

    const r = await vincular(db, [t], ac);
    expect(r).toMatchObject({ ok: true, vinculados: 1, amarras_refeitas: 1, vinculos_criados: 1 });
    expect(await ativosCom(db, t, ac)).toBe(1);
    expect(await um(db, `select situacao || '/' || status from public.acordos_titulos where id = $1`, [t])).toBe("NEGOCIADO/vinculada");
    await db.close();
  });

  it("E. vínculo ativo com OUTRO acordo aborta a operação inteira, sem mover nem desativar", async () => {
    const db = await banco();
    await comoGestao(db);
    const al = await aluno(db, 71005);
    const livre = await titulo(db, al, 5);
    const preso = await titulo(db, al, 6);
    const outro = await acordo(db, al, 60005);
    // o outro acordo tem o vinculo ativo, mas a mensalidade ficou sem acordo_id
    await db.query(`insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por, criado_em)
                    values ($1, $2, true, 'outro@teste', now())`, [outro, preso]);
    const ac = await acordo(db, al, 71005);
    const antes = await fotoVinculo(db);

    const r = await vincular(db, [livre, preso], ac);
    expect(r).toMatchObject({ ok: false, erro: "TITULO_COM_VINCULO_ATIVO_EM_OUTRO_ACORDO" });
    expect(r.conflitos).toEqual([{ titulo_id: preso, acordo_id: outro }]);
    // nem a mensalidade livre foi tocada
    expect(await fotoVinculo(db)).toEqual(antes);
    expect(await ativosCom(db, preso, outro)).toBe(1);
    await db.close();
  });

  it("E (mutação: corpo de produção de hoje). O mesmo cenário grava e deixa a mensalidade sem amarra", async () => {
    const db = await banco({ nova: false });
    await comoGestao(db);
    const al = await aluno(db, 71005);
    const preso = await titulo(db, al, 6);
    const outro = await acordo(db, al, 60005);
    await db.query(`insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por, criado_em)
                    values ($1, $2, true, 'outro@teste', now())`, [outro, preso]);
    const ac = await acordo(db, al, 71005);

    const r = await vincular(db, [preso], ac);
    expect(r).toMatchObject({ ok: true, vinculados: 1 });
    // acordo_id aponta para um acordo e o vinculo ativo para outro
    expect(await um(db, `select acordo_id from public.acordos_titulos where id = $1`, [preso])).toBe(ac);
    expect(await ativosCom(db, preso, ac)).toBe(0);
    await db.close();
  });

  it("F. nunca ficam dois vínculos ativos, e o índice único continua de guarda", async () => {
    const db = await banco();
    await comoGestao(db);
    const al = await aluno(db, 71006);
    const t1 = await titulo(db, al, 7);
    const t2 = await titulo(db, al, 8);
    const antigo = await acordo(db, al, 60006, "CANCELADO");
    await historicoInativo(db, t1, antigo);
    const ac = await acordo(db, al, 71006);
    await vincular(db, [t1, t2], ac);
    await vincular(db, [t1, t2], ac);
    const segundo = await acordo(db, al, 71106);
    expect(await vincular(db, [t1], segundo)).toMatchObject({ ok: false, erro: "TITULO_COM_VINCULO_ATIVO_EM_OUTRO_ACORDO" });

    expect(await maxAtivosPorTitulo(db)).toBe(1);
    await expect(db.query(`insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo) values ($1, $2, true)`, [segundo, t1]))
      .rejects.toThrow(/ux_titulo_vinculo_ativo/);
    await db.close();
  });

  it("id de mensalidade que não existe é erro dito, sem gravar nada", async () => {
    const db = await banco();
    await comoGestao(db);
    const al = await aluno(db, 71007);
    const t = await titulo(db, al, 9);
    const ac = await acordo(db, al, 71007);
    const antes = await fotoVinculo(db);
    const r = await vincular(db, [t, T(99999)], ac);
    expect(r).toMatchObject({ ok: false, erro: "TITULO_NAO_ENCONTRADO" });
    expect(await fotoVinculo(db)).toEqual(antes);
    await db.close();
  });
});

// ---------------------------------------------------------------------------
// O registrador do acordo a vista e a recuperacao automatica
// ---------------------------------------------------------------------------
async function semearAvista(db, n, { historico = false } = {}) {
  const al = await aluno(db, n);
  const t = await titulo(db, al, n);
  if (historico) {
    const antigo = await acordo(db, al, 50000 + (n % 10000), "CANCELADO");
    await historicoInativo(db, t, antigo);
  }
  return { al, t };
}

async function pagar(db, n, al, valor = 1100) {
  await db.query(`insert into public.pagamentos (id, numero_parcela_completo, dados, titulo_numero, valor_pago, valor_honorario,
                    data_pagamento, operador_email, operador_nome, aluno_nome, matricula)
                  values ($1, $2, $3, $4, $5, 0, '2026-09-17', $6, 'Operadora', $7, $8)`,
    [P(n), boletoDe(n, 1), JSON.stringify({ vencimento: "2026-09-18", valor_original: valor }),
      String(n), valor, OPERADOR, al.nome, al.matricula]);
  return P(n);
}

const cadeia = (db, pid, t) => um(db, `select jsonb_build_object(
    'pagamento', (select status_conciliacao from public.pagamentos where id = $1),
    'parcela', (select q.status from public.parcelas q where q.origem_baixa_ref = $1::text),
    'acordo', (select a.status from public.parcelas q join public.acordos a on a.id = q.acordo_id where q.origem_baixa_ref = $1::text),
    'mensalidade', (select situacao from public.acordos_titulos where id = $2),
    'vinculo_ativo', (select count(*)::int from public.acordo_titulo_vinculo v
                       join public.parcelas q on q.acordo_id = v.acordo_id and q.origem_baixa_ref = $1::text
                      where v.titulo_id = $2 and coalesce(v.ativo, true)),
    'acordos_novos', (select count(*)::int from public.acordos where numero_ulbra = (select substr(ltrim(numero_parcela_completo,'0'),2,6)::int::text from public.pagamentos where id = $1)))`, [pid, t]);

const FINAL_OK = { pagamento: "BAIXADO", parcela: "PAGO", acordo: "QUITADO", mensalidade: "PAGO", vinculo_ativo: 1, acordos_novos: 1 };

describe("acordo_avista_registrar: a amarra provada", () => {
  it("H. o botão da gestão continua registrando, e a cadeia termina amarrada", async () => {
    const db = await banco();
    const { al, t } = await semearAvista(db, 71938);
    const pid = await pagar(db, 71938, al);
    await comoGestao(db);
    const r = await um(db, `select public.acordo_avista_registrar($1, $2::uuid[], true)`, [pid, [t]]);
    expect(r).toMatchObject({ ok: true, modo: "CONFIRMADO", gravou: true });
    expect(await cadeia(db, pid, t)).toEqual(FINAL_OK);
    await db.close();
  });

  it("H2. o botão da gestão com histórico inativo na mensalidade: agora sai amarrado", async () => {
    const db = await banco();
    const { al, t } = await semearAvista(db, 71939, { historico: true });
    const pid = await pagar(db, 71939, al);
    await comoGestao(db);
    const r = await um(db, `select public.acordo_avista_registrar($1, $2::uuid[], true)`, [pid, [t]]);
    expect(r).toMatchObject({ ok: true, gravou: true });
    expect(await cadeia(db, pid, t)).toEqual(FINAL_OK);
    await db.close();
  });

  it("G. o registrador aborta se a mensalidade ficar sem vínculo, e nada fica gravado", async () => {
    const db = await banco();
    // a mutacao isolada: o vinculador volta ao corpo de producao de hoje e a
    // mensalidade tem historico inativo -- o insert do vinculo e pulado
    await db.exec(VINCULAR_ANTIGO);
    const { al, t } = await semearAvista(db, 71940, { historico: true });
    const pid = await pagar(db, 71940, al);
    await comoGestao(db);
    await expect(db.query(`select public.acordo_avista_registrar($1, $2::uuid[], true)`, [pid, [t]]))
      .rejects.toThrow(/RECUPERACAO_ABORTADA: mensalidade sem vínculo ativo com o acordo criado \(esperados 1, com vínculo 0\)/);
    expect(await um(db, `select count(*)::int from public.acordos where numero_ulbra = '71940'`)).toBe(0);
    expect(await um(db, `select count(*)::int from public.parcelas`)).toBe(0);
    expect(await um(db, `select status_conciliacao from public.pagamentos where id = $1`, [pid])).toBe("AGUARDANDO_ACORDO");
    expect(await um(db, `select situacao from public.acordos_titulos where id = $1`, [t])).toBe("ABERTO");
    await db.close();
  });

  it("G (mutação: registrador de hoje). Com o mesmo vinculador, o corpo antigo aceita o acordo sem amarra", async () => {
    const db = await banco();
    await db.exec(VINCULAR_ANTIGO);
    await db.exec(REGISTRAR_ANTIGO);
    const { al, t } = await semearAvista(db, 71940, { historico: true });
    const pid = await pagar(db, 71940, al);
    await comoGestao(db);
    const r = await um(db, `select public.acordo_avista_registrar($1, $2::uuid[], true)`, [pid, [t]]);
    expect(r).toMatchObject({ ok: true, gravou: true });
    const c = await cadeia(db, pid, t);
    expect(c).toMatchObject({ pagamento: "BAIXADO", acordo: "QUITADO", mensalidade: "PAGO" });
    expect(c.vinculo_ativo).toBe(0); // o estado que a Etapa 2 procura
    await db.close();
  });

  it("G2. o registrador aborta se a mensalidade escolhida tem vínculo ativo em outro acordo", async () => {
    const db = await banco();
    const { al, t } = await semearAvista(db, 71941);
    // vinculo ativo em acordo CANCELADO: a previa nao ve (nao e vivo), o
    // vinculador ve e recusa -- a regra 4 vale para qualquer vinculo ativo
    const cancelado = await acordo(db, al, 51941, "CANCELADO");
    await db.query(`insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por, criado_em)
                    values ($1, $2, true, 'outro@teste', now())`, [cancelado, t]);
    const pid = await pagar(db, 71941, al);
    await comoGestao(db);
    await expect(db.query(`select public.acordo_avista_registrar($1, $2::uuid[], true)`, [pid, [t]]))
      .rejects.toThrow(/TITULO_COM_VINCULO_ATIVO_EM_OUTRO_ACORDO/);
    expect(await um(db, `select count(*)::int from public.acordos where numero_ulbra = '71941'`)).toBe(0);
    expect(await ativosCom(db, t, cancelado)).toBe(1);
    await db.close();
  });
});

describe("recuperação automática continua funcionando", () => {
  it("I e J. sem JWT, pela importação: pagamento BAIXADO, parcela PAGO, acordo QUITADO, mensalidade PAGO, vínculo ativo", async () => {
    const db = await banco({ ligada: true });
    const { al, t } = await semearAvista(db, 71643);
    const pid = await pagar(db, 71643, al);
    expect(await cadeia(db, pid, t)).toEqual(FINAL_OK);
    expect(await um(db, `select vinculado_por from public.acordo_titulo_vinculo where titulo_id = $1`, [t])).toBe("conciliacao@sistema");
    await db.close();
  });

  it("I2. com histórico inativo: a automação agora amarra (antes baixava sem vínculo)", async () => {
    const db = await banco({ ligada: true });
    const { al, t } = await semearAvista(db, 71644, { historico: true });
    const pid = await pagar(db, 71644, al);
    expect(await cadeia(db, pid, t)).toEqual(FINAL_OK);
    await db.close();
  });

  it("I3. a rodada seguinte não duplica nada", async () => {
    const db = await banco({ ligada: true });
    const { al, t } = await semearAvista(db, 71645);
    const pid = await pagar(db, 71645, al);
    const antes = await fotoVinculo(db);
    const r = await um(db, `select public.acordo_avista_recuperar_pendentes(25)`);
    expect(r).toMatchObject({ avaliados: 0, recuperados: 0, erros: 0 });
    expect(await fotoVinculo(db)).toEqual(antes);
    expect(await cadeia(db, pid, t)).toEqual(FINAL_OK);
    await db.close();
  });
});

describe("rollback", () => {
  it("devolve exatamente os corpos de produção de 18/09 (registrar 391bbee9, vincular bfad7027)", async () => {
    const db = await banco();
    await db.exec(ROLLBACK);
    const md5 = await um(db, `select jsonb_object_agg(proname, md5(prosrc)) from pg_proc
      where pronamespace = 'public'::regnamespace and proname in ('vincular_titulos_acordo', 'acordo_avista_registrar')`);
    expect(md5).toEqual({
      vincular_titulos_acordo: "bfad702791416e5fcd84778fe3cb59cb",
      acordo_avista_registrar: "391bbee9993ef143dd4de72b119ca9db",
    });
    await db.close();
  });
});
