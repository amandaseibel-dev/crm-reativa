// `desvincular_titulos_acordo`: A PORTA ANTIGA, ANTES E DEPOIS DA CORRECAO.
//
// Prova os tres defeitos medidos em producao em 26/10/2026 rodando o CORPO DE
// PRODUCAO (o arquivo de rollback, cujo md5 e conferido contra `pg_proc`), e
// depois prova que a migration pendente fecha os tres sem quebrar o uso
// legitimo da ficha -- soltar mensalidade NEGOCIADO de acordo ATIVO.
//
// Bancada: mesma do teste da E7, com a cadeia real de migrations do motor e os
// dois patches ancorados. Veja o cabecalho de
// `e7_titulo_atribuicao_remover.test.js` para por que os patches existem.
//
// NENHUM DADO REAL.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const REGRA_22_09 = ler("supabase/migrations/20260922265000_acordo_cancelado_nao_reabre_mensalidade_negociada.sql");
const REGRA_25_09 = ler("supabase/migrations/20260925123852_acordo_cancelado_sem_pagamento_reabre_mensalidade.sql");
const CADEIA_REAL = [
  "supabase/migrations/20261001193805_origem_liquidacao_acordo_quitado.sql",
  "supabase/migrations/20261001193932_quitacao_por_acordo_delega_ao_motor.sql",
  "supabase/migrations/20261001194037_titulo_reabrir_quitacao_por_acordo.sql",
  "supabase/migrations/20261001194211_mensalidade_reconciliar_pago_sem_lastro.sql",
].map(ler);

const PRODUCAO = ler("supabase/aguardando_aprovacao/20261026193000_desvincular_titulos_acordo_seguro.rollback.sql");
const CORRIGIDA = ler("supabase/aguardando_aprovacao/20261026193000_desvincular_titulos_acordo_seguro.sql.pendente");

// `desvincular_titulos_acordo` em producao em 26/10/2026.
const MD5_PRODUCAO = "ebd07b0ec54e64f9ab685928988cb9a5";

const GESTAO = `{"email":"amanda.seibel@aelbra.com.br"}`;
const OPERADOR = `{"email":"cobranca06@aelbra.com.br"}`;

async function um(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
}
const n = (v) => Number(v);

const BANCADA = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.email() returns text language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'email' $$;
create function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.role() returns text language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role' $$;

create table public.alunos (id uuid primary key default gen_random_uuid(), nome text,
  saldo_total numeric default 0, saldo_vencido numeric default 0,
  status_jornada text, status_atual text, status_acionamento text);

create table public.casos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
  encerrado_operacional boolean default false, situacao_operacional text, saldo_total numeric);

create table public.acordos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
  status text default 'ATIVO', valor_total numeric, qtd_parcelas int default 1, saldo numeric,
  numero_acordo bigint, numero_ulbra text, motivo_ajuste text,
  criado_em timestamptz default now(), atualizado_em timestamptz default now());

create table public.acordos_titulos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
  documento text, valor_original numeric, saldo_corrigido numeric, valor_em_aberto numeric,
  valor_cobranca_ajustado numeric,
  situacao text, status text, tipo_boleto text default 'Cursos de Graduação Presencial',
  acordo_id uuid, motivo_ajuste text,
  origem_liquidacao text, origem_liquidacao_ref text, origem_liquidacao_em timestamptz,
  origem_encerramento text, origem_encerramento_ref text, origem_encerramento_em timestamptz,
  vinculado_em timestamptz, vinculado_por text,
  created_at timestamp default now(), atualizado_em timestamptz default now());

create table public.acordo_titulo_vinculo (id uuid primary key default gen_random_uuid(),
  acordo_id uuid, titulo_id uuid, ativo boolean default true, vinculado_por text, origem text,
  motivo_desvinculo text, criado_em timestamptz default clock_timestamp());
create unique index ux_titulo_vinculo_ativo on public.acordo_titulo_vinculo (titulo_id) where ativo;

