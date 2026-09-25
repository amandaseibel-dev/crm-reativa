// Bancada da Carteira Geral: PostgreSQL real (PGlite) com o ESQUELETO das
// tabelas de produção que as migrations tocam, as funções de escrita oficiais
// copiadas de produção (internal.set_resp_aluno / set_resp_acordo, com o mesmo
// comportamento de limpar o agendamento ao trocar de dono) e dublês para o que
// não interessa aqui (auth.jwt, teto, portão de gestão).
//
// Dados são FICTÍCIOS. O que se prova são as regras, não os números.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const lerRepo = (p) => readFileSync(resolve(AQUI, "..", "..", "..", "..", p), "utf8");
export const MIG = (n) => lerRepo(`supabase/migrations/${n}.sql`);

export const MIGRATIONS = [
  "20260924171251_carteira_geral_destino",
  "20260924171252_carteira_geral_painel_previa",
  "20260924171254_carteira_geral_mover",
  "20260924171255_carteira_geral_blindar_automacoes",
];

export const GESTAO = "amanda.seibel@aelbra.com.br";
export const FERNANDA = "cobranca04@aelbra.com.br";
export const ADM = "cobranca07@aelbra.com.br";
export const OLGA = "cobranca03@aelbra.com.br";
export const LUANA = "cobranca05@aelbra.com.br";
export const CG = "carteira.geral@reativa.local";

export const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
export const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;
export const como = (db, email) =>
  db.query("select set_config('test.jwt', $1, false)", [
    email ? JSON.stringify({ email, role: "authenticated" }) : "",
  ]);

// `como` troca so a identidade (o JWT). Para provar PERMISSAO e preciso trocar
// o PAPEL do Postgres: o vitest roda como dono do banco, que ignora ACL. Sempre
// em par com `voltarDono`, porque o papel vale para a sessao inteira.
export const comoPapel = async (db, email, papel = "authenticated") => {
  await como(db, email);
  await db.query(`set role ${papel}`);
};
export const voltarDono = (db) => db.query("reset role");

