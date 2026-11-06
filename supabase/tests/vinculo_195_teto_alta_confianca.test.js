// VINCULO ACORDO x MENSALIDADE PELO PRIME 195 — num PostgreSQL real (PGlite).
//
// Roda a MIGRATION REAL (supabase/migrations/20261023132000_*.sql) e o ROLLBACK
// REAL. A migration NAO FOI APLICADA em banco nenhum: este teste e a unica
// coisa que a executa, num banco efemero que morre no fim.
//
// ESCOPO DECLARADO, para nao haver duvida sobre o que esta provado:
//
//   PROVA-SE: (a) que o patch ancorado encontra a ancora, substitui o trecho
//   certo, e idempotente e reversivel; (b) que a LOGICA RESULTANTE e a regra
//   aprovada -- FORTE exige acordo ATIVO e parcela viva, a RPC recusa ATIVO sem
//   parcela viva, QUITADO continua passando pela RPC (o caminho do a vista), e
//   a porta da tela nomeia a regra que barrou; (c) que a ida e a volta nao
//   escrevem em dinheiro.
//
//   NAO SE PROVA que os corpos desta bancada sejam byte a byte os de producao.
//   `acordo_vinculo_sugestoes_calcular` e `vincular_titulos_acordo` entram aqui
//   como RECONSTRUCOES FUNCIONAIS, com as ANCORAS copiadas verbatim de
//   producao (23/10/2026) e o resto reduzido ao necessario. A protecao real
//   contra divergencia de texto NAO e este teste: e a propria migration, que
//   RECUSA aplicar quando a ancora nao existe -- e isso tem teste proprio
//   abaixo ("ancora ausente"), que e o mais importante deste arquivo.
//
//   NAO SE PROVA nenhuma regra financeira nova: a frente nao cria regra de
//   pagamento, baixa ou quitacao. O criterio de evidencia do portador 195
//   (CPF + boleto inteiro + liquidado_em + janela -60/+7 + concorrencia) nao e
//   tocado, e ha teste de que ele continua no corpo.
globalThis.process.env.TZ = "UTC";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 120000, hookTimeout: 300000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const MIGRATION = ler("supabase/migrations/20261023132000_vinculo_195_teto_alta_confianca.sql");
const ROLLBACK = ler("supabase/rollbacks/20261023132000_vinculo_195_teto_alta_confianca.rollback.sql");

const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const GESTAO = "amanda.seibel@aelbra.com.br";

// ---------------------------------------------------------------------------
// A BANCADA. Estrutura reduzida ao que as tres funcoes tocam.
// ---------------------------------------------------------------------------
const BANCADA = `
-- Os papeis do Supabase. A migration faz revoke/grant neles, entao precisam
-- existir para que o teste exercite as permissoes de verdade em vez de passar
-- por vacuidade.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role bypassrls; end if;
end $$;

create schema if not exists auth;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb
$$;
create or replace function auth.email() returns text language sql stable as $$
  select auth.jwt() ->> 'email'
$$;

create table alunos (id uuid primary key, nome text, cpf text, unidade text);
create table acordos (
  id uuid primary key, aluno_id uuid, cpf text, tipo text, forma_pagamento text,
  valor_total numeric, qtd_parcelas int, status text, unidade text, saldo numeric,
  observacao text, criado_por_email text, criado_por_nome text, numero_ulbra text,
  numero_acordo text, operador_responsavel_email text, operador_responsavel_nome text,
  criado_em timestamptz default now(), atualizado_em timestamptz default now());
create table parcelas (
  id uuid primary key default gen_random_uuid(), acordo_id uuid, numero int, valor numeric,
  vencimento date, status text, is_entrada boolean default false, boleto text,
  boleto_confiavel boolean, observacao text,
  criado_em timestamptz default now(), atualizado_em timestamptz default now());
create table acordos_titulos (
  id uuid primary key, aluno_id uuid, documento text, competencia text, vencimento date,
  situacao text, status text, acordo_id uuid, tipo_boleto text,
  valor_original numeric, valor_em_aberto numeric, saldo_corrigido numeric,
  valor_cobranca_ajustado numeric, motivo_ajuste text,
  vinculado_em timestamptz, vinculado_por text, atualizado_em timestamptz);
create table acordo_titulo_vinculo (
  id bigserial primary key, acordo_id uuid, titulo_id uuid, ativo boolean default true,
  vinculado_por text, criado_em timestamptz default now());
create table prime_extrato (
  id bigserial primary key, portador int, cpf text, boleto text, liquidado_em date);
create table acordo_vinculo_sugestao_decisao (
  id uuid primary key default gen_random_uuid(), acordo_id uuid, composicao_hash text,
  titulo_ids uuid[], decisao text, nivel text, motivo text,
  decidido_por text, decidido_em timestamptz default now(),
  constraint decisao_check check (decisao in ('REJEITADA','CONFIRMADA')));
create table auditoria (
  id bigserial primary key, usuario text, acao text, tabela_afetada text,
  registro_id text, detalhes jsonb, criado_em timestamptz default now());

-- CORPO EXATO DE PRODUCAO (23/10/2026).
create or replace function public.parcela_viva(p_status text) returns boolean
 language sql immutable as $$
  select upper(coalesce(p_status, '')) not in (
    'PAGO', 'PAGA',
    'CANCELADA', 'CANCELADO', 'ESTORNADA', 'ESTORNADO',
    'DEVOLVIDA',
    'SUSPENSA'
  );
$$;

create or replace function public.usuario_e_gestao() returns boolean
 language sql stable as $$
  select lower(coalesce(auth.jwt()->>'email','')) in
    ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br');
$$;

-- Dependencias da RPC, dubladas de forma inerte e declarada.
create or replace function public.acordo_avista_porta_interna() returns boolean
 language sql stable as $$ select false $$;
create or replace function public.acordo_saldo_residual(p_acordo_id uuid) returns jsonb
 language sql stable as $$ select jsonb_build_object('confiavel', false) $$;
`;

