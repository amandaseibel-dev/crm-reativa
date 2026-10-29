-- C1 — Desafio da semana (coletivo).
--
-- SO DESAFIO COLETIVO. Nao existe coluna de operador, nem agrupamento por pessoa,
-- nem ranking: o progresso e um numero unico da equipe.
--
-- PROGRESSO NUNCA E DIGITADO. A gestao escolhe um indicador de uma lista fechada,
-- e o numero e contado do dado real no periodo. O unico jeito de um desafio nao
-- ter progresso e ser INFORMATIVO -- e nesse caso ele nao tem meta nenhuma, para
-- que nao apareca barra fingindo medir algo.
--
-- INDICADORES DISPONIVEIS (todos coletivos, nenhum financeiro):
--   ELOGIOS_PUBLICADOS   elogios que a gestao publicou no periodo
--   ELOGIOS_REGISTRADOS  elogios que a equipe registrou no periodo
--   IDEIAS_ENVIADAS      sugestoes criadas no periodo
--   MUSICAS_ADICIONADAS  musicas entradas na playlist no periodo
--   CURTIDAS_DADAS       curtidas dadas no periodo
--   INFORMATIVO          sem medicao -- so titulo, descricao e objetivo
--
-- Nao ha indicador de cobranca, acordo, pagamento, honorario, meta financeira,
-- Preventivo nem Efetividade. Isto e mural de equipe, nao painel de resultado.

create table if not exists public.portal_desafios (
  id uuid primary key default gen_random_uuid(),
  titulo text not null check (length(trim(titulo)) between 3 and 160),
  descricao text check (descricao is null or length(trim(descricao)) <= 1000),
  objetivo text check (objetivo is null or length(trim(objetivo)) <= 400),
  indicador text not null default 'INFORMATIVO'
    check (indicador in ('INFORMATIVO','ELOGIOS_PUBLICADOS','ELOGIOS_REGISTRADOS',
                         'IDEIAS_ENVIADAS','MUSICAS_ADICIONADAS','CURTIDAS_DADAS')),
  meta integer check (meta is null or meta > 0),
  inicio_em date not null,
  fim_em date not null,
  ativo boolean not null default true,
  criado_por_email text,
  criado_em timestamptz not null default now(),

  constraint portal_desafios_periodo_valido check (fim_em >= inicio_em),

  -- O par indicador/meta e coerente ou nao entra: indicador mensuravel EXIGE
  -- meta, e INFORMATIVO nao aceita meta -- e assim que se impede "numero manual
  -- fingindo ser indicador automatico".
  constraint portal_desafios_meta_coerente check (
    (indicador = 'INFORMATIVO' and meta is null)
    or (indicador <> 'INFORMATIVO' and meta is not null)
  )
);

create index if not exists portal_desafios_periodo_idx
  on public.portal_desafios (inicio_em, fim_em) where ativo;

alter table public.portal_desafios enable row level security;

-- Toda a equipe le o desafio.
drop policy if exists portal_desafios_leitura on public.portal_desafios;
create policy portal_desafios_leitura on public.portal_desafios
for select to authenticated using (true);

-- Cadastrar e editar e da gestao, e a regra vive AQUI -- nao em botao escondido.
-- Usa o helper que ja existe (usuario_e_gestao()), em vez de repetir e-mails:
-- a tabela e nova, entao nasce ligada a regra vigente em vez de a uma copia dela.
drop policy if exists portal_desafios_gestao on public.portal_desafios;
create policy portal_desafios_gestao on public.portal_desafios
for all to authenticated
using (public.usuario_e_gestao())
with check (public.usuario_e_gestao());

-- O desafio vigente, com o progresso contado do dado real.
--
-- SECURITY DEFINER porque conta elogios_atendimento e sugestoes, que tem RLS
-- restrita. Devolve APENAS o total -- nenhuma linha, nenhum texto, nenhum e-mail
-- dessas tabelas sai por aqui, e as policies delas seguem intocadas.
--
-- O periodo e comparado com a data de HOJE em America/Sao_Paulo, e cada contagem
-- usa a mesma janela [inicio_em 00:00, fim_em+1 00:00) no fuso de Sao Paulo.
create or replace function public.portal_desafio_vigente()
returns table (
  id uuid,
  titulo text,
  descricao text,
  objetivo text,
  indicador text,
  meta integer,
  progresso integer,
  inicio_em date,
  fim_em date
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  d record;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_de timestamp;
  v_ate timestamp;
  v_progresso integer := null;
begin
  select * into d
    from public.portal_desafios x
   where x.ativo
     and v_hoje between x.inicio_em and x.fim_em
   order by x.inicio_em desc, x.criado_em desc
   limit 1;

  if not found then
    return;
  end if;

  v_de := d.inicio_em::timestamp;
  v_ate := (d.fim_em + 1)::timestamp;

  if d.indicador = 'ELOGIOS_PUBLICADOS' then
    select count(*)::int into v_progresso from public.elogios_atendimento e
     where e.status = 'PUBLICADO_TV'
       and (e.publicado_em at time zone 'America/Sao_Paulo') >= v_de
       and (e.publicado_em at time zone 'America/Sao_Paulo') <  v_ate;

  elsif d.indicador = 'ELOGIOS_REGISTRADOS' then
    select count(*)::int into v_progresso from public.elogios_atendimento e
     where (e.registrado_em at time zone 'America/Sao_Paulo') >= v_de
       and (e.registrado_em at time zone 'America/Sao_Paulo') <  v_ate;

  elsif d.indicador = 'IDEIAS_ENVIADAS' then
    select count(*)::int into v_progresso from public.sugestoes s
     where (s.criado_em at time zone 'America/Sao_Paulo') >= v_de
       and (s.criado_em at time zone 'America/Sao_Paulo') <  v_ate;

  elsif d.indicador = 'MUSICAS_ADICIONADAS' then
    select count(*)::int into v_progresso from public.portal_playlist p
     where (p.criado_em at time zone 'America/Sao_Paulo') >= v_de
       and (p.criado_em at time zone 'America/Sao_Paulo') <  v_ate;

  elsif d.indicador = 'CURTIDAS_DADAS' then
    select count(*)::int into v_progresso from public.portal_curtidas k
     where (k.criado_em at time zone 'America/Sao_Paulo') >= v_de
       and (k.criado_em at time zone 'America/Sao_Paulo') <  v_ate;

  else
    -- INFORMATIVO: sem medicao. Devolve nulo em vez de inventar numero.
    v_progresso := null;
  end if;

  return query select d.id, d.titulo, d.descricao, d.objetivo, d.indicador,
                      d.meta, v_progresso, d.inicio_em, d.fim_em;
end
$$;

comment on function public.portal_desafio_vigente() is
  'Desafio coletivo vigente hoje (America/Sao_Paulo) com o progresso contado do dado real no periodo. SECURITY DEFINER para contar elogios e sugestoes sem afrouxar a RLS delas -- devolve apenas o total. INFORMATIVO devolve progresso nulo, nunca numero fabricado.';

revoke execute on function public.portal_desafio_vigente() from anon, public;
grant execute on function public.portal_desafio_vigente() to authenticated;