const ESQUELETO = `
-- Papéis do Supabase. PGlite não os traz, e as migrations fazem grant/revoke e
-- criam policy "to authenticated" — sem eles nada aplica.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

create schema if not exists internal;
create schema if not exists auth;

-- auth.jwt() lê um GUC, para o teste poder "entrar" como cada pessoa.
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select nullif(current_setting('test.jwt', true), '')::jsonb
$$;

create table public.usuarios (
  id uuid primary key default gen_random_uuid(),
  nome text not null, email text not null unique, perfil text not null,
  ativo boolean default true, operador_nome text, operador text,
  pode_alterar_responsavel boolean not null default false
);

create table public.alunos (
  id uuid primary key default gen_random_uuid(),
  nome text, cpf text,
  responsavel_atual_email text, responsavel_atual_nome text, responsavel_atual_em timestamptz,
  data_ultimo_acionamento timestamptz, status_acionamento text, proxima_acao text,
  data_retorno date, hora_retorno text, retorno_origem text, retorno_confirmado_em timestamptz,
  operador_email text, operador_nome text, operador text
);

create table public.casos (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid, nome text, nome_aluno text, cpf text, cpf_limpo text, matricula text,
  operador_email text, operador_nome text, operador text,
  status_acionamento text, data_ultimo_acionamento date, data_retorno date,
  encerrado_operacional boolean not null default false,
  caso_atualizado_por text, caso_atualizado_em timestamptz
);

create table public.acordos (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid, cpf text, status text, numero_acordo bigint,
  operador_responsavel_email text, operador_responsavel_nome text,
  valor_total numeric, atualizado_em timestamptz
);

create table public.parcelas (
  id uuid primary key default gen_random_uuid(),
  acordo_id uuid, valor numeric, vencimento date, status text
);

create table public.acordos_titulos (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid, cpf text, vencimento date,
  valor_original numeric, valor_em_aberto numeric, saldo_corrigido numeric,
  situacao text, status text, acordo_id uuid
);

create table public.acordo_titulo_vinculo (titulo_id uuid, ativo boolean default true);

create table public.operador_agenda (
  id uuid primary key default gen_random_uuid(),
  aluno_id text, aluno_nome text not null, operador_email text not null, operador_nome text,
  retorno_em timestamptz not null, titulo text not null default 'Retorno de atendimento',
  tipo text not null default 'RETORNO', status text not null default 'PENDENTE',
  criado_em timestamptz not null default now(), atualizado_em timestamptz not null default now()
);

create table public.aluno_movimentacoes (
  id bigserial primary key, aluno_id text not null, tipo text not null, descricao text,
  operador_anterior_nome text, operador_anterior_email text,
  operador_novo_nome text, operador_novo_email text,
  registrado_por_nome text, registrado_por_email text, registrado_em timestamptz default now()
);

create table public.auditoria (
  id uuid primary key default gen_random_uuid(), usuario text, acao text not null,
  tabela_afetada text, registro_id uuid, detalhes jsonb, created_at timestamp default now()
);

create table public.historico_operadores_alunos (
  id uuid primary key default gen_random_uuid(), aluno_id uuid, chave_unificacao text,
  nome_aluno text, cpf_referencia text, acao text,
  operador_nome text, operador_email text,
  operador_anterior_nome text, operador_anterior_email text,
  observacao text, criado_em timestamptz default now()
);

-- Cópia da view de produção, sem titulo_superado_por_acordo (aposentada em
-- 26/08/2026: a função vive em produção devolvendo sempre false).
create view public.calibragem_saldo_aluno as
with tit as (
  select t.aluno_id, t.cpf,
         sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)) as saldo_mensalidade,
         count(*) as qtd_titulos_abertos, min(t.vencimento) venc_min, max(t.vencimento) venc_max
    from public.acordos_titulos t
   where upper(coalesce(t.situacao,'')) = 'ABERTO' and lower(coalesce(t.status,'')) = 'em_aberto'
     and t.acordo_id is null
     and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id and coalesce(v.ativo, true))
   group by t.aluno_id, t.cpf
), par as (
  select a.aluno_id, sum(coalesce(p.valor,0)) as saldo_acordo, count(*) as qtd_parcelas_abertas
    from public.parcelas p join public.acordos a on a.id = p.acordo_id
   where lower(coalesce(a.status,'')) not in ('cancelado','cancelada')
     and upper(coalesce(p.status,'')) not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
   group by a.aluno_id
)
select coalesce(tit.aluno_id, par.aluno_id) as aluno_id, tit.cpf,
       coalesce(tit.saldo_mensalidade,0) as saldo_mensalidade,
       coalesce(par.saldo_acordo,0) as saldo_acordo,
       coalesce(tit.saldo_mensalidade,0) + coalesce(par.saldo_acordo,0) as saldo_total,
       coalesce(tit.qtd_titulos_abertos,0) as qtd_titulos_abertos,
       coalesce(par.qtd_parcelas_abertas,0) as qtd_parcelas_abertas,
       tit.venc_min, tit.venc_max
  from tit full join par on par.aluno_id = tit.aluno_id;

-- Portão de gestão, igual ao de produção.
create or replace function public.calibragem_e_gestao() returns boolean
language plpgsql stable as $$
declare v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if v_email = '' then return false; end if;
  if v_email in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br') then return true; end if;
  return false;
end; $$;

create or replace function public.calibragem_teto_operador(p_email text) returns integer
language sql stable as $$ select 500 $$;

-- Caminho de escrita oficial, copiado de produção. O detalhe que importa: ao
-- trocar de dono, o agendamento do aluno é zerado.
create or replace function internal.set_resp_aluno(
  p_aluno_id uuid, p_novo_email text, p_novo_nome text, p_tipo text,
  p_descricao text, p_autor_email text, p_autor_nome text
) returns void language plpgsql as $$
declare v_ant_email text; v_ant_nome text;
        v_email text := case when p_novo_email is null then null else lower(p_novo_email) end;
begin
  select responsavel_atual_email, responsavel_atual_nome into v_ant_email, v_ant_nome
    from public.alunos where id = p_aluno_id;
  update public.alunos set
    responsavel_atual_email = v_email, responsavel_atual_nome = p_novo_nome,
    responsavel_atual_em = now(),
    data_ultimo_acionamento = case when v_ant_email is distinct from v_email then null else data_ultimo_acionamento end,
    status_acionamento = case when v_ant_email is distinct from v_email then null else status_acionamento end,
    proxima_acao = case when v_ant_email is distinct from v_email then null else proxima_acao end,
    data_retorno = case when v_ant_email is distinct from v_email then null else data_retorno end,
    hora_retorno = case when v_ant_email is distinct from v_email then null else hora_retorno end
  where id = p_aluno_id;
  insert into public.aluno_movimentacoes
    (aluno_id,tipo,descricao,operador_anterior_nome,operador_anterior_email,
     operador_novo_nome,operador_novo_email,registrado_por_nome,registrado_por_email,registrado_em)
  values (p_aluno_id::text, p_tipo, p_descricao, coalesce(v_ant_nome,'(sem)'), v_ant_email,
          p_novo_nome, v_email, coalesce(p_autor_nome,p_autor_email), p_autor_email, now());
end; $$;

create or replace function internal.set_resp_acordo(
  p_acordo_id uuid, p_novo_email text, p_novo_nome text, p_tipo text,
  p_descricao text, p_autor_email text, p_autor_nome text
) returns void language plpgsql as $$
declare v_ant text; v_aluno uuid;
        v_email text := case when p_novo_email is null then null else lower(p_novo_email) end;
begin
  select operador_responsavel_email, aluno_id into v_ant, v_aluno from public.acordos where id = p_acordo_id;
  update public.acordos set operador_responsavel_email = v_email, atualizado_em = now() where id = p_acordo_id;
  insert into public.aluno_movimentacoes
    (aluno_id,tipo,descricao,operador_anterior_email,operador_novo_email,operador_novo_nome,
     registrado_por_nome,registrado_por_email,registrado_em)
  values (v_aluno::text, p_tipo, p_descricao, v_ant, v_email, p_novo_nome,
          coalesce(p_autor_nome,p_autor_email), p_autor_email, now());
end; $$;

-- Gatilhos de produção em volta do agendamento. Sem eles o teste de
-- preservação passaria por acaso: são eles que apagam retorno_origem e
-- retorno_confirmado_em, e que já protegem o acionamento.
create or replace function public._acionamento_nao_volta_para_nulo() returns trigger
language plpgsql as $$
begin
  if old.data_ultimo_acionamento is not null and new.data_ultimo_acionamento is null then
    new.data_ultimo_acionamento := old.data_ultimo_acionamento;
  end if;
  if old.status_acionamento is not null and nullif(btrim(old.status_acionamento),'') is not null
     and new.status_acionamento is null then
    new.status_acionamento := old.status_acionamento;
  end if;
  return new;
end; $$;
create trigger trg_acionamento_nao_volta_para_nulo
  before update of data_ultimo_acionamento, status_acionamento on public.alunos
  for each row execute function public._acionamento_nao_volta_para_nulo();

create or replace function public.limpar_retorno_origem() returns trigger
language plpgsql as $$
begin
  if new.data_retorno is null then new.retorno_origem := null; end if;
  return new;
end; $$;
create trigger trg_alunos_retorno_origem
  before insert or update of data_retorno, retorno_origem on public.alunos
  for each row execute function public.limpar_retorno_origem();

create or replace function public.tg_aluno_reset_retorno_confirmado() returns trigger
language plpgsql as $$
begin new.retorno_confirmado_em := null; return new; end $$;
create trigger trg_aluno_reset_retorno_confirmado
  before update of data_retorno on public.alunos
  for each row when (new.data_retorno is distinct from old.data_retorno)
  execute function public.tg_aluno_reset_retorno_confirmado();

-- Gatilho de produção: casos segue a ficha do aluno.
create or replace function public._sync_casos_resp_aluno() returns trigger
language plpgsql as $$
begin
  if new.responsavel_atual_email is distinct from old.responsavel_atual_email then
    update public.casos set operador_email = lower(new.responsavel_atual_email),
           operador_nome = new.responsavel_atual_nome, operador = new.responsavel_atual_nome,
           caso_atualizado_em = now()
     where aluno_id = new.id;
  end if;
  return new;
end; $$;
create trigger trg_sync_casos_resp_aluno after update of responsavel_atual_email on public.alunos
  for each row execute function public._sync_casos_resp_aluno();
`;

