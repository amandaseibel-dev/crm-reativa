// REPROCESSAMENTO CONTROLADO DOS 69 -- COMPORTAMENTO, nao estrutura.
//
// Executa a migration REAL num PostgreSQL real (PGlite) contra o MOTOR REAL:
// `pagamento_conciliar_um`, `documento_casa_com_parcela` e
// `vencimento_do_pagamento` sao lidos das migrations do repositorio e o teste
// exige o md5 de producao antes de usa-los. Os gatilhos de `parcelas` que a
// baixa dispara e que decidem o resultado (`_acordo_fecha_com_a_ultima_parcela`,
// `_bloquear_parcela_baixa_acordo_encerrado`, `_parcela_pago_em_automatico`,
// `_trg_recalc_por_parcela`) sao reproduzidos BYTE A BYTE de producao, com md5
// conferido aqui.
//
// `recalcular_situacao_aluno` e um DUBLE que escreve em alunos e casos e chama
// `nextval('chamadas_recalc')`: sequencia NAO e desfeita por rollback. E assim
// que o teste prova que o motor CHEGOU a baixar antes de a migration abortar --
// e que o rollback desfez tudo mesmo assim.
//
// Os valores que dependem de dados (748, 69, R$, 23, 21, 95, hashes) sao
// trocados pelos do fixture, calculados AQUI em JS de forma independente do SQL.
//
// NENHUM DADO REAL.
import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const raiz = (p) => resolve(AQUI, "..", "..", p);
const SQL_REAL = readFileSync(raiz("supabase/migrations/20260916150000_reprocessa_69_pagamentos_do_backfill_392.sql"), "utf8");
const MOTOR_ARQ = readFileSync(raiz("supabase/migrations/20260915120000_titulo_liquidado_na_origem.sql"), "utf8");
const DOC_ARQ = readFileSync(raiz("supabase/migrations/20260908200000_baixa_pelo_documento_respeita_vencimento.sql"), "utf8");

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

function recorta(texto, inicio, abre, fecha) {
  const i = texto.indexOf(inicio);
  if (i < 0) throw new Error("nao achei " + inicio);
  const a = texto.indexOf(abre, i) + abre.length;
  const b = texto.indexOf(fecha, a);
  return { comando: texto.slice(i, b + fecha.length), corpo: texto.slice(a, b) };
}
const MOTOR = recorta(MOTOR_ARQ, "create or replace function public.pagamento_conciliar_um(", "as $motor$", "$motor$;");
const VENC = recorta(DOC_ARQ, "create or replace function public.vencimento_do_pagamento(", "as $$", "$$;");
const DOCC = recorta(DOC_ARQ, "create or replace function public.documento_casa_com_parcela(", "as $$", "$$;");

// --- corpos EXATOS de producao ------------------------------------------------
const CORPO_RECALC = "\ndeclare v_aluno uuid;\nbegin\n  begin\n    select a.aluno_id into v_aluno from public.acordos a\n     where a.id = coalesce(NEW.acordo_id, OLD.acordo_id);\n    if v_aluno is not null then perform public.recalcular_situacao_aluno(v_aluno, 'trg_parcela'); end if;\n  exception when others then null;\n  end;\n  return null;\nend; ";
const CORPO_PAGO_EM = "\nbegin\n  if new.status = 'PAGO' and new.pago_em is null then\n    new.pago_em := now();\n  end if;\n  return new;\nend;\n";
const CORPO_FECHA = "\ndeclare v_acordo uuid;\nbegin\n  v_acordo := coalesce(new.acordo_id, old.acordo_id);\n  if v_acordo is null then return null; end if;\n\n  update public.acordos a\n     set status = 'QUITADO', saldo = 0,\n         motivo_ajuste = coalesce(a.motivo_ajuste,'')\n           || case when coalesce(a.motivo_ajuste,'')='' then '' else ' | ' end\n           || 'quitado automaticamente: a ultima parcela foi paga',\n         atualizado_em = now()\n   where a.id = v_acordo\n     and upper(coalesce(a.status,'')) = 'ATIVO'\n     and exists (select 1 from public.parcelas p where p.acordo_id = a.id)\n     and not exists (select 1 from public.parcelas p where p.acordo_id = a.id\n                      and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA'));\n\n  return null;\nend;\n";
const CORPO_BLOQUEIA = "\ndeclare v_status text;\nbegin\n  if new.status = 'PAGO' and coalesce(old.status,'') is distinct from 'PAGO' then\n    select upper(coalesce(status,'')) into v_status from public.acordos where id = new.acordo_id;\n    if v_status = 'CANCELADO' then\n      raise exception 'acordo_cancelado_operacao_nao_permitida' using errcode='P0001';\n    end if;\n  end if;\n  return new;\nend; ";

const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const AL1 = U(901), AL2 = U(902), AL3 = U(903);
const AC1 = U(801), AC2 = U(802), AC3 = U(803);
const P = (n) => U(100 + n);
const G = (n) => U(200 + n);