// RECONSTRUCAO FUNCIONAL de acordo_vinculo_sugestoes_calcular. As tres ANCORAS
// que a migration procura estao VERBATIM como em producao; o criterio de
// evidencia (portador 195 + liquidado_em + CPF + boleto + janela) tambem.
const FN_NIVEL = `
create or replace function public.acordo_vinculo_sugestoes_calcular(p_acordo_id uuid)
returns table(acordo_id uuid, aluno_id uuid, nome text, cpf text, responsavel_email text,
  numero_acordo text, status text, criado_em timestamptz, valor_total numeric, saldo numeric,
  nivel text, motivo text, liquidacao_195 date, composicao_hash text, titulos jsonb,
  concorrentes jsonb, qtd_grupos_janela integer)
language plpgsql stable security definer set search_path to 'public' as $function$
#variable_conflict use_column
begin
  return query
  with ac as materialized (
    select a.id, a.aluno_id, a.numero_acordo::text nro, upper(coalesce(a.status,'')) st, a.criado_em, a.criado_em::date cr,
           a.valor_total, coalesce(a.saldo,0) saldo, al.nome, al.cpf, regexp_replace(coalesce(al.cpf,''),'\\D','','g') cpf_n,
           null::text resp
      from public.acordos a join public.alunos al on al.id = a.aluno_id
     where upper(coalesce(a.status,'')) in ('ATIVO','QUITADO')
       and (p_acordo_id is null or a.id = p_acordo_id)
       and not exists (select 1 from public.acordo_titulo_vinculo v join public.acordos_titulos t on t.id = v.titulo_id
                         and coalesce(t.tipo_boleto,'') <> 'Acordo' where v.acordo_id = a.id and coalesce(v.ativo,true))
  ), e195 as materialized (
    select ltrim(e.boleto,'0') bol, regexp_replace(coalesce(e.cpf,''),'\\D','','g') cpf_n, e.liquidado_em
      from public.prime_extrato e
     where e.portador = 195 and e.liquidado_em is not null
       and regexp_replace(coalesce(e.cpf,''),'\\D','','g') in (select x.cpf_n from ac x where x.cpf_n <> '')
  ), tit as materialized (
    select t.id, t.aluno_id, t.documento, ltrim(t.documento,'0') doc, t.competencia, t.vencimento, upper(coalesce(t.situacao,'')) sit,
           lower(coalesce(t.status,'')) stt, t.acordo_id, coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) valor
      from public.acordos_titulos t
     where t.aluno_id in (select x.aluno_id from ac x) and coalesce(t.tipo_boleto,'') <> 'Acordo'
  ), el as materialized (
    select ac.id acordo_id, t.id tid, t.documento, t.competencia, t.vencimento, t.sit, t.stt, t.valor, min(e.liquidado_em) liq
      from ac join tit t on t.aluno_id = ac.aluno_id
      join e195 e on e.cpf_n = ac.cpf_n and e.bol = t.doc
     where ac.cpf_n <> '' and t.vencimento <= e.liquidado_em
       and (t.sit = 'ABERTO' and t.acordo_id is null
            and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id and coalesce(v.ativo,true)))
     group by ac.id, t.id, t.documento, t.competencia, t.vencimento, t.sit, t.stt, t.valor
  ), gr as materialized (
    select el.acordo_id, el.liq d, jsonb_agg(jsonb_build_object('titulo_id', el.tid, 'documento', el.documento,
             'vencimento', el.vencimento, 'valor', el.valor) order by el.vencimento, el.tid) tits,
           array_agg(el.tid order by el.tid) ids
      from el group by el.acordo_id, el.liq
  ), gj as materialized (
    select g.acordo_id, g.d, g.tits, g.ids, (g.d between ac.cr - 60 and ac.cr + 7) na_janela,
           (select jsonb_agg(jsonb_build_object('acordo_id', b.id) order by b.criado_em)
              from public.acordos b
             where b.aluno_id = ac.aluno_id and b.id <> ac.id
               and g.d between b.criado_em::date - 60 and b.criado_em::date + 7) conc
      from gr g join ac on ac.id = g.acordo_id
  ), r as (
    select ac.*, (select count(*) from gj x where x.acordo_id = ac.id and x.na_janela)::int ng_win,
           (select count(*) from gj x where x.acordo_id = ac.id)::int ng_tot,
           exists (select 1 from gj x where x.acordo_id = ac.id and x.na_janela and x.conc is not null) tem_conc
      from ac
  )
  select r.id, r.aluno_id, r.nome, r.cpf, r.resp, r.nro, r.st, r.criado_em, r.valor_total, r.saldo,
         case when r.ng_win = 0 then 'SEM_EVIDENCIA' when r.ng_win = 1 and not r.tem_conc then 'FORTE' else 'REVISAO' end,
         case when r.cpf_n = '' then 'ALUNO_SEM_CPF'
              when r.ng_win = 0 and r.ng_tot = 0 then 'SEM_GRUPO_195'
              when r.ng_win = 0 then 'GRUPO_195_FORA_DA_JANELA'
              when r.ng_win > 1 then 'MULTIPLOS_GRUPOS_195'
              when r.tem_conc then 'ACORDO_CONCORRENTE'
              else 'UNICO_GRUPO_195_COMPATIVEL' end,
         (select min(x.d) from gj x where x.acordo_id = r.id and x.na_janela),
         (select md5(string_agg(q.tid::text, ',' order by q.tid)) from (select unnest(x.ids) tid from gj x where x.acordo_id = r.id and x.na_janela) q),
         coalesce((select jsonb_agg(el2 order by el2->>'vencimento', el2->>'titulo_id')
                     from gj x, jsonb_array_elements(x.tits) el2 where x.acordo_id = r.id and x.na_janela), '[]'::jsonb),
         (select jsonb_agg(distinct c) from gj x, jsonb_array_elements(x.conc) c where x.acordo_id = r.id and x.na_janela and x.conc is not null),
         r.ng_win
    from r;
end;
$function$;
`;