// As rotinas automáticas de produção, no essencial: TODAS pescam em
// operador_email IS NULL. É o que a Carteira Geral precisa driblar.
const ROTINAS = `
-- As rotinas de produção, reduzidas ao que decide -- mas com as ÂNCORAS do
-- patch da migration 20260924171255 escritas exatamente como estão em
-- produção (conferidas em 24/09/2026). Se alguém mudar a âncora na migration
-- sem mudar aqui, a migration falha neste teste antes de falhar em produção.

create or replace function public.pool_da_fila_livre() returns setof uuid
language sql stable as $$
  select id from public.casos where operador_email is null
$$;

-- as duas portas de auto-atribuição da fila livre
create or replace function public.assumir_caso_livre_aluno(p_aluno_id uuid)
returns table (sucesso boolean, mensagem text, a uuid, b uuid)
language plpgsql security definer set search_path to 'public' as $$
declare v_email text := lower(coalesce(auth.jwt() ->> 'email','')); v_nome text; v_id uuid;
begin
  v_nome := public.nome_operador_por_email(v_email); if v_nome is null then return query select false,'Operador nao ativo.',null::uuid,null::uuid; return; end if;
  select c.id into v_id from public.casos c
   where c.aluno_id = p_aluno_id and c.operador_email is null limit 1;
  if v_id is null then
    return query select false, 'Este caso ja foi assumido por outro operador.',null::uuid,null::uuid; return;
  end if;
  update public.casos set operador_email = v_email where id = v_id;
  return query select true, 'Atendimento assumido.',null::uuid,null::uuid;
end; $$;

create or replace function public.assumir_caso_livre(p_caso_id uuid)
returns table (sucesso boolean, mensagem text, caso_liberado uuid)
language plpgsql security definer set search_path to 'public' as $$
declare v_email text := lower(coalesce(auth.jwt() ->> 'email','')); v_nome text;
begin
  v_nome := public.nome_operador_por_email(v_email);
  if v_nome is null then return query select false,'Operador nao ativo ou nao identificado.',null::uuid; return; end if;
  update public.casos set operador_email = v_email where id = p_caso_id and operador_email is null;
  return query select true, 'Atendimento assumido.', null::uuid;
end; $$;

create or replace function public.sistema_assumir_atendimento(p_aluno_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public','internal' as $$
declare v_email text := lower(coalesce(auth.jwt()->>'email','')); v_nome text;
begin
  v_nome := internal.nome_operador_ativo(v_email); if v_nome is null then return jsonb_build_object('ok',false,'erro','NAO_E_OPERADOR_ATIVO'); end if;
  perform internal.set_resp_aluno(p_aluno_id, v_email, v_nome, 'ASSUMIU_ATENDIMENTO', 'x', v_email, v_nome);
  return jsonb_build_object('ok',true,'aluno_id',p_aluno_id);
end; $$;

create or replace function public.assumir_atendimento_aluno(p_chave_unificacao text, p_observacao text default null)
returns table (sucesso boolean, mensagem text)
language plpgsql security definer set search_path to 'public' as $$
declare v_email text; v_nome text;
begin
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_nome := public.nome_operador_por_email(v_email);
  return query select true, 'Atendimento assumido por ' || v_nome || '.';
end; $$;

create or replace function public.nome_operador_por_email(p_email text) returns text
language sql stable as $$ select upper(split_part(lower(coalesce(p_email,'')), '@', 1)) $$;

-- Igual a produção: exige ativo, e abre exceção para os três e-mails da gestão.
create or replace function internal.nome_operador_ativo(p_email text) returns text
language sql stable security definer set search_path to 'public' as $$
  select u.nome from public.usuarios u
   where lower(u.email)=lower(p_email) and u.ativo=true
     and (u.perfil='operador' or lower(u.email) in
          ('cobranca07@aelbra.com.br','amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br'))
   limit 1
$$;

-- Receptivo: o aluno está no telefone e quem atende leva o caso. Reduzido ao
-- que decide, com a âncora exata de produção.
create or replace function public.sistema_assumir_receptivo(
  p_aluno_id uuid, p_status text, p_observacao text,
  p_data_retorno date default null, p_hora_retorno text default null)
returns jsonb language plpgsql security definer set search_path to 'public','internal' as $$
declare v_email text; v_nome text;
begin
  v_email := lower(coalesce(auth.jwt()->>'email','')); if v_email='' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;
  v_nome := internal.nome_operador_ativo(v_email); if v_nome is null then return jsonb_build_object('ok',false,'erro','NAO_E_OPERADOR_ATIVO'); end if;
  update public.alunos set operador_email=v_email, operador_nome=v_nome where id=p_aluno_id;
  perform internal.set_resp_aluno(p_aluno_id, v_email, v_nome, 'ASSUMIU_ATENDIMENTO', 'Assumiu pela Base Receptiva.', v_email, v_nome);
  return jsonb_build_object('ok',true,'aluno_id',p_aluno_id);
end; $$;

-- Rodízio do receptivo: quem está aqui recebe ligação.
create table public.fila_receptivo (
  operador_email text primary key, operador_nome text, em_pausa boolean default false,
  visto_em timestamptz default now()
);
create or replace function public.fila_receptivo_heartbeat(p_email text, p_nome text, p_em_pausa boolean default false)
returns void language plpgsql set search_path to 'public' as $$
begin
  insert into public.fila_receptivo (operador_email, operador_nome, em_pausa, visto_em)
  values (lower(p_email), p_nome, coalesce(p_em_pausa,false), now())
  on conflict (operador_email) do update set operador_nome=excluded.operador_nome,
    em_pausa=excluded.em_pausa, visto_em=now();
end; $$;

-- PRIVILEGIOS REAIS DE PRODUCAO. Sem eles o teste de ACL seria teatro: o vitest
-- roda como dono do banco, que atravessa tudo e nunca veria o 42501.
-- Medido em producao em 25/09/2026:
--   has_schema_privilege('authenticated','internal','USAGE')  -> false
--   public.fila_receptivo                     acl authenticated=arwdm
--   public.fila_receptivo_heartbeat(...)      acl authenticated=X, service_role=X
--                                             e prosecdef = false (INVOKER)
-- O revoke de usage no schema internal e redundante (schema novo nao concede nada
-- a PUBLIC), mas fica escrito para que a intencao nao dependa de um default.
revoke usage on schema internal from public;
revoke all on function public.fila_receptivo_heartbeat(text, text, boolean) from public;
grant execute on function public.fila_receptivo_heartbeat(text, text, boolean) to authenticated, service_role;
grant select, insert, update on public.fila_receptivo to authenticated;

-- Fidelização: o cron das 08:20 solta o que passou de 10 dias sem acionamento.
create or replace function public.casos_elegiveis_liberacao_fidelizacao()
returns table(caso_id uuid, aluno_id uuid, operador_email text)
language sql stable security definer set search_path to 'public' as $$
  select c.id, c.aluno_id, c.operador_email
  from public.casos c
  where c.operador_email is not null
    and (c.data_ultimo_acionamento is null or c.data_ultimo_acionamento + 10 < current_date);
$$;
create or replace function public.liberar_casos_fidelizacao_vencida()
returns integer language plpgsql security definer set search_path to 'public' as $$
declare r record; n int := 0;
begin
  for r in select * from public.casos_elegiveis_liberacao_fidelizacao() loop
    update public.casos set operador_email=null, operador_nome=null, operador=null where id=r.caso_id;
    update public.alunos set responsavel_atual_email=null, responsavel_atual_nome=null where id=r.aluno_id;
    n := n + 1;
  end loop;
  return n;
end; $$;

-- O gatilho que realinha a ficha ao dono do acordo ATIVO.
create or replace function public._aluno_segue_dono_do_acordo() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_mensalidade numeric; v_e_operador boolean;
begin
  if nullif(trim(coalesce(new.operador_responsavel_email,'')),'') is null then return new; end if;
  if upper(coalesce(new.status,'')) <> 'ATIVO' then return new; end if;
  select (u.perfil = 'operador' and u.ativo) into v_e_operador
    from public.usuarios u where lower(u.email) = lower(new.operador_responsavel_email);
  if coalesce(v_e_operador, false) = false then return new; end if;
  select coalesce(sum(coalesce(t.saldo_corrigido,t.valor_original,0)),0) into v_mensalidade
    from public.acordos_titulos t
   where t.aluno_id = new.aluno_id and upper(coalesce(t.situacao,'')) = 'ABERTO'
     and lower(coalesce(t.status,'')) = 'em_aberto' and t.acordo_id is null;
  if coalesce(v_mensalidade, 0) > 0.005 then return new; end if;
  begin
    perform set_config('reativa.dono_por_acordo', '1', true);
    update public.alunos
       set responsavel_atual_email = new.operador_responsavel_email,
           responsavel_atual_nome = coalesce(new.operador_responsavel_nome, responsavel_atual_nome)
     where id = new.aluno_id
       and lower(coalesce(responsavel_atual_email,'')) is distinct from lower(new.operador_responsavel_email);
    perform set_config('reativa.dono_por_acordo', '0', true);
  exception when others then
    perform set_config('reativa.dono_por_acordo', '0', true);
  end;
  return new;
end; $$;
create trigger trg_aluno_segue_dono_do_acordo
  after insert or update of operador_responsavel_email, status on public.acordos
  for each row execute function public._aluno_segue_dono_do_acordo();

-- as quatro rotinas automáticas, só com as âncoras
create or replace function public.nivelamento_automatico_gestao(
  p_dias integer default 10, p_aplicar boolean default true,
  p_origens text[] default array['amanda.seibel@aelbra.com.br'::text])
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_n int;
begin
  create temp table _op on commit drop as
  select u.email, u.nome
    from public.usuarios u
   where u.ativo and u.perfil = 'operador' and not (u.email = any(p_origens));
  select count(*) into v_n from _op;
  return jsonb_build_object('destinos', v_n);
end; $$;

create or replace function public.calibragem_simular_nivelamento_impl(p_criterio jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_n int;
begin
  create temp table _op on commit drop as
    select u.email op_email, u.nome op_nome
    from public.usuarios u
    where u.ativo and u.perfil = 'operador';
  select count(*) into v_n from _op;
  return jsonb_build_object('operadores', v_n);
end; $$;

create or replace function public.reforcar_teto_operadores() returns integer
language plpgsql security definer set search_path to 'public' as $$
DECLARE v_op RECORD; v_total INT := 0;
BEGIN
  FOR v_op IN
    SELECT operador_email, count(*) AS qtd
    FROM public.casos
    WHERE operador_email IS NOT NULL AND operador_email <> 'amanda.seibel@aelbra.com.br'
    GROUP BY operador_email HAVING count(*) > 0
  LOOP
    v_total := v_total + 1;
  END LOOP;
  RETURN v_total;
END; $$;

create or replace function public.nivelar_medias_progressivo() returns integer
language plpgsql security definer set search_path to 'public' as $$
DECLARE v_media numeric; v_op RECORD; v_total INT := 0;
BEGIN
  SELECT round(avg(coalesce(total,0))::numeric,2) INTO v_media FROM public.casos WHERE operador_email IS NOT NULL AND operador_email <> 'amanda.seibel@aelbra.com.br';
  FOR v_op IN SELECT operador_email, count(*) AS qtd FROM public.casos WHERE operador_email IS NOT NULL AND operador_email <> 'amanda.seibel@aelbra.com.br' GROUP BY operador_email LOOP
    v_total := v_total + 1;
  END LOOP;
  RETURN v_total;
END; $$;

create or replace function public.reposicao_carteira_processar(p_max_pedidos integer default 5)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare ped record; v_pulados int := 0;
begin
  for ped in select f.* from public.reposicao_carteira_fila f where f.processado_em is null loop
    if not exists (select 1 from public.usuarios u where u.email = ped.operador_email and u.perfil = 'operador' and u.ativo = true) then
      update public.reposicao_carteira_fila
         set processado_em = now(), repostos = 0, erro = 'operador nao esta mais ativo'
       where id = ped.id;
      v_pulados := v_pulados + 1;
      continue;
    end if;
    update public.reposicao_carteira_fila set processado_em = now(), repostos = 1 where id = ped.id;
  end loop;
  return jsonb_build_object('pulados', v_pulados);
end; $$;

create table public.reposicao_carteira_fila (
  id bigserial primary key, operador_email text not null, operador_nome text,
  tipo text not null default 'QUITADO', processado_em timestamptz, repostos int, erro text,
  criado_em timestamptz not null default now()
);

create or replace function public.atribuir_responsavel_por_acordo() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_nome text;
begin
  if coalesce(new.operador_responsavel_email,'') = '' then return new; end if;
  select nome into v_nome from public.usuarios where lower(email) = lower(new.operador_responsavel_email) limit 1;
  insert into public.notificacoes (usuario_destino_email, titulo) values (new.operador_responsavel_email, 'Novo acordo');
  return new;
end; $$;

create table public.notificacoes (
  id uuid primary key default gen_random_uuid(),
  usuario_destino_email text, titulo text, criado_em timestamptz default now()
);
create trigger trg_atribuir_responsavel_por_acordo
  after insert or update of operador_responsavel_email, status on public.acordos
  for each row execute function public.atribuir_responsavel_por_acordo();
`;

