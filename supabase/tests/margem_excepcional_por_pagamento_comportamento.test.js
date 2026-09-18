// MARGEM EXCEPCIONAL POR PAGAMENTO, AUTORIZADA PELA GESTAO -- COMPORTAMENTO.
//
// Migration REAL em PGlite, sobre a bancada com os corpos de producao e as
// migrations de 18/09 que vem antes desta. NENHUM DADO REAL.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { novoBanco, um, boletoDe, comoGestao } from "./fixtures/parcela_paga_antes_20260917/bancada.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const ANTES = [
  "supabase/migrations/20260918120000_vinculo_titulo_ignora_historico_inativo.sql",
  "supabase/migrations/20260918140000_previa_ignora_cadastro_duplicado_mesclado.sql",
  "supabase/migrations/20260918160000_acordo_origem_externa_sem_credito.sql",
].map(ler);
const MIGRATION = ler("supabase/migrations/20260918170000_margem_excepcional_por_pagamento.sql");
const ROLLBACK = ler("supabase/rollbacks/20260918170000_margem_excepcional_por_pagamento.rollback.sql");

const OPERADOR = "cobranca12@aelbra.com.br";
const A = (n) => `00000000-0000-4000-8000-0000000${String(n).padStart(5, "0")}`;
const T = (n) => `00000000-0000-4000-a000-0000000${String(n).padStart(5, "0")}`;
const P = (n) => `00000000-0000-4000-9000-0000000${String(n).padStart(5, "0")}`;

async function banco({ nova = true } = {}) {
  const db = await novoBanco({ patch: true, encerrar: true, avista: true });
  await db.exec(`alter table public.alunos add column if not exists observacao text`);
  await db.exec(`create unique index if not exists ux_titulo_vinculo_ativo on public.acordo_titulo_vinculo (titulo_id) where ativo`);
  await db.exec(`create table if not exists public.prime_extrato (matricula text, boleto text, cpf text, vencimento date, liquidado_em date,
                   valor_liquido numeric, valor_pago numeric, honorario numeric, de_acordo boolean, portador int, portador_nome text,
                   coletado_em timestamptz default now(), valor_bruto numeric, desconto numeric, multa numeric, juros numeric)`);
  for (const m of ANTES) await db.exec(m);
  if (nova) await db.exec(MIGRATION);
  await db.query(`insert into public.usuarios (nome, email, perfil, ativo) values ('Rafa', $1, 'operador', true)`, [OPERADOR]);
  return db;
}

// aluno com uma mensalidade de `face`; o Prime corrigiu para `prime`
async function caso(db, n, { face = 216.07, prime = 642.93, pago = 305.45, honorario = 22.63, semPrime = false } = {}) {
  const numero = String(n);
  const cpf = `9${numero}00000`.slice(0, 11).padEnd(11, "0");
  const matricula = `20240${numero}`;
  const nome = `ALUNO MARGEM ${numero}`;
  await db.query(`insert into public.alunos (id, nome, cpf, cpf_mascarado, matricula, unidade, status_atual, saldo_total)
                  values ($1, $2, $3, '***', $4, 'CANOAS', 'AGUARDANDO_BAIXA', $5)`, [A(n), nome, cpf, matricula, face]);
  await db.query(`insert into public.prime_contratos (cpf, registration) values ($1, $2)`, [cpf, matricula]);
  await db.query(`insert into public.acordos_titulos (id, aluno_id, documento, vencimento, valor_original, saldo_corrigido,
                    situacao, status, tipo_boleto)
                  values ($1, $2, $3, '2025-06-05', $4, $4, 'ABERTO', 'em_aberto', 'Cursos de Graduação')`, [T(n), A(n), `doc${numero}`, face]);
  if (!semPrime) {
    await db.query(`insert into public.prime_extrato (matricula, boleto, cpf, liquidado_em, valor_pago, valor_bruto)
                    values ($1, $2, $3, '2026-09-11', $4, 0)`, [matricula, `doc${numero}`, cpf, prime]);
  }
  await db.query(`insert into public.pagamentos (id, numero_parcela_completo, dados, titulo_numero, valor_pago, valor_honorario,
                    data_pagamento, operador_email, operador_nome, aluno_nome, matricula)
                  values ($1, $2, $3, $4, $5, $6, '2026-09-11', $7, 'Rafa', $8, $9)`,
    [P(n), boletoDe(n, 1), JSON.stringify({ vencimento: "2026-09-12", valor_original: pago }), numero, pago, honorario, OPERADOR, nome, matricula]);
  return { pid: P(n), titulo: T(n), aluno: A(n) };
}

const previa = (db, pid) => um(db, `select public.acordo_avista_previa($1, null)`, [pid]);
const autorizar = async (db, pid) => { await comoGestao(db); return um(db, `select public.pagamento_autorizar_margem_excepcional($1, 'base entre o titulo e o corrigido do Prime')`, [pid]); };
const registrar = async (db, pid, titulo) => { await comoGestao(db); return um(db, `select public.acordo_avista_registrar($1, $2::uuid[], true)`, [pid, [titulo]]); };

describe("a margem global continua 1,15", () => {
  it("sem autorização, acima da margem continua bloqueado (e dentro dela continua passando)", async () => {
    const db = await banco();
    const c = await caso(db, 71770);
    expect((await previa(db, c.pid)).bloqueios).toEqual(["DIFERENCA_DENTRO_DA_MARGEM_SEGURA"]);
    const d = await caso(db, 71771, { face: 300, pago: 330, honorario: 24.44, prime: 600 });
    expect((await previa(db, d.pid)).aprovado).toBe(true);
    await db.close();
  });
});