create table public.parcelas (id uuid primary key default gen_random_uuid(), acordo_id uuid,
  numero int default 1, status text default 'A_VENCER', valor numeric, vencimento date,
  boleto text, honorarios numeric, titulos_origem text, is_entrada boolean default false,
  origem_baixa text, origem_baixa_ref text, origem_baixa_em timestamptz,
  renegociada_em timestamptz, renegociada_no_acordo_id uuid, solicitacao_confirmacao_id uuid,
  pago_em timestamptz, confirmado_por_email text, observacao text,
  criado_em timestamptz default now(), atualizado_em timestamptz default now());

create table public.solicitacoes_confirmacao_pagamento (id uuid primary key default gen_random_uuid(),
  aluno_id text, status text);

create table public.aluno_movimentacoes (id bigserial primary key, aluno_id text, tipo text,
  descricao text, status_anterior text, status_novo text, registrado_por_nome text,
  registrado_por_email text, registrado_em timestamptz, valor_movimentacao numeric);

create table public.pagamentos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
  data_pagamento date, valor_pago numeric, titulo_numero text, numero_parcela_completo text,
  valor_honorario numeric, status_conciliacao text, operador_email text);

create table public.baixas_pagamento (id uuid primary key default gen_random_uuid(), acordo_id uuid,
  parcela_id uuid, baixado_por_email text, baixado_em timestamptz, devolvido_em timestamptz);

create table public.auditoria (id bigserial primary key, usuario text, acao text,
  tabela_afetada text, registro_id uuid, detalhes jsonb, created_at timestamp default now());

create table public.mensalidade_reconciliacao_log (id bigserial primary key, lote text not null,
  titulo_id uuid not null, aluno_id uuid, acordo_id uuid, numero_acordo bigint, documento text,
  valor_original numeric, situacao_antes text, status_antes text, situacao_depois text,
  status_depois text, motivo text, executado_por text, executado_em timestamptz default now());

-- cópias LITERAIS de produção (helpers)
create or replace function public.fmt_brl(p numeric) returns text language sql immutable as $body$
  select 'R$ ' || translate(to_char(round(coalesce(p,0),2),'FM999G999G999G990D00'), '.,', ',.');
$body$;

create or replace function public.usuario_e_gestao() returns boolean language sql stable as $body$
  select lower(coalesce(auth.jwt()->>'email','')) in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  );
$body$;

create table public.usuarios (id uuid primary key default gen_random_uuid(), email text,
  perfil text, ativo boolean default true);

create or replace function public.usuario_e_diretoria() returns boolean language sql stable as $body$
  select exists (
    select 1 from public.usuarios u
    where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and u.ativo is true
      and u.perfil = 'diretoria'
  );
$body$;

create or replace function public.parcela_viva(p_status text) returns boolean language sql immutable as $body$
  select upper(coalesce(p_status, '')) not in (
    -- pagamento real (regra 1: so aqui entra dinheiro)
    'PAGO', 'PAGA',
    -- saida por cancelamento/estorno
    'CANCELADA', 'CANCELADO', 'ESTORNADA', 'ESTORNADO',
    -- regra 2: saiu definitivamente da nossa responsabilidade, SEM pagamento
    'DEVOLVIDA',
    -- regra 3: cobranca suspensa temporariamente, SEM pagamento
    'SUSPENSA'
  );
$body$;

-- DUBLÊS
create table public._chamadas_recalcular (aluno_id uuid, lote text, registrado_em timestamptz default clock_timestamp());
create or replace function public.recalcular_situacao_aluno(p_aluno_id uuid, p_lote text)
returns jsonb language plpgsql as $body$
begin
  insert into public._chamadas_recalcular(aluno_id, lote) values (p_aluno_id, p_lote);
  return jsonb_build_object('duble', true);
end;
$body$;

create table public._chamadas_liberar_evento (aluno_id uuid, evento text);
create or replace function public.liberar_caso_por_evento(p_aluno_id uuid, p_evento text,
  p_valor_pago numeric default null, p_data_pagamento date default null)