// Montar o banco do zero custa ~700ms: esqueleto + rotinas + quatro migrations.
// Multiplicado pelos casos de teste isso dobrava a duração da suíte inteira e
// fazia OUTROS arquivos estourarem o timeout padrão por falta de CPU. O banco
// é montado UMA vez e despejado; cada teste abre uma cópia limpa do despejo.
let DESPEJO = null;

async function construir() {
  const db = new PGlite();
  await db.exec(ESQUELETO);
  await db.exec(ROTINAS);
  await db.exec("set timezone = 'UTC'");

  await db.exec(`
    insert into public.usuarios (nome,email,perfil,ativo) values
      ('Amanda','${GESTAO}','gerencia',true),
      ('Fernanda','${FERNANDA}','supervisor',true),
      ('Amanda Borges','${ADM}','administrativo',true),
      ('Olga','${OLGA}','operador',true),
      ('Luana','${LUANA}','operador',true);
  `);

  for (const nome of MIGRATIONS) await db.exec(MIG(nome));
  return db;
}

export async function montar() {
  if (!DESPEJO) {
    const base = await construir();
    DESPEJO = await base.dumpDataDir();
    await base.close();
  }
  const db = new PGlite({ loadDataDir: DESPEJO });
  await db.exec("set timezone = 'UTC'");
  return db;
}