// RECONSTRUCAO FUNCIONAL de vincular_titulos_acordo: so o caminho exercitado
// aqui (status, elegibilidade minima, o ramo v_quitado e a linha do vinculo).
// A ANCORA do status esta VERBATIM como em producao.
const FN_RPC = `
create or replace function public.vincular_titulos_acordo(p_titulo_ids uuid[], p_acordo_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  v_email text := lower(coalesce(auth.email(),''));
  v_aluno_acordo uuid; v_status_acordo text; v_numero text; v_quitado boolean;
  v_n int := 0; v_criados int := 0;
begin
  if v_email = '' and public.acordo_avista_porta_interna() then
    v_email := 'conciliacao@sistema';
  end if;
  if v_email = '' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;
  if p_acordo_id is null then return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ENCONTRADO'); end if;
  if p_titulo_ids is null or array_length(p_titulo_ids,1) is null then
    return jsonb_build_object('ok',false,'erro','SEM_TITULOS');
  end if;

  select aluno_id, upper(coalesce(status,'')), coalesce(numero_acordo::text,'')
    into v_aluno_acordo, v_status_acordo, v_numero
  from public.acordos where id = p_acordo_id;
  if v_aluno_acordo is null then return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ENCONTRADO'); end if;

  if v_status_acordo = 'CANCELADO' then
    return jsonb_build_object('ok',false,'erro','acordo_cancelado_operacao_nao_permitida');
  elsif v_status_acordo not in ('ATIVO','QUITADO') then
    return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ATIVO');
  end if;

  v_quitado := v_status_acordo = 'QUITADO'
    and not exists (select 1 from public.parcelas p
                     where p.acordo_id = p_acordo_id and public.parcela_viva(p.status));

  if v_quitado then
    update public.acordos_titulos t
       set acordo_id = p_acordo_id, situacao = 'PAGO', status = 'quitada',
           vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
     where t.id = any(p_titulo_ids) and t.aluno_id = v_aluno_acordo;
  else
    update public.acordos_titulos t
       set acordo_id = p_acordo_id, situacao = 'NEGOCIADO', status = 'vinculada',
           vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
     where t.id = any(p_titulo_ids) and t.aluno_id = v_aluno_acordo;
  end if;
  get diagnostics v_n = row_count;

  insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por, criado_em)
  select p_acordo_id, t.id, true, v_email, now()
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids) and t.aluno_id = v_aluno_acordo
    and not exists (select 1 from public.acordo_titulo_vinculo v
                     where v.titulo_id = t.id and coalesce(v.ativo,true));
  get diagnostics v_criados = row_count;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'VINCULOU_TITULOS_ACORDO', 'acordos_titulos', p_acordo_id,
          jsonb_build_object('qtd', v_n, 'estado_titulo', case when v_quitado then 'quitada' else 'vinculada' end));

  return jsonb_build_object('ok', true, 'vinculados', v_n, 'vinculos_criados', v_criados,
                            'acordo_id', p_acordo_id, 'status_acordo', v_status_acordo,
                            'estado_titulo', case when v_quitado then 'quitada' else 'vinculada' end);
end;
$function$;
`;

