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
  data_retorno date, hora_retorno text
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
create or replace function public.pool_da_fila_livre() returns setof uuid
language sql stable as $$
  select id from public.casos where operador_email is null
$$;

-- assumir_caso_livre_aluno de produção, reduzido ao que decide: só pega caso
-- cujo operador_email é nulo.
create or replace function public.assumir_caso_livre_aluno(p_aluno_id uuid)
returns table (sucesso boolean, mensagem text)
language plpgsql as $$
declare v_email text := lower(coalesce(auth.jwt() ->> 'email','')); v_id uuid;
begin
  select c.id into v_id from public.casos c
   where c.aluno_id = p_aluno_id and c.operador_email is null limit 1;
  if v_id is null then
    return query select false, 'Este caso ja foi assumido por outro operador.'; return;
  end if;
  update public.casos set operador_email = v_email where id = v_id;
  return query select true, 'Atendimento assumido.';
end; $$;
`;

export async function montar() {
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

// Um aluno com caso, mensalidade em aberto, acordo vivo e retorno agendado.
export async function semear(db, { nome, dono, retorno = "2026-10-01", mensalidade = 1000, parcela = 2000, donoAcordo = null }) {
  const aluno = (await q1(db, "insert into public.alunos (nome, responsavel_atual_email, responsavel_atual_nome, data_retorno) values ($1,$2,$3,$4) returning id", [nome, dono, dono, retorno])).id;
  const caso = (await q1(db, "insert into public.casos (aluno_id,nome,cpf_limpo,operador_email,operador_nome,data_retorno) values ($1,$2,$3,$4,$5,$6) returning id", [aluno, nome, "11122233344", dono, dono, retorno])).id;
  await db.query("insert into public.acordos_titulos (aluno_id,vencimento,valor_original,saldo_corrigido,situacao,status) values ($1,'2026-03-10',$2,$2,'ABERTO','em_aberto')", [aluno, mensalidade]);
  const acordo = (await q1(db, "insert into public.acordos (aluno_id,status,numero_acordo,operador_responsavel_email,valor_total) values ($1,'ATIVO',777,$2,$3) returning id", [aluno, donoAcordo ?? dono, parcela])).id;
  await db.query("insert into public.parcelas (acordo_id,valor,vencimento,status) values ($1,$2,'2026-11-10','A_VENCER')", [acordo, parcela]);
  return { aluno, caso, acordo };
}