// o "lote do #392" do fixture: 6 parcelas com boleto restaurado
const LOTE = [
  { parcela_id: P(1), acordo_id: AC1, lote: "L1", bp: 11, bt: 12, bol: "50111110001" },
  { parcela_id: P(2), acordo_id: AC1, lote: "L1", bp: 13, bt: 14, bol: "50111110002" },
  { parcela_id: P(3), acordo_id: AC2, lote: "L2", bp: 15, bt: 16, bol: "50222220001" },
  { parcela_id: P(4), acordo_id: AC2, lote: "L2", bp: 17, bt: 18, bol: "50222220002" },
  { parcela_id: P(5), acordo_id: AC3, lote: "L3", bp: 19, bt: 20, bol: "50333330001" },
  { parcela_id: P(6), acordo_id: AC3, lote: "L3", bp: 21, bt: 22, bol: "50333330002" },
];
const LOTE_HASH = sha256([...LOTE].sort((a, b) => (a.parcela_id < b.parcela_id ? -1 : 1))
  .map((c) => [c.parcela_id, c.acordo_id, c.lote, c.bp, c.bt, "0" + c.bol, c.bol].join("|")).join("\n"));

// o conjunto esperado, na ordem da fila (data_pagamento, id)
const ALVO = [
  { pid: G(1), parcela: P(1), acordo: AC1, aluno: AL1, valor: "100.00", data: "2026-09-11" },
  { pid: G(2), parcela: P(2), acordo: AC1, aluno: AL1, valor: "100.00", data: "2026-09-12" },
  { pid: G(3), parcela: P(3), acordo: AC2, aluno: AL2, valor: "200.00", data: "2026-09-13" },
];
const alvoHash = (alvo) => sha256(alvo.map((a) => [a.pid, a.parcela, a.acordo, a.aluno, a.valor, a.data].join("|")).join("\n"));

const FIXTURE = {
  lote_hash: LOTE_HASH, lote_qtd: 6, lote_trilha: "{11,13,15,17,19,21}", alvo_hash: alvoHash(ALVO),
  qtd: 3, valor: "400.00", parcelas: 3, acordos: 2, alunos: 2, quitados: 1, sem_status: 2,
  fila_outros: "AGUARDANDO_ACORDO=1;PARCELA_JA_PAGA=1",
};

function migracao(v = FIXTURE, trocas = []) {
  let s = SQL_REAL
    .replace(/(c_lote_hash\s+constant text\s+:=\s+)'[^']*';/, `$1'${v.lote_hash}';`)
    .replace(/(c_lote_qtd\s+constant integer\s+:=\s+)\d+;/, `$1${v.lote_qtd};`)
    .replace(/(c_lote_trilha\s+constant bigint\[\]\s+:=\s+)'[^']*';/, `$1'${v.lote_trilha}';`)
    .replace(/(c_alvo_hash\s+constant text\s+:=\s+)'[^']*';/, `$1'${v.alvo_hash}';`)
    .replace(/(c_qtd\s+constant integer\s+:=\s+)\d+;/, `$1${v.qtd};`)
    .replace(/(c_valor\s+constant numeric\s+:=\s+)[\d.]+;/, `$1${v.valor};`)
    .replace(/(c_parcelas\s+constant integer\s+:=\s+)\d+;/, `$1${v.parcelas};`)
    .replace(/(c_acordos\s+constant integer\s+:=\s+)\d+;/, `$1${v.acordos};`)
    .replace(/(c_alunos\s+constant integer\s+:=\s+)\d+;/, `$1${v.alunos};`)
    .replace(/(c_quitados\s+constant integer\s+:=\s+)\d+;/, `$1${v.quitados};`)
    .replace(/(c_sem_status\s+constant integer\s+:=\s+)\d+;/, `$1${v.sem_status};`)
    .replace(/(c_fila_outros\s+constant text\s+:=\s+)'[^']*';/, `$1'${v.fila_outros}';`);
  for (const [de, para] of trocas) {
    if (!s.includes(de)) throw new Error("mutacao nao encontrou o alvo: " + de.slice(0, 60));
    s = s.replace(de, para);
  }
  return s;
}