// Corpo de producao da porta da tela (verbatim, 23/10/2026) -- e o que o
// rollback tem de restaurar.
const FN_PORTA = `
create or replace function public.acordo_vinculo_sugestao_confirmar(p_acordo_id uuid, p_composicao_hash text)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
#variable_conflict use_column
declare v_email text := lower(coalesce(auth.email(),'')); s record; v_ids uuid[]; v_res jsonb;
begin
  if not public.usuario_e_gestao() then raise exception 'Acesso negado: somente gestao.' using errcode = '42501'; end if;
  if v_email = '' then return jsonb_build_object('ok', false, 'erro', 'NAO_AUTENTICADO'); end if;
  select * into s from public.acordo_vinculo_sugestoes_calcular(p_acordo_id);
  if not found then return jsonb_build_object('ok', false, 'erro', 'ACORDO_NAO_ELEGIVEL'); end if;
  if s.nivel <> 'FORTE' then
    return jsonb_build_object('ok', false, 'erro', 'SUGESTAO_NAO_E_FORTE', 'nivel', s.nivel, 'motivo', s.motivo);
  end if;
  if s.composicao_hash is distinct from p_composicao_hash then
    return jsonb_build_object('ok', false, 'erro', 'SUGESTAO_MUDOU', 'composicao_atual', s.composicao_hash);
  end if;
  select array_agg((x->>'titulo_id')::uuid order by (x->>'titulo_id')::uuid) into v_ids from jsonb_array_elements(s.titulos) x;
  v_res := public.vincular_titulos_acordo(v_ids, p_acordo_id);
  if not coalesce((v_res->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'erro', 'VINCULO_RECUSADO', 'detalhe', v_res);
  end if;
  insert into public.acordo_vinculo_sugestao_decisao (acordo_id, composicao_hash, titulo_ids, decisao, nivel, motivo, decidido_por)
  values (p_acordo_id, s.composicao_hash, v_ids, 'CONFIRMADA', s.nivel, s.motivo, v_email);
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'SUGESTAO_VINCULO_CONFIRMADA', 'acordos', p_acordo_id,
          jsonb_build_object('motivo', s.motivo, 'liquidacao_195', s.liquidacao_195));
  return jsonb_build_object('ok', true, 'acordo_id', p_acordo_id, 'titulo_ids', v_ids, 'resultado', v_res);
end;
$function$;
`;