returns void language plpgsql as $body$
begin
  insert into public._chamadas_liberar_evento(aluno_id, evento) values (p_aluno_id, p_evento);
end;
$body$;

create or replace function public.crm_usuario_pode_quitar_baixar() returns boolean language sql stable as $body$
  select coalesce(public.usuario_e_gestao(), false);
$body$;
`;
const PATCHES_ANCORADOS = `
do $do$
declare v_def text; v_novo text;
begin
  foreach v_def in array array[
    pg_get_functiondef('public.titulo_reavaliar(uuid)'::regprocedure),
    pg_get_functiondef('public.titulo_reabrir_quitacao_por_acordo(uuid)'::regprocedure)
  ] loop
    v_novo := replace(v_def,
      'not in (''PAGO'',''CANCELADA'',''RENEGOCIADA'')',
      'not in (''PAGO'',''CANCELADA'',''RENEGOCIADA'',''DEVOLVIDA'',''SUSPENSA'')');
    v_novo := replace(v_novo,
      'or lower(coalesce(v_status,'''')) = ''cancelada'' then',
      'or lower(coalesce(v_status,'''')) in (''cancelada'',''devolvido'') then');
    execute v_novo;
  end loop;
end $do$;
`;
const TRG_COERENTES = `
create or replace function public._titulo_situacao_e_status_coerentes() returns trigger
language plpgsql as $body$
declare v_sit text; v_st text;
begin
  v_sit := upper(coalesce(new.situacao,''));
  v_st  := lower(coalesce(new.status,''));

  if v_st = 'quitada' and v_sit in ('ABERTO','NEGOCIADO') then
    new.situacao := 'PAGO'; v_sit := 'PAGO';
  end if;

  if v_sit = 'PAGO' and v_st not in ('quitada','pago') then
    new.status := 'quitada';
  elsif v_sit = 'ABERTO' and v_st <> 'em_aberto' then
    new.status := 'em_aberto';
  elsif v_sit = 'NEGOCIADO' and v_st <> 'vinculada' then
    new.status := 'vinculada';
  elsif v_sit = 'CANCELADA' and v_st <> 'cancelada' then
    new.status := 'cancelada';
  elsif v_sit = 'DEVOLVIDO' and v_st <> 'devolvido' then
    -- encerrado SEM recuperacao da ReATIVA: a divida volta ao cliente
    new.status := 'devolvido';
  elsif v_sit = 'EM_CONFIRMACAO' and v_st <> 'em_confirmacao' then
    -- titulo fora da cobranca aguardando a Conferencia Prime
    new.status := 'em_confirmacao';
  end if;

  return new;
end;
$body$;
create trigger trg_titulo_situacao_status_coerentes before insert or update of situacao, status
  on public.acordos_titulos for each row execute function public._titulo_situacao_e_status_coerentes();
`;
const TRG_VINCULO = `
create or replace function public.titulo_situacao_por_vinculo() returns trigger
language plpgsql as $body$
declare v_titulo uuid;
begin
  foreach v_titulo in array
    array(select distinct x from unnest(array[new.titulo_id, old.titulo_id]) x where x is not null)
  loop
    perform public.titulo_reavaliar(v_titulo);
  end loop;
  return coalesce(new, old);
end;
$body$;
create trigger trg_titulo_situacao_por_vinculo after insert or delete or update
  on public.acordo_titulo_vinculo for each row execute function public.titulo_situacao_por_vinculo();