async function novoBanco() {
  const db = new PGlite();
  await db.exec(`
    create table public.alunos (id uuid primary key, nome text, cpf_mascarado text, matricula text, situacao text);
    create table public.casos (id uuid primary key default gen_random_uuid(), aluno_id uuid, situacao text);
    create table public.acordos (id uuid primary key, aluno_id uuid, status text, numero_ulbra text,
      saldo numeric, motivo_ajuste text, atualizado_em timestamptz);
    create table public.parcelas (id uuid primary key, acordo_id uuid, numero int, valor numeric, vencimento date,
      status text, pago_em timestamptz, confirmado_por_email text, observacao text, atualizado_em timestamptz,
      honorarios numeric, boleto text, boleto_confiavel boolean not null default false,
      origem_baixa text, origem_baixa_ref text, origem_baixa_em timestamptz);
    create table public.pagamentos (id uuid primary key, numero_parcela_completo text, dados jsonb,
      status_conciliacao text, conciliacao_motivo text, conciliacao_em timestamptz, cpf text, titulo_numero text,
      valor_pago numeric(14,2), retroativo boolean not null default false, data_pagamento date,
      operador_email text, valor_honorario numeric, aluno_id uuid, aluno_nome text, importacao_id uuid, matricula text);
    create table public.fila_pagamento_sem_vinculo (id bigserial primary key, pagamento_id uuid not null unique,
      importacao_id uuid, arquivo_nome text, boleto text, data_pagamento date, valor_pago numeric, valor_honorario numeric,
      nome_recebido text, cpf_recebido text, matricula_recebida text, sugestoes jsonb not null default '[]',
      motivo text not null default '', decisao text, decidido_por text, decidido_em timestamptz, observacao text,
      status_conciliacao text, evidencia_origem text, evidencia_em timestamptz, consulta_estrutura_resultado text);
    create table public.baixas_pagamento (parcela_id uuid, baixado_por_email text, baixado_em timestamptz, devolvido_em timestamptz);
    create table public.prime_portador_membro (cpf text, portador int, coletado_em timestamptz);
    create table public.auditoria (id uuid primary key default gen_random_uuid(), usuario text, acao text,
      tabela_afetada text, registro_id uuid, detalhes jsonb);
    create table public.importacoes (id uuid primary key, arquivo_nome text);
    create table public._backup_completar_parcelas_lote (id bigint primary key, lote text, acordo_id uuid, acao text,
      parcela_id uuid, titulo_snapshot jsonb);
    create table public.fluxo_pagamentos_config (etapa text primary key, ligado boolean not null, observacao text,
      alterado_em timestamptz not null default now(), alterado_por text);

    create sequence public.chamadas_recalc;
    create function public.recalcular_situacao_aluno(p_aluno_id uuid, p_lote text default null) returns jsonb
      language plpgsql as $$
      begin
        perform nextval('public.chamadas_recalc');
        update public.alunos set situacao = 'RECALCULADO' where id = p_aluno_id;
        update public.casos  set situacao = 'RECALCULADO' where aluno_id = p_aluno_id;
        return '{}'::jsonb;
      end $$;
  `);
  await db.exec(VENC.comando);
  await db.exec(DOCC.comando);
  await db.exec(MOTOR.comando);
  await db.query(`create function public._trg_recalc_por_parcela() returns trigger language plpgsql security definer set search_path to 'public' as $b$${CORPO_RECALC}$b$`);
  await db.query(`create function public._parcela_pago_em_automatico() returns trigger language plpgsql security definer set search_path to 'public' as $b$${CORPO_PAGO_EM}$b$`);
  await db.query(`create function public._acordo_fecha_com_a_ultima_parcela() returns trigger language plpgsql security definer set search_path to 'public' as $b$${CORPO_FECHA}$b$`);
  await db.query(`create function public._bloquear_parcela_baixa_acordo_encerrado() returns trigger language plpgsql security definer set search_path to 'public' as $b$${CORPO_BLOQUEIA}$b$`);
  await db.exec(`
    create trigger trg_bloquear_parcela_baixa_acordo_encerrado before update on public.parcelas
      for each row execute function _bloquear_parcela_baixa_acordo_encerrado();
    create trigger trg_parcela_pago_em_automatico before insert or update on public.parcelas
      for each row execute function _parcela_pago_em_automatico();
    create trigger trg_acordo_fecha_com_a_ultima_parcela after update of status on public.parcelas
      for each row execute function _acordo_fecha_com_a_ultima_parcela();
    create trigger trg_recalc_parcela after insert or delete or update on public.parcelas
      for each row execute function _trg_recalc_por_parcela();
  `);

  await db.exec(`alter table public.parcelas disable trigger trg_recalc_parcela`);
  await db.query(`insert into public.alunos (id, nome, situacao) values ($1,'A1','ORIGINAL'),($2,'A2','ORIGINAL'),($3,'A3','ORIGINAL')`, [AL1, AL2, AL3]);
  await db.query(`insert into public.casos (aluno_id, situacao) values ($1,'ORIGINAL'),($2,'ORIGINAL'),($3,'ORIGINAL')`, [AL1, AL2, AL3]);
  await db.query(`insert into public.acordos (id, aluno_id, status, numero_ulbra) values
    ($1,$2,'ATIVO','11111'),($3,$4,'ATIVO','22222'),($5,$6,'ATIVO','33333')`, [AC1, AL1, AC2, AL2, AC3, AL3]);
  const parcela = (id, ac, num, valor, venc, status, boleto, extra = {}) =>
    db.query(`insert into public.parcelas (id,acordo_id,numero,valor,vencimento,status,boleto,pago_em,origem_baixa_ref)
              values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, ac, num, valor, venc, status, boleto, extra.pago_em ?? null, extra.ref ?? null]);
  await parcela(P(1), AC1, 1, 100, "2026-09-10", "A_VENCER", "50111110001");
  await parcela(P(2), AC1, 2, 100, "2026-10-10", "A_VENCER", "50111110002");
  await parcela(P(3), AC2, 1, 200, "2026-09-10", "VENCIDA", "50222220001");
  await parcela(P(4), AC2, 2, 200, "2026-10-10", "A_VENCER", "50222220002");
  await parcela(P(5), AC3, 1, 50, "2026-09-10", "A_VENCER", "50333330001");
  await parcela(P(6), AC3, 2, 50, "2026-10-10", "A_VENCER", "50333330002");
  await parcela(P(9), AC3, 3, 70, "2026-08-10", "PAGO", "59999990002", { pago_em: "2026-08-10", ref: "outra-baixa" });
  for (const c of LOTE) {
    await db.query(`insert into public._backup_completar_parcelas_lote (id,lote,acordo_id,acao,parcela_id) values ($1,$2,$3,'PARCELA_CRIADA',$4)`,
      [c.bp, c.lote, c.acordo_id, c.parcela_id]);
    await db.query(`insert into public._backup_completar_parcelas_lote (id,lote,acordo_id,acao,titulo_snapshot) values ($1,$2,$3,'TITULO_QUARENTENA',$4)`,
      [c.bt, c.lote, c.acordo_id, JSON.stringify({ documento: "0" + c.bol })]);
  }
  const pag = (id, bol, valor, data, venc, status) =>
    db.query(`insert into public.pagamentos (id,numero_parcela_completo,valor_pago,data_pagamento,dados,status_conciliacao)
              values ($1,$2,$3,$4,$5,$6)`, [id, bol, valor, data, JSON.stringify({ vencimento: venc }), status]);
  await pag(G(1), "50111110001", "100.00", "2026-09-11", "2026-09-10", "AGUARDANDO_AMARRACAO");
  await pag(G(2), "50111110002", "100.00", "2026-09-12", "2026-10-10", "AGUARDANDO_AMARRACAO");
  await pag(G(3), "50222220001", "200.00", "2026-09-13", "2026-09-10", "AGUARDANDO_AMARRACAO");
  await pag(G(4), "50222220002", "200.00", "2026-09-05", "2026-10-10", null);
  await pag(G(5), "50333330001", "50.00", "2026-09-06", "2026-09-10", null);
  await pag(G(6), "59999990001", "80.00", "2026-09-07", "2026-09-07", "AGUARDANDO_ACORDO");
  await pag(G(7), "59999990002", "70.00", "2026-09-08", "2026-08-10", "PARCELA_JA_PAGA");
  for (const g of [1, 2, 3, 6, 7]) {
    await db.query(`insert into public.fila_pagamento_sem_vinculo (pagamento_id, motivo, status_conciliacao)
                    select id, 'pendente', status_conciliacao from public.pagamentos where id = $1`, [G(g)]);
  }
  await db.exec(`insert into public.fluxo_pagamentos_config (etapa, ligado, observacao, alterado_em) values
    ('amarrar_boleto', true, 'x', '2026-08-31'), ('baixa_pelo_relatorio', false, 'pausado', '2026-09-16'),
    ('baixa_por_documento', false, 'x', '2026-08-31'), ('consulta_portador', false, 'x', '2026-09-15')`);
  await db.exec(`alter table public.parcelas enable trigger trg_recalc_parcela`);
  await db.exec(`alter sequence public.chamadas_recalc restart`);
  return db;
}

const chamadasRecalc = async (db) =>
  Number((await db.query(`select case when is_called then last_value else 0 end n from public.chamadas_recalc`)).rows[0].n);

async function retrato(db) {
  const q = async (s) => JSON.stringify((await db.query(s)).rows);
  return {
    pagamentos: await q("select * from public.pagamentos order by id"),
    parcelas: await q("select * from public.parcelas order by id"),
    acordos: await q("select * from public.acordos order by id"),
    fila: await q("select * from public.fila_pagamento_sem_vinculo order by pagamento_id"),
    config: await q("select * from public.fluxo_pagamentos_config order by etapa"),
    alunos: await q("select * from public.alunos order by id"),
    casos: await q("select aluno_id, situacao from public.casos order by aluno_id"),
    auditoria: await q("select acao, registro_id, detalhes from public.auditoria order by acao, registro_id"),
  };
}

async function falhaSemEfeito(db, sql, motivo) {
  const antes = await retrato(db);
  await expect(db.exec(sql)).rejects.toThrow(motivo);
  expect(await retrato(db)).toEqual(antes);
}

describe("pre-condicoes do fixture: o motor e os gatilhos sao os de producao", () => {
  it("motor, documento_casa_com_parcela e vencimento_do_pagamento lidos do repo tem o md5 de producao", () => {
    expect(md5(MOTOR.corpo)).toBe("fa3d64add73e0e73e587e16f0c0624d1");
    expect(md5(DOCC.corpo)).toBe("8dc19271b478f12b4841a5ab7729ad1b");
    expect(md5(VENC.corpo)).toBe("4f4668a6b0da45839390d66306c0f397");
  });
  it("gatilhos de parcelas reproduzidos byte a byte", () => {
    expect(md5(CORPO_FECHA)).toBe("9a2301342f99c312e7bfa971ac621a1e");
    expect(md5(CORPO_BLOQUEIA)).toBe("eea504e2c7d47256d3f5e2b29d2bba4a");
    expect(md5(CORPO_PAGO_EM)).toBe("25bf0fb40ae9651c80dfdc3f6a1df491");
    expect(md5(CORPO_RECALC)).toBe("8632b2fcc49b7899fd48dc3801f6a309");
  });
  it("o md5 do motor pinado na migration e o de producao", () => {
    expect(SQL_REAL).toContain("c_motor_md5    constant text     := 'fa3d64add73e0e73e587e16f0c0624d1';");
  });
});

describe("caminho feliz: os 3 do fixture (69 em producao)", () => {
  it("o motor baixa exatamente o conjunto, na ordem da fila, e nada mais muda", async () => {
    const db = await novoBanco();
    const antes = await retrato(db);
    await db.exec(migracao());
    const depois = await retrato(db);

    const pags = Object.fromEntries((await db.query("select id, status_conciliacao from public.pagamentos")).rows.map((r) => [r.id, r.status_conciliacao]));
    expect([pags[G(1)], pags[G(2)], pags[G(3)]]).toEqual(["BAIXADO", "BAIXADO", "BAIXADO"]);

    const parc = (await db.query(`select id, status, origem_baixa, origem_baixa_ref, pago_em::date::text pago
                                    from public.parcelas where id in ($1,$2,$3) order by id`, [P(1), P(2), P(3)])).rows;
    expect(parc).toEqual([
      { id: P(1), status: "PAGO", origem_baixa: "GATILHO_IMPORTACAO", origem_baixa_ref: G(1), pago: "2026-09-11" },
      { id: P(2), status: "PAGO", origem_baixa: "GATILHO_IMPORTACAO", origem_baixa_ref: G(2), pago: "2026-09-12" },
      { id: P(3), status: "PAGO", origem_baixa: "GATILHO_IMPORTACAO", origem_baixa_ref: G(3), pago: "2026-09-13" },
    ]);

    const ac = Object.fromEntries((await db.query("select id, status from public.acordos")).rows.map((r) => [r.id, r.status]));
    expect(ac).toEqual({ [AC1]: "QUITADO", [AC2]: "ATIVO", [AC3]: "ATIVO" });

    // fora do conjunto: identico
    const soFora = (json, ids) => JSON.parse(json).filter((r) => ids.includes(r.id));
    expect(soFora(depois.pagamentos, [G(4), G(5), G(6), G(7)])).toEqual(soFora(antes.pagamentos, [G(4), G(5), G(6), G(7)]));
    expect(soFora(depois.parcelas, [P(4), P(5), P(6), P(9)])).toEqual(soFora(antes.parcelas, [P(4), P(5), P(6), P(9)]));
    const filaFora = (json) => JSON.parse(json).filter((r) => [G(6), G(7)].includes(r.pagamento_id));
    expect(filaFora(depois.fila)).toEqual(filaFora(antes.fila));
    expect(depois.config).toEqual(antes.config);

    // o motor recalculou quem baixou
    expect(await chamadasRecalc(db)).toBeGreaterThan(0);
  });
});

describe("o conjunto precisa ser exatamente o aprovado", () => {
  it("68: um dos alvos sai de AGUARDANDO_AMARRACAO -> aborta sem efeito", async () => {
    const db = await novoBanco();
    await db.query(`update public.pagamentos set status_conciliacao = 'REVISAO' where id = $1`, [G(3)]);
    await falhaSemEfeito(db, migracao(), /2 pagamentos no conjunto/);
    expect(await chamadasRecalc(db)).toBe(0);
  });
  it("70: aparece mais um AGUARDANDO_AMARRACAO ligado ao lote -> aborta sem efeito", async () => {
    const db = await novoBanco();
    await db.query(`insert into public.pagamentos (id,numero_parcela_completo,valor_pago,data_pagamento,dados,status_conciliacao)
                    values ($1,'50333330002',50.00,'2026-09-14','{"vencimento":"2026-10-10"}','AGUARDANDO_AMARRACAO')`, [G(8)]);
    await falhaSemEfeito(db, migracao(), /4 pagamentos no conjunto/);
  });
  it("valor diferente do aprovado -> aborta sem efeito", async () => {
    const db = await novoBanco();
    await db.query(`update public.pagamentos set valor_pago = 100.01 where id = $1`, [G(1)]);
    await falhaSemEfeito(db, migracao(), /valor do conjunto 400.01 difere do aprovado 400.00/);
  });
  it("um dos pagamentos sem status (os 95) entra no conjunto -> aborta sem efeito", async () => {
    const db = await novoBanco();
    await db.query(`update public.pagamentos set status_conciliacao = 'AGUARDANDO_AMARRACAO' where id = $1`, [G(4)]);
    await falhaSemEfeito(db, migracao(), /4 pagamentos no conjunto/);
  });
  it("mesmo com a contagem certa, um dos 95 trocado por um alvo e barrado pelo hash e pela contagem dos 95", async () => {
    const db = await novoBanco();
    await db.query(`update public.pagamentos set status_conciliacao = 'REVISAO' where id = $1`, [G(3)]);
    await db.query(`update public.pagamentos set status_conciliacao = 'AGUARDANDO_AMARRACAO' where id = $1`, [G(4)]);
    await falhaSemEfeito(db, migracao(), /valor do conjunto|SHA256 do conjunto/);
  });
  it("pagamento AGUARDANDO_AMARRACAO fora das 748 -> aborta sem efeito", async () => {
    const db = await novoBanco();
    await db.query(`insert into public.parcelas (id,acordo_id,numero,valor,vencimento,status,boleto)
                    values ($1,$2,9,90,'2026-09-10','A_VENCER','59999990003')`, [P(10), AC3]);
    await db.query(`insert into public.pagamentos (id,numero_parcela_completo,valor_pago,data_pagamento,dados,status_conciliacao)
                    values ($1,'59999990003',90.00,'2026-09-14','{"vencimento":"2026-09-10"}','AGUARDANDO_AMARRACAO')`, [G(8)]);
    await falhaSemEfeito(db, migracao(), /1 pagamentos AGUARDANDO_AMARRACAO fora do conjunto aprovado/);
  });
  it("SHA256 do conjunto diferente do aprovado -> aborta sem efeito", async () => {
    const db = await novoBanco();
    await falhaSemEfeito(db, migracao({ ...FIXTURE, alvo_hash: "0".repeat(64) }), /SHA256 do conjunto/);
  });
  it("restante da fila diferente do aprovado -> aborta sem efeito", async () => {
    const db = await novoBanco();
    await db.query(`update public.pagamentos set status_conciliacao = 'REVISAO' where id = $1`, [G(7)]);
    await falhaSemEfeito(db, migracao(), /restante da fila AGUARDANDO_ACORDO=1;REVISAO=1 difere/);
  });
  it("quantidade de acordos que seriam quitados diferente -> aborta sem efeito", async () => {
    const db = await novoBanco();
    await db.query(`insert into public.parcelas (id,acordo_id,numero,valor,vencimento,status) values ($1,$2,3,100,'2026-11-10','A_VENCER')`, [P(11), AC1]);
    await falhaSemEfeito(db, migracao(), /0 acordos seriam quitados, aprovado 1/);
  });
});

describe("o lote do #392 e o motor precisam ser os aprovados", () => {
  it("trilha que nao reproduz o SHA256 do lote -> aborta sem efeito", async () => {
    const db = await novoBanco();
    await db.query(`update public._backup_completar_parcelas_lote set titulo_snapshot = '{"documento":"050333339999"}' where id = 22`);
    await falhaSemEfeito(db, migracao(), /SHA256 do lote/);
  });
  it("parcela do lote sem o boleto restaurado -> aborta sem efeito", async () => {
    const db = await novoBanco();
    await db.query(`update public.parcelas set boleto = null where id = $1`, [P(6)]);
    await falhaSemEfeito(db, migracao(), /1 parcelas do lote nao tem mais o boleto restaurado/);
  });
  it("corpo do motor diferente do auditado -> aborta sem efeito", async () => {
    const db = await novoBanco();
    await db.exec(MOTOR.comando.replace("$motor$;", "-- alterado\n$motor$;"));
    await falhaSemEfeito(db, migracao(), /corpo de pagamento_conciliar_um mudou/);
  });
  it("baixa_pelo_relatorio religada -> aborta sem efeito", async () => {
    const db = await novoBanco();
    await db.exec(`update public.fluxo_pagamentos_config set ligado = true where etapa = 'baixa_pelo_relatorio'`);
    await falhaSemEfeito(db, migracao(), /baixa_pelo_relatorio nao esta desligada/);
  });
});

describe("resultado do motor diferente de BAIXADO", () => {
  it("a previa do motor recusa um dos alvos -> aborta ANTES de qualquer baixa", async () => {
    const db = await novoBanco();
    await db.query(`update public.acordos set status = 'SUSPENSO' where id = $1`, [AC2]);
    await falhaSemEfeito(db, migracao(), /previa do pagamento .* devolveu REVISAO/);
    expect(await chamadasRecalc(db)).toBe(0);
  });
  it("sem a previa, o motor baixa os 2 primeiros e recusa o 3o -> rollback total", async () => {
    const db = await novoBanco();
    await db.query(`update public.acordos set status = 'SUSPENSO' where id = $1`, [AC2]);
    const semPrevia = migracao(FIXTURE, [[
      "v_res := public.pagamento_conciliar_um(r.pagamento_id, false);",
      "v_res := jsonb_build_object('status','BAIXADO','aplicou',false,'parcela_id',r.parcela_id);",
    ]]);
    await falhaSemEfeito(db, semPrevia, /motor devolveu REVISAO .* rollback total/);
    // o motor chegou a baixar (recalculou alunos) antes de recusar -- e tudo foi desfeito
    expect(await chamadasRecalc(db)).toBeGreaterThan(0);
  });
});

describe("alteracao fora do conjunto durante a execucao aborta tudo", () => {
  const gatilho = async (db, corpo) => {
    await db.exec(`create function public._teste_efeito_colateral() returns trigger language plpgsql as $t$
      begin ${corpo}; return null; end $t$;
      create trigger zz_teste_efeito_colateral after update of status on public.parcelas
        for each row when (new.status = 'PAGO') execute function _teste_efeito_colateral();`);
  };
  it("um dos pagamentos sem status muda", async () => {
    const db = await novoBanco();
    await gatilho(db, `update public.pagamentos set cpf = 'mudou' where id = '${G(4)}'`);
    await falhaSemEfeito(db, migracao(), /pagamento do lote sem status_conciliacao mudou/);
  });
  it("um pagamento da fila fora do conjunto muda", async () => {
    const db = await novoBanco();
    await gatilho(db, `update public.pagamentos set cpf = 'mudou' where id = '${G(6)}'`);
    await falhaSemEfeito(db, migracao(), /pagamento da fila fora do conjunto mudou/);
  });
  it("outra parcela de um acordo do conjunto muda", async () => {
    const db = await novoBanco();
    await gatilho(db, `update public.parcelas set observacao = 'mudou' where id = '${P(4)}'`);
    await falhaSemEfeito(db, migracao(), /outra parcela dos acordos do conjunto mudou/);
  });
  it("a configuracao do fluxo muda", async () => {
    const db = await novoBanco();
    await gatilho(db, `update public.fluxo_pagamentos_config set observacao = 'mudou' where etapa = 'amarrar_boleto'`);
    await falhaSemEfeito(db, migracao(), /fluxo_pagamentos_config mudou/);
  });
});

describe("fila de pendencias dos alvos", () => {
  it("o caminho feliz resolve exatamente as linhas dos alvos, como o motor faz", async () => {
    const db = await novoBanco();
    await db.exec(migracao());
    const fila = (await db.query(`select pagamento_id, decisao, status_conciliacao, decidido_por
                                    from public.fila_pagamento_sem_vinculo order by pagamento_id`)).rows;
    expect(fila).toEqual([
      { pagamento_id: G(1), decisao: "RESOLVIDO_AUTOMATICO", status_conciliacao: "BAIXADO", decidido_por: "conciliacao@sistema" },
      { pagamento_id: G(2), decisao: "RESOLVIDO_AUTOMATICO", status_conciliacao: "BAIXADO", decidido_por: "conciliacao@sistema" },
      { pagamento_id: G(3), decisao: "RESOLVIDO_AUTOMATICO", status_conciliacao: "BAIXADO", decidido_por: "conciliacao@sistema" },
      { pagamento_id: G(6), decisao: null, status_conciliacao: "AGUARDANDO_ACORDO", decidido_por: null },
      { pagamento_id: G(7), decisao: null, status_conciliacao: "PARCELA_JA_PAGA", decidido_por: null },
    ]);
  });
  it("uma das linhas da fila dos alvos ausente -> aborta sem efeito", async () => {
    const db = await novoBanco();
    await db.query(`delete from public.fila_pagamento_sem_vinculo where pagamento_id = $1`, [G(2)]);
    await falhaSemEfeito(db, migracao(), /fila dos alvos com 2 linhas \/ 2 sem decisao \/ 2 AGUARDANDO_AMARRACAO, aprovado 3/);
    expect(await chamadasRecalc(db)).toBe(0);
  });
  it("linha da fila de um alvo com status diferente de AGUARDANDO_AMARRACAO -> aborta sem efeito", async () => {
    const db = await novoBanco();
    await db.query(`update public.fila_pagamento_sem_vinculo set status_conciliacao = 'REVISAO' where pagamento_id = $1`, [G(2)]);
    await falhaSemEfeito(db, migracao(), /fila dos alvos com 3 linhas \/ 3 sem decisao \/ 2 AGUARDANDO_AMARRACAO/);
  });
  it("um dos alvos ja decidido na fila -> aborta sem efeito", async () => {
    const db = await novoBanco();
    await db.query(`update public.fila_pagamento_sem_vinculo set decisao = 'MANTER_PENDENTE', decidido_por = 'gestao' where pagamento_id = $1`, [G(2)]);
    await falhaSemEfeito(db, migracao(), /1 pagamentos AGUARDANDO_AMARRACAO do lote ja tem decisao na fila/);
    expect(await chamadasRecalc(db)).toBe(0);
  });
  it("o motor baixa pagamento e parcela mas a fila nao e resolvida -> rollback total", async () => {
    const db = await novoBanco();
    await db.exec(`create function public._teste_segura_fila() returns trigger language plpgsql as $t$
      begin return null; end $t$;
      create trigger zz_teste_segura_fila before update on public.fila_pagamento_sem_vinculo
        for each row when (new.decisao = 'RESOLVIDO_AUTOMATICO') execute function _teste_segura_fila();`);
    await falhaSemEfeito(db, migracao(), /fila dos alvos com 3 linhas e 0 resolvidas pelo motor como BAIXADO, aprovado 3/);
    // pagamento e parcela chegaram a ser baixados (o motor recalculou) -- e foi tudo desfeito
    expect(await chamadasRecalc(db)).toBeGreaterThan(0);
  });
});

describe("gatilhos essenciais: conferidos antes do motor, nunca desligados", () => {
  const abortaAntesDoMotor = async (preparo, motivo) => {
    const db = await novoBanco();
    await db.exec(preparo);
    await falhaSemEfeito(db, migracao(), motivo);
    expect(await chamadasRecalc(db)).toBe(0);
  };
  it("trg_recalc_parcela ausente -> aborta", () =>
    abortaAntesDoMotor(`drop trigger trg_recalc_parcela on public.parcelas`, /trg_recalc_parcela ausente/));
  it("trg_recalc_parcela desabilitado -> aborta", () =>
    abortaAntesDoMotor(`alter table public.parcelas disable trigger trg_recalc_parcela`, /trg_recalc_parcela nao esta habilitado \(tgenabled=D\)/));
  it("trg_recalc_parcela com definicao alterada -> aborta", () =>
    abortaAntesDoMotor(`drop trigger trg_recalc_parcela on public.parcelas;
      create trigger trg_recalc_parcela after update on public.parcelas for each row execute function _trg_recalc_por_parcela();`,
    /definicao de trg_recalc_parcela diferente da aprovada/));
  it("_trg_recalc_por_parcela com corpo alterado -> aborta", () =>
    abortaAntesDoMotor(`create or replace function public._trg_recalc_por_parcela() returns trigger language plpgsql as $b$${CORPO_RECALC}-- alterado\n$b$`,
      /corpo de _trg_recalc_por_parcela mudou/));
  it("trg_acordo_fecha_com_a_ultima_parcela ausente -> aborta", () =>
    abortaAntesDoMotor(`drop trigger trg_acordo_fecha_com_a_ultima_parcela on public.parcelas`, /trg_acordo_fecha_com_a_ultima_parcela ausente/));
  it("trg_acordo_fecha_com_a_ultima_parcela desabilitado -> aborta", () =>
    abortaAntesDoMotor(`alter table public.parcelas disable trigger trg_acordo_fecha_com_a_ultima_parcela`,
      /trg_acordo_fecha_com_a_ultima_parcela nao esta habilitado \(tgenabled=D\)/));
  it("trg_acordo_fecha_com_a_ultima_parcela com definicao alterada -> aborta", () =>
    abortaAntesDoMotor(`drop trigger trg_acordo_fecha_com_a_ultima_parcela on public.parcelas;
      create trigger trg_acordo_fecha_com_a_ultima_parcela after update on public.parcelas for each row execute function _acordo_fecha_com_a_ultima_parcela();`,
    /definicao de trg_acordo_fecha_com_a_ultima_parcela diferente da aprovada/));
  it("_acordo_fecha_com_a_ultima_parcela com corpo alterado -> aborta", () =>
    abortaAntesDoMotor(`create or replace function public._acordo_fecha_com_a_ultima_parcela() returns trigger language plpgsql as $b$${CORPO_FECHA}-- alterado\n$b$`,
      /corpo de _acordo_fecha_com_a_ultima_parcela mudou/));
  it("a migration nao muda o estado de nenhum gatilho", async () => {
    const db = await novoBanco();
    const gatilhos = async () => JSON.stringify((await db.query(
      `select tgname, tgenabled::text e, pg_get_triggerdef(oid) d from pg_trigger where not tgisinternal order by tgname`)).rows);
    const antes = await gatilhos();
    await db.exec(migracao());
    expect(await gatilhos()).toBe(antes);
  });
});

describe("segunda execucao", () => {
  it("depois de aplicada, uma nova execucao encontra zero e aborta sem gravar", async () => {
    const db = await novoBanco();
    await db.exec(migracao());
    const chamadas = await chamadasRecalc(db);
    await falhaSemEfeito(db, migracao(), /0 pagamentos no conjunto/);
    expect(await chamadasRecalc(db)).toBe(chamadas);
  });
});