// `fluxo_pagamentos_config` existe so para o portao da migration conferir que
// `vinculo_por_negociacao` nao foi religada.
const CONFIG = `
create table if not exists fluxo_pagamentos_config (etapa text primary key, ligado boolean not null default false);
insert into fluxo_pagamentos_config (etapa, ligado) values ('vinculo_por_negociacao', false)
  on conflict (etapa) do update set ligado = excluded.ligado;
`;

// ---------------------------------------------------------------------------
// A CARTEIRA SINTETICA. Quatro acordos, um por cenario da regra.
//   1 ATIVO com parcela viva          -> FORTE (segue FORTE)
//   2 QUITADO sem parcela viva        -> era FORTE, passa a REVISAO
//   3 ATIVO sem parcela viva          -> era FORTE, passa a REVISAO
//   4 ATIVO com parcela viva + acordo concorrente -> REVISAO (nao muda)
// ---------------------------------------------------------------------------
const CARTEIRA = `
insert into alunos (id, nome, cpf) values
  ('${U(1)}','ALUNO UM','11111111111'),
  ('${U(2)}','ALUNO DOIS','22222222222'),
  ('${U(3)}','ALUNO TRES','33333333333'),
  ('${U(4)}','ALUNO QUATRO','44444444444');

insert into acordos (id, aluno_id, cpf, status, valor_total, saldo, numero_acordo, criado_em) values
  ('${U(11)}','${U(1)}','11111111111','ATIVO',  1000, 1000, '070001', '2026-09-20'),
  ('${U(12)}','${U(2)}','22222222222','QUITADO', 500,    0, '070002', '2026-09-20'),
  ('${U(13)}','${U(3)}','33333333333','ATIVO',   700,  700, '070003', '2026-09-20'),
  ('${U(14)}','${U(4)}','44444444444','ATIVO',   900,  900, '070004', '2026-09-20'),
  -- concorrente do aluno 4, na mesma janela
  ('${U(15)}','${U(4)}','44444444444','ATIVO',   300,  300, '070005', '2026-09-22');

insert into parcelas (acordo_id, numero, valor, vencimento, status) values
  ('${U(11)}', 1, 1000, '2026-10-20', 'A_VENCER'),   -- viva
  ('${U(12)}', 1,  500, '2026-10-20', 'PAGO'),       -- nao viva
  ('${U(13)}', 1,  700, '2026-10-20', 'CANCELADA'),  -- nao viva
  ('${U(14)}', 1,  900, '2026-10-20', 'A_VENCER');   -- viva

insert into acordos_titulos (id, aluno_id, documento, vencimento, situacao, status, valor_em_aberto) values
  ('${U(21)}','${U(1)}','0004500001','2026-08-10','ABERTO','em_aberto', 900),
  ('${U(22)}','${U(2)}','0004500002','2026-08-10','ABERTO','em_aberto', 480),
  ('${U(23)}','${U(3)}','0004500003','2026-08-10','ABERTO','em_aberto', 650),
  ('${U(24)}','${U(4)}','0004500004','2026-08-10','ABERTO','em_aberto', 850);

insert into prime_extrato (portador, cpf, boleto, liquidado_em) values
  (195,'111.111.111-11','0004500001','2026-09-15'),
  (195,'222.222.222-22','0004500002','2026-09-15'),
  (195,'333.333.333-33','0004500003','2026-09-15'),
  (195,'444.444.444-44','0004500004','2026-09-15');
`;

const como = (db, email) =>
  db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ email })]);

async function novoBanco({ carteira = true } = {}) {
  const db = new PGlite();
  await db.exec(BANCADA);
  await db.exec(CONFIG);
  await db.exec(FN_NIVEL);
  await db.exec(FN_RPC);
  await db.exec(FN_PORTA);
  if (carteira) await db.exec(CARTEIRA);
  return db;
}

const niveis = async (db) =>
  Object.fromEntries(
    (await qn(db, "select acordo_id, nivel, motivo from acordo_vinculo_sugestoes_calcular(null)"))
      .map((r) => [r.acordo_id, `${r.nivel}/${r.motivo}`]),
  );