`;

async function novoBanco({ corpo = "CORRIGIDA" } = {}) {
  const db = new PGlite();
  await db.exec(BANCADA);
  await db.exec(REGRA_22_09);
  await db.exec(REGRA_25_09);
  for (const m of CADEIA_REAL) await db.exec(m);
  await db.exec(PATCHES_ANCORADOS);
  await db.exec(TRG_COERENTES);
  await db.exec(TRG_VINCULO);
  await db.exec(corpo === "PRODUCAO" ? PRODUCAO : CORRIGIDA);
  return db;
}

// Um titulo NEGOCIADO num acordo ATIVO: o uso legitimo do botao da ficha.
async function cenarioLegitimo(db) {
  const aluno = await um(db, `insert into public.alunos(nome) values ('ALUNA DE TESTE') returning id`);
  const acordo = await um(db, `insert into public.acordos(aluno_id, status, valor_total, numero_acordo)
    values ($1,'ATIVO',1000,7001) returning id`, [aluno]);
  await db.query(`insert into public.parcelas(acordo_id, numero, status, valor, vencimento)
    values ($1,1,'A_VENCER',1000, current_date + 30)`, [acordo]);
  const titulo = await um(db, `insert into public.acordos_titulos(aluno_id, documento, valor_original,
      saldo_corrigido, situacao, status, acordo_id)
    values ($1,'9000001',1000,1000,'NEGOCIADO','vinculada',$2) returning id`, [aluno, acordo]);
  await db.query(`insert into public.acordo_titulo_vinculo(acordo_id, titulo_id) values ($1,$2)`,
    [acordo, titulo]);
  return { aluno, acordo, titulo };
}

// Um titulo PAGO num acordo QUITADO: a forma do caso Rayssa/Pedro.
async function cenarioQuitado(db, ajustes = {}) {
  const aluno = await um(db, `insert into public.alunos(nome) values ('ALUNA DE TESTE') returning id`);
  const acordo = await um(db, `insert into public.acordos(aluno_id, status, valor_total, numero_acordo)
    values ($1,'QUITADO',3313.09,5696) returning id`, [aluno]);
  await db.query(`insert into public.parcelas(acordo_id, numero, status, valor, vencimento)
    values ($1,1,'PAGO',3313.09, date '2026-10-23')`, [acordo]);
  const titulo = await um(db, `insert into public.acordos_titulos(aluno_id, documento, valor_original,
      saldo_corrigido, situacao, status, acordo_id, origem_liquidacao, origem_encerramento)
    values ($1,'4510930',2869.73,2869.73,
            coalesce($4,'PAGO'), coalesce($5,'quitada'), $2, $3, $6) returning id`,
    [aluno, acordo, ajustes.origem_liquidacao ?? null, ajustes.situacao ?? null,
     ajustes.status ?? null, ajustes.origem_encerramento ?? null]);
  await db.query(`insert into public.acordo_titulo_vinculo(acordo_id, titulo_id) values ($1,$2)`,
    [acordo, titulo]);
  return { aluno, acordo, titulo };
}

const chamar = (db, ids) =>
  um(db, `select public.desvincular_titulos_acordo($1::uuid[])`, [ids]);

describe("o corpo de producao -- os tres defeitos existem", () => {
  let db;
  beforeEach(async () => { db = await novoBanco({ corpo: "PRODUCAO" }); });

  it("o arquivo de rollback devolve o corpo de producao, por md5", async () => {
    const md5 = await um(db, `select md5(p.prosrc) from pg_proc p
      join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname='desvincular_titulos_acordo'`);
    expect(md5).toBe(MD5_PRODUCAO);
  });

  it("DEFEITO 1: operador comum desvincula (sem portao de gestao)", async () => {
    const c = await cenarioLegitimo(db);
    await db.exec(`set request.jwt.claims = '${OPERADOR}'`);
    const r = await chamar(db, [c.titulo]);
    expect(r.ok).toBe(true);
  });

  it("DEFEITO 2: reabre mensalidade PAGA, sem olhar lastro", async () => {
    const c = await cenarioQuitado(db, { origem_liquidacao: "ACORDO_QUITADO" });
    await db.exec(`set request.jwt.claims = '${GESTAO}'`);
    const r = await chamar(db, [c.titulo]);
    expect(r.ok).toBe(true);
    expect(await um(db, `select situacao from public.acordos_titulos where id=$1`, [c.titulo]))
      .toBe("ABERTO");
  });

  it("DEFEITO 3: APAGA a linha do vinculo", async () => {
    const c = await cenarioLegitimo(db);
    await db.exec(`set request.jwt.claims = '${GESTAO}'`);
    await chamar(db, [c.titulo]);
    expect(n(await um(db, `select count(*) from public.acordo_titulo_vinculo
      where titulo_id=$1`, [c.titulo]))).toBe(0);
  });
});

describe("corrigida -- o portao", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  it("operador comum recebe 42501", async () => {
    const c = await cenarioLegitimo(db);
    await db.exec(`set request.jwt.claims = '${OPERADOR}'`);
    await expect(chamar(db, [c.titulo])).rejects.toThrow(/gestao/i);
  });

  it("identidade nula continua recusada antes de tudo", async () => {
    const c = await cenarioLegitimo(db);
    await db.exec(`set request.jwt.claims = ''`);
    const r = await chamar(db, [c.titulo]);
    expect(r.ok).toBe(false);
    expect(r.erro).toBe("NAO_AUTENTICADO");
  });

  it("gestao e service_role passam", async () => {
    const c1 = await cenarioLegitimo(db);
    await db.exec(`set request.jwt.claims = '${GESTAO}'`);
    expect((await chamar(db, [c1.titulo])).ok).toBe(true);

    const c2 = await cenarioLegitimo(db);
    await db.exec(`set request.jwt.claims = '{"email":"robo@sistema","role":"service_role"}'`);
    expect((await chamar(db, [c2.titulo])).ok).toBe(true);
  });

  it("DIRETORIA passa", async () => {
    const c = await cenarioLegitimo(db);
    await db.query(`insert into public.usuarios(email, perfil, ativo)
      values ('diretoria@aelbra.com.br','diretoria',true)`);
    await db.exec(`set request.jwt.claims = '{"email":"diretoria@aelbra.com.br"}'`);
    expect((await chamar(db, [c.titulo])).ok).toBe(true);
  });

  it("diretoria INATIVA nao passa", async () => {
    const c = await cenarioLegitimo(db);
    await db.query(`insert into public.usuarios(email, perfil, ativo)
      values ('exdiretoria@aelbra.com.br','diretoria',false)`);
    await db.exec(`set request.jwt.claims = '{"email":"exdiretoria@aelbra.com.br"}'`);
    await expect(chamar(db, [c.titulo])).rejects.toThrow(/gestao|diretoria/i);
  });

  it("recusa de portao nao escreve nada", async () => {
    const c = await cenarioLegitimo(db);
    await db.exec(`set request.jwt.claims = '${OPERADOR}'`);
    await expect(chamar(db, [c.titulo])).rejects.toThrow();
    expect(await um(db, `select situacao from public.acordos_titulos where id=$1`, [c.titulo]))
      .toBe("NEGOCIADO");
    expect(n(await um(db, `select count(*) from public.acordo_titulo_vinculo
      where titulo_id=$1 and ativo`, [c.titulo]))).toBe(1);
  });
});

describe("corrigida -- titulo quitado sai pela E7, nao por aqui", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); await db.exec(`set request.jwt.claims = '${GESTAO}'`); });

  it("recusa PAGO/quitada e aponta a porta certa", async () => {
    const c = await cenarioQuitado(db);
    const r = await chamar(db, [c.titulo]);
    expect(r.ok).toBe(false);
    expect(r.erro).toBe("TITULO_QUITADO_USE_ATRIBUICAO_REMOVER");
    expect(r.detalhe).toContain("titulo_atribuicao_remover");
    expect(r.titulos[0].documento).toBe("4510930");
  });

  it("recusa titulo com marca de proveniencia, mesmo nao estando PAGO", async () => {
    const c = await cenarioQuitado(db, { situacao: "NEGOCIADO", status: "vinculada",
      origem_liquidacao: "PRIME_LIQUIDACAO_OFICIAL" });
    const r = await chamar(db, [c.titulo]);
    expect(r.ok).toBe(false);
    expect(r.erro).toBe("TITULO_QUITADO_USE_ATRIBUICAO_REMOVER");
  });

  it("recusa titulo encerrado administrativamente", async () => {
    const c = await cenarioQuitado(db, { situacao: "NEGOCIADO", status: "vinculada",
      origem_encerramento: "CONFERENCIA_PRIME_ADMINISTRATIVA" });
    const r = await chamar(db, [c.titulo]);
    expect(r.ok).toBe(false);
    expect(r.erro).toBe("TITULO_QUITADO_USE_ATRIBUICAO_REMOVER");
  });

  it("a recusa nao escreve: titulo e vinculo intactos", async () => {
    const c = await cenarioQuitado(db);
    await chamar(db, [c.titulo]);
    const t = (await db.query(`select situacao, status, acordo_id from public.acordos_titulos
      where id=$1`, [c.titulo])).rows[0];
    expect(t.situacao).toBe("PAGO");
    expect(t.acordo_id).toBe(c.acordo);
    expect(n(await um(db, `select count(*) from public.acordo_titulo_vinculo
      where titulo_id=$1 and ativo`, [c.titulo]))).toBe(1);
    expect(n(await um(db, `select count(*) from public.auditoria`))).toBe(0);
  });

  it("um titulo quitado no lote TRAVA o lote inteiro -- nada parcial", async () => {
    const legitimo = await cenarioLegitimo(db);
    const quitado = await cenarioQuitado(db);
    const r = await chamar(db, [legitimo.titulo, quitado.titulo]);
    expect(r.ok).toBe(false);
    expect(await um(db, `select situacao from public.acordos_titulos where id=$1`, [legitimo.titulo]))
      .toBe("NEGOCIADO");
  });
});

describe("corrigida -- o uso legitimo da ficha continua igual", () => {
  let db, c, r;
  beforeEach(async () => {
    db = await novoBanco();
    c = await cenarioLegitimo(db);
    await db.exec(`set request.jwt.claims = '${GESTAO}'`);
    r = await chamar(db, [c.titulo]);
  });

  it("a mensalidade volta para ABERTO e sai do acordo", async () => {
    expect(r.ok).toBe(true);
    expect(n(r.desvinculados)).toBe(1);
    const t = (await db.query(`select situacao, status, acordo_id from public.acordos_titulos
      where id=$1`, [c.titulo])).rows[0];
    expect(t.situacao).toBe("ABERTO");
    expect(t.status).toBe("em_aberto");
    expect(t.acordo_id).toBe(null);
  });

  it("o vinculo e DESATIVADO, nao apagado, com motivo gravado", async () => {
    const v = (await db.query(`select ativo, motivo_desvinculo from public.acordo_titulo_vinculo
      where titulo_id=$1`, [c.titulo])).rows;
    expect(v.length).toBe(1);
    expect(v[0].ativo).toBe(false);
    expect(v[0].motivo_desvinculo).toContain("amanda.seibel@aelbra.com.br");
    expect(n(r.vinculos_desativados)).toBe(1);
  });

  it("a auditoria declara que nada foi apagado", async () => {
    const a = (await db.query(`select * from public.auditoria
      where acao='DESVINCULOU_TITULOS_ACORDO'`)).rows;
    expect(a.length).toBe(1);
    expect(a[0].usuario).toBe("amanda.seibel@aelbra.com.br");
    expect(Number(a[0].detalhes.vinculos_desativados)).toBe(1);
    expect(Number(a[0].detalhes.vinculos_apagados)).toBe(0);
  });

  it("o acordo e a parcela ficam intactos", async () => {
    expect(await um(db, `select status from public.acordos where id=$1`, [c.acordo])).toBe("ATIVO");
    expect(await um(db, `select status from public.parcelas where acordo_id=$1`, [c.acordo]))
      .toBe("A_VENCER");
  });

  it("lote vazio e erro dito", async () => {
    const r2 = await um(db, `select public.desvincular_titulos_acordo(array[]::uuid[])`);
    expect(r2.ok).toBe(false);
    expect(r2.erro).toBe("SEM_TITULOS");
  });
});