describe("autorização um a um", () => {
  it("autoriza, registra e fecha a cadeia; auditoria com todos os números", async () => {
    const db = await banco();
    const c = await caso(db, 71770);
    const a = await autorizar(db, c.pid);
    expect(a).toMatchObject({ ok: true, base: 282.82, soma_titulos: 216.07, valor_prime: 642.93, diferenca: 66.75 });
    const p = await previa(db, c.pid);
    expect(p.aprovado).toBe(true);
    expect(p.margem_excepcional).toMatchObject({ base: 282.82, valor_prime: 642.93, autorizado_por: "amanda.seibel@aelbra.com.br" });
    const r = await registrar(db, c.pid, c.titulo);
    expect(r).toMatchObject({ ok: true, gravou: true });
    const cad = await um(db, `select jsonb_build_object(
      'pag', (select status_conciliacao from public.pagamentos where id = $1),
      'acordo', (select a.status from public.acordos a join public.parcelas q on q.acordo_id = a.id where q.origem_baixa_ref = $1::text),
      'parcela', (select status from public.parcelas where origem_baixa_ref = $1::text),
      'mens', (select situacao from public.acordos_titulos where id = $2),
      'vinc', (select count(*)::int from public.acordo_titulo_vinculo where titulo_id = $2 and ativo))`, [c.pid, c.titulo]);
    expect(cad).toEqual({ pag: "BAIXADO", acordo: "QUITADO", parcela: "PAGO", mens: "PAGO", vinc: 1 });
    const aud = await um(db, `select detalhes from public.auditoria where acao = 'AUTORIZACAO_GESTAO_MARGEM_EXCEPCIONAL'`);
    expect(aud).toMatchObject({ valor_pago: 305.45, base_sem_honorario: 282.82, valor_titulos: 216.07, valor_prime: 642.93,
      diferenca: 66.75, autorizado_por: "amanda.seibel@aelbra.com.br" });
    expect(await um(db, `select detalhes->'margem_excepcional'->>'valor_prime' from public.auditoria where acao = 'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO'`)).toBe("642.93");
    expect(await um(db, `select usado_em is not null from public.pagamento_margem_autorizada`)).toBe(true);
    await db.close();
  });

  it("a autorização não vale para outro pagamento com a mesma proporção", async () => {
    const db = await banco();
    const c1 = await caso(db, 71770);
    await autorizar(db, c1.pid);
    const c2 = await caso(db, 71772);
    expect((await previa(db, c2.pid)).bloqueios).toEqual(["DIFERENCA_DENTRO_DA_MARGEM_SEGURA"]);
    await db.close();
  });

  it("se as mensalidades mudarem depois da autorização, a prévia volta a bloquear", async () => {
    const db = await banco();
    const c = await caso(db, 71770);
    await autorizar(db, c.pid);
    await db.query(`update public.acordos_titulos set saldo_corrigido = 216.00 where id = $1`, [c.titulo]);
    expect((await previa(db, c.pid)).bloqueios).toContain("DIFERENCA_DENTRO_DA_MARGEM_SEGURA");
    await db.close();
  });

  it("recusa: base acima do Prime (C), sem valor do Prime, honorário fora de 8%, outro bloqueio, não-gestão", async () => {
    const db = await banco();
    const c1 = await caso(db, 71802, { face: 248.59, prime: 89.74, pago: 365.40, honorario: 27.07 });
    expect(await autorizar(db, c1.pid)).toMatchObject({ ok: false, erro: "BASE_FORA_DO_INTERVALO_COMPROVADO" });
    const c2 = await caso(db, 71803, { semPrime: true });
    expect(await autorizar(db, c2.pid)).toMatchObject({ ok: false, erro: "SEM_VALOR_DO_PRIME_PARA_TODAS_AS_MENSALIDADES" });
    const c3 = await caso(db, 71804, { honorario: 0 });
    expect(await autorizar(db, c3.pid)).toMatchObject({ ok: false, erro: "HONORARIO_FORA_DE_8_POR_CENTO" });
    const c4 = await caso(db, 71805);
    await db.query(`delete from public.usuarios where email = $1`, [OPERADOR]);
    expect(await autorizar(db, c4.pid)).toMatchObject({ ok: false, erro: "OUTRO_BLOQUEIO_ALEM_DA_MARGEM" });
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ email: "cobranca99@aelbra.com.br", role: "authenticated" })]);
    await expect(db.query(`select public.pagamento_autorizar_margem_excepcional($1, 'tentativa de operador')`, [c1.pid]))
      .rejects.toThrow(/decisão da gestão financeira/);
    expect(await um(db, `select count(*)::int from public.pagamento_margem_autorizada`)).toBe(0);
    await db.close();
  });

  it("mutação: com a prévia de hoje, a mesma autorização não abre o registro", async () => {
    const db = await banco();
    const c = await caso(db, 71770);
    await autorizar(db, c.pid);
    const reversao = ROLLBACK.split("drop function")[0];
    await db.exec(reversao);
    expect((await previa(db, c.pid)).bloqueios).toEqual(["DIFERENCA_DENTRO_DA_MARGEM_SEGURA"]);
    await db.close();
  });
});

describe("rollback", () => {
  it("devolve prévia 580559d1 e registrador 5746cfee e remove a autorização", async () => {
    const db = await banco();
    await db.exec(ROLLBACK);
    expect(await um(db, `select jsonb_object_agg(proname, md5(prosrc)) from pg_proc where proname in ('acordo_avista_previa', 'acordo_avista_registrar')`))
      .toEqual({ acordo_avista_previa: "580559d16cd7bfbfaa1f5786b31bd72b", acordo_avista_registrar: "5746cfee2f9d4e7cc53f287ddf21e1a5" });
    expect(await um(db, `select to_regclass('public.pagamento_margem_autorizada') is null`)).toBe(true);
    await db.close();
  });
});