describe("antes da migration: a regra antiga", () => {
  it("acordo QUITADO e acordo ATIVO sem parcela viva sao FORTE", async () => {
    const db = await novoBanco();
    const n = await niveis(db);
    expect(n[U(11)]).toBe("FORTE/UNICO_GRUPO_195_COMPATIVEL");
    expect(n[U(12)]).toBe("FORTE/UNICO_GRUPO_195_COMPATIVEL"); // QUITADO
    expect(n[U(13)]).toBe("FORTE/UNICO_GRUPO_195_COMPATIVEL"); // sem parcela viva
    expect(n[U(14)]).toBe("REVISAO/ACORDO_CONCORRENTE");
  });
});

describe("depois da migration: o teto de ALTA_CONFIANCA", () => {
  let db;
  beforeEach(async () => {
    db = await novoBanco();
    await db.exec(MIGRATION);
  });

  it("FORTE exige acordo ATIVO: QUITADO cai para REVISAO com motivo proprio", async () => {
    const n = await niveis(db);
    expect(n[U(12)]).toBe("REVISAO/ACORDO_QUITADO_EXIGE_REVISAO");
  });

  it("FORTE exige parcela viva: ATIVO sem parcela viva cai para REVISAO", async () => {
    const n = await niveis(db);
    expect(n[U(13)]).toBe("REVISAO/ACORDO_SEM_PARCELA_VIVA");
  });

  it("o caso bom segue FORTE, e o concorrente segue REVISAO pelo motivo antigo", async () => {
    const n = await niveis(db);
    expect(n[U(11)]).toBe("FORTE/UNICO_GRUPO_195_COMPATIVEL");
    // a precedencia nao mudou: concorrencia continua ganhando dos motivos novos
    expect(n[U(14)]).toBe("REVISAO/ACORDO_CONCORRENTE");
  });

  it("o criterio de evidencia do 195 continua intacto", async () => {
    // tirar a liquidacao tira a evidencia -- e o criterio, nao o teto
    await db.query("update prime_extrato set liquidado_em = null where cpf = '111.111.111-11'");
    const n = await niveis(db);
    expect(n[U(11)]).toBe("SEM_EVIDENCIA/SEM_GRUPO_195");
  });

  it("fora da janela de -60/+7 continua sem evidencia", async () => {
    // A data tem de ficar DEPOIS do vencimento do titulo (2026-08-10), senao
    // ele nem chega a ser elegivel e o motivo vira SEM_GRUPO_195 -- que e outra
    // coisa. O acordo nasceu em 2026-09-20, logo a janela e 22/07 a 27/09:
    // 01/12 esta depois do vencimento e fora da janela.
    await db.query("update prime_extrato set liquidado_em = '2026-12-01' where cpf = '111.111.111-11'");
    const n = await niveis(db);
    expect(n[U(11)]).toBe("SEM_EVIDENCIA/GRUPO_195_FORA_DA_JANELA");
  });

  it("liquidacao ANTES do vencimento do titulo nao gera grupo nenhum", async () => {
    // Distincao que o teste acima quase escondeu: sem elegibilidade o motivo e
    // SEM_GRUPO_195, nao "fora da janela".
    await db.query("update prime_extrato set liquidado_em = '2026-01-10' where cpf = '111.111.111-11'");
    const n = await niveis(db);
    expect(n[U(11)]).toBe("SEM_EVIDENCIA/SEM_GRUPO_195");
  });
});