// Um aluno com caso, mensalidade em aberto, acordo vivo, retorno agendado
// (data + hora + origem) e a agenda do operador apontando para o dono.
export async function semear(db, {
  nome, dono, retorno = "2026-10-01", hora = "14:30", mensalidade = 1000,
  parcela = 2000, donoAcordo = null, statusAcordo = "ATIVO",
}) {
  const aluno = (await q1(db,
    `insert into public.alunos (nome, responsavel_atual_email, responsavel_atual_nome,
        data_retorno, hora_retorno, retorno_origem, proxima_acao, retorno_confirmado_em,
        data_ultimo_acionamento, status_acionamento)
     values ($1,$2,$3,$4,$5,'OPERADOR','CONTATAR', now(), now(), 'MENSAGEM ENVIADA') returning id`,
    [nome, dono, dono, retorno, hora])).id;

  const caso = (await q1(db,
    "insert into public.casos (aluno_id,nome,cpf_limpo,operador_email,operador_nome,data_retorno) values ($1,$2,$3,$4,$5,$6) returning id",
    [aluno, nome, "11122233344", dono, dono, retorno])).id;

  await db.query(
    "insert into public.acordos_titulos (aluno_id,vencimento,valor_original,saldo_corrigido,situacao,status) values ($1,'2026-03-10',$2,$2,'ABERTO','em_aberto')",
    [aluno, mensalidade]);

  const acordo = (await q1(db,
    "insert into public.acordos (aluno_id,status,numero_acordo,operador_responsavel_email,valor_total) values ($1,$2,777,$3,$4) returning id",
    [aluno, statusAcordo, donoAcordo ?? dono, parcela])).id;

  await db.query("insert into public.parcelas (acordo_id,valor,vencimento,status) values ($1,$2,'2026-11-10','A_VENCER')", [acordo, parcela]);

  if (dono) {
    await db.query(
      "insert into public.operador_agenda (aluno_id, aluno_nome, operador_email, operador_nome, retorno_em) values ($1,$2,$3,$4,$5)",
      [aluno, nome, dono, dono, `${retorno}T${hora}:00Z`]);
  }

  return { aluno, caso, acordo };
}