describe("a trava da RPC compartilhada", () => {
  let db;
  beforeEach(async () => {
    db = await novoBanco();
    await db.exec(MIGRATION);
    await como(db, GESTAO);
  });

  it("recusa acordo ATIVO sem parcela viva", async () => {
    const r = await q1(db, "select public.vincular_titulos_acordo(array['" + U(23) + "']::uuid[], '" + U(13) + "') as r");
    expect(r.r.ok).toBe(false);
    expect(r.r.erro).toBe("ACORDO_ATIVO_SEM_PARCELA_VIVA");
    // e nada foi escrito
    const t = await q1(db, "select situacao, status, acordo_id from acordos_titulos where id = '" + U(23) + "'");
    expect(t.situacao).toBe("ABERTO");
    expect(t.acordo_id).toBeNull();
  });

  it("NAO recusa acordo QUITADO sem parcela viva -- e o caminho do a vista", async () => {
    const r = await q1(db, "select public.vincular_titulos_acordo(array['" + U(22) + "']::uuid[], '" + U(12) + "') as r");
    expect(r.r.ok).toBe(true);
    // e quita a mensalidade, porque ali o pagamento existe
    const t = await q1(db, "select situacao, status from acordos_titulos where id = '" + U(22) + "'");
    expect(t.situacao).toBe("PAGO");
    expect(t.status).toBe("quitada");
  });

  it("acordo ATIVO com parcela viva vincula e deixa a mensalidade NEGOCIADA, nunca paga", async () => {
    const r = await q1(db, "select public.vincular_titulos_acordo(array['" + U(21) + "']::uuid[], '" + U(11) + "') as r");
    expect(r.r.ok).toBe(true);
    const t = await q1(db, "select situacao, status from acordos_titulos where id = '" + U(21) + "'");
    expect(t.situacao).toBe("NEGOCIADO");
    expect(t.status).toBe("vinculada");
  });

  it("acordo CANCELADO continua recusado pelo motivo antigo", async () => {
    await db.query("update acordos set status = 'CANCELADO' where id = '" + U(11) + "'");
    const r = await q1(db, "select public.vincular_titulos_acordo(array['" + U(21) + "']::uuid[], '" + U(11) + "') as r");
    expect(r.r.erro).toBe("acordo_cancelado_operacao_nao_permitida");
  });
});

describe("a porta da tela nomeia a regra que barrou", () => {
  let db;
  beforeEach(async () => {
    db = await novoBanco();
    await db.exec(MIGRATION);
    await como(db, GESTAO);
  });

  it("QUITADO: erro proprio, nao o generico de nivel", async () => {
    const r = await q1(db, "select public.acordo_vinculo_sugestao_confirmar('" + U(12) + "', 'qualquer') as r");
    expect(r.r.ok).toBe(false);
    expect(r.r.erro).toBe("ACORDO_NAO_ATIVO_EXIGE_REVISAO");
  });

  it("ATIVO sem parcela viva: erro proprio", async () => {
    const r = await q1(db, "select public.acordo_vinculo_sugestao_confirmar('" + U(13) + "', 'qualquer') as r");
    expect(r.r.erro).toBe("ACORDO_SEM_PARCELA_VIVA");
  });

  it("hash divergente continua barrando o caso bom", async () => {
    const r = await q1(db, "select public.acordo_vinculo_sugestao_confirmar('" + U(11) + "', 'hash-errado') as r");
    expect(r.r.erro).toBe("SUGESTAO_MUDOU");
  });

  it("o caso bom passa, grava o nivel e declara o teto", async () => {
    const s = await q1(db, "select composicao_hash from acordo_vinculo_sugestoes_calcular('" + U(11) + "')");
    const r = await q1(db, "select public.acordo_vinculo_sugestao_confirmar('" + U(11) + "', $1) as r", [s.composicao_hash]);
    expect(r.r.ok).toBe(true);
    expect(r.r.teto_classificacao).toBe("ALTA_CONFIANCA");
    const d = await q1(db, "select decisao, nivel from acordo_vinculo_sugestao_decisao where acordo_id = '" + U(11) + "'");
    expect(d.nivel).toBe("FORTE");
    expect(d.decisao).toBe("CONFIRMADA"); // historico append-only, nao renomeado
    const a = await q1(db, "select detalhes->>'teto_classificacao' as teto from auditoria where acao = 'SUGESTAO_VINCULO_CONFIRMADA'");
    expect(a.teto).toBe("ALTA_CONFIANCA");
  });

  it("operador comum continua recusado com 42501", async () => {
    await como(db, "cobranca05@aelbra.com.br");
    await expect(
      db.query("select public.acordo_vinculo_sugestao_confirmar('" + U(11) + "', 'x')"),
    ).rejects.toThrow(/somente gestao/i);
  });
});

describe("o patch em si", () => {
  it("ancora ausente: a migration RECUSA em vez de aplicar as cegas", async () => {
    const db = await novoBanco();
    // simula producao divergente: o trecho do nivel foi reescrito por outra frente
    await db.exec(
      FN_NIVEL.replace(
        "case when r.ng_win = 0 then 'SEM_EVIDENCIA' when r.ng_win = 1 and not r.tem_conc then 'FORTE' else 'REVISAO' end",
        "case when r.ng_win = 0 then 'SEM_EVIDENCIA' else 'REVISAO' end",
      ),
    );
    await expect(db.exec(MIGRATION)).rejects.toThrow(/ancora nao encontrada/i);
  });

  it("e idempotente: duas vezes nao duplica nem quebra", async () => {
    const db = await novoBanco();
    await db.exec(MIGRATION);
    await db.exec(MIGRATION);
    const n = await niveis(db);
    expect(n[U(11)]).toBe("FORTE/UNICO_GRUPO_195_COMPATIVEL");
    expect(n[U(12)]).toBe("REVISAO/ACORDO_QUITADO_EXIGE_REVISAO");
    const src = await q1(db, `select pg_get_functiondef('public.acordo_vinculo_sugestoes_calcular(uuid)'::regprocedure) as s`);
    // a contagem de parcelas vivas entrou UMA vez
    const ocorrencias = src.s.split("parc_vivas").length - 1;
    expect(ocorrencias).toBeLessThanOrEqual(4);
  });

  it("recusa se vinculo_por_negociacao tiver sido religada", async () => {
    const db = await novoBanco();
    await db.query("update fluxo_pagamentos_config set ligado = true where etapa = 'vinculo_por_negociacao'");
    await expect(db.exec(MIGRATION)).rejects.toThrow(/vinculo_por_negociacao foi religada/i);
  });
});

describe("o rollback", () => {
  it("devolve a regra antiga e o corpo da porta da tela", async () => {
    const db = await novoBanco();
    await db.exec(MIGRATION);
    expect((await niveis(db))[U(12)]).toBe("REVISAO/ACORDO_QUITADO_EXIGE_REVISAO");

    await db.exec(ROLLBACK);

    const n = await niveis(db);
    expect(n[U(11)]).toBe("FORTE/UNICO_GRUPO_195_COMPATIVEL");
    expect(n[U(12)]).toBe("FORTE/UNICO_GRUPO_195_COMPATIVEL");
    expect(n[U(13)]).toBe("FORTE/UNICO_GRUPO_195_COMPATIVEL");

    const src = await q1(db, `select pg_get_functiondef('public.vincular_titulos_acordo(uuid[],uuid)'::regprocedure) as s`);
    expect(src.s).not.toMatch(/ACORDO_ATIVO_SEM_PARCELA_VIVA/);

    await como(db, GESTAO);
    const r = await q1(db, "select public.acordo_vinculo_sugestao_confirmar('" + U(12) + "', 'x') as r");
    expect(r.r.erro).toBe("SUGESTAO_MUDOU"); // volta ao caminho antigo: nivel FORTE passa do teste de nivel
  });

  it("e idempotente e nao deixa referencia pendurada", async () => {
    const db = await novoBanco();
    await db.exec(MIGRATION);
    await db.exec(ROLLBACK);
    await db.exec(ROLLBACK);
    const src = await q1(db, `select pg_get_functiondef('public.acordo_vinculo_sugestoes_calcular(uuid)'::regprocedure) as s`);
    expect(src.s).not.toMatch(/parc_vivas/);
    expect((await niveis(db))[U(11)]).toBe("FORTE/UNICO_GRUPO_195_COMPATIVEL");
  });
});

describe("ida e volta nao escrevem em dinheiro", () => {
  it("acordos, parcelas, titulos, vinculos e config com digital identica", async () => {
    const db = await novoBanco();
    const digital = () =>
      q1(
        db,
        `select (select md5(string_agg(id::text||status||valor_total::text||saldo::text, '|' order by id)) from acordos) a,
                (select md5(string_agg(acordo_id::text||status||valor::text, '|' order by acordo_id, numero)) from parcelas) p,
                (select md5(string_agg(id::text||situacao||status||coalesce(acordo_id::text,'-'), '|' order by id)) from acordos_titulos) t,
                (select count(*)::int from acordo_titulo_vinculo) v,
                (select md5(string_agg(etapa||ligado::text, '|' order by etapa)) from fluxo_pagamentos_config) c,
                (select count(*)::int from auditoria) au`,
      );
    const antes = await digital();
    await db.exec(MIGRATION);
    await db.exec(ROLLBACK);
    const depois = await digital();
    expect(depois).toEqual(antes);
  });
});
