-- "Alunos por status" passa a LER snapshot, em vez de reconstruir o universo.
--
-- POR QUE. `carteira_academico_perfil` reconstroi `carteira_academico_universo` a
-- cada abertura da tela. Em 2024 isso estoura o statement_timeout de 8s do papel
-- `authenticated` -- reproduzido 3 vezes em 06/10/2026 -- e o bloco sumia. Nao e
-- cache frio ocasional: e um recalculo de segundos por natureza, e qualquer
-- variacao de I/O o joga para fora do teto.
--
-- O QUE JA FOI TENTADO E REFUTADO: tirar o LATERAL e adiantar filtros (PR #620).
-- Medido em ensaio revertido em producao, com o corpo otimizado ATIVO dentro da
-- transacao: 2024 estourou os 8s do mesmo jeito. O ganho era ~20%, e a distancia
-- ate o teto e maior que isso. Reescrever consulta nao resolve este caso.
--
-- O DESENHO E O QUE ESTE CRM JA USA para agregados caros: snapshot em tabela,
-- rotina que recalcula, tela que le. Mesmo padrao de
-- `carteira_saldo_historico_snapshot` e `carteira_2026_1_snapshot`.
--
-- EQUIVALENCIA POR CONSTRUCAO: o snapshot guarda o jsonb que a PROPRIA
-- `carteira_academico_perfil` devolve, sem reprocessar nada. Categoria, contagem
-- e rotulo sao os mesmos objetos -- nao ha regra academica nova, nem
-- reclassificacao, nem arredondamento. O recalculo ainda ASSERTA isso: compara o
-- que acabou de gravar com uma segunda chamada da funcao viva e aborta se diferir.
--
-- ESCOPO: 2024, 2025 e 2026/1. 2026/2 NAO entra -- a visao por vencimento usa
-- outro caminho (`carteira_2026_2_classificar`) e nao foi tocada. As seis linhas
-- financeiras vem de `carteira_safra_situacoes` e tambem nao foram tocadas.

-- ---------------------------------------------------------------- 1. a tabela
create table if not exists public.carteira_academico_perfil_snapshot (
  recorte              text        primary key,   -- '2024' | '2025' | '2026/1'
  ano                  text        not null,
  semestre             text,
  payload              jsonb       not null,
  total_alunos         integer     not null,
  categorias           integer     not null,
  -- a assinatura da FONTE: max(alunos.academico_atualizado_em) do recorte. E por
  -- ela que a rotina sabe que a importacao mexeu e o snapshot precisa voltar.
  fonte_atualizada_em  timestamptz,
  gerado_em            timestamptz not null default now(),
  duracao_ms           integer
);

comment on table public.carteira_academico_perfil_snapshot is
  'Fotografia de carteira_academico_perfil por recorte. A tela le daqui; quem reconstroi e carteira_academico_perfil_sincronizar().';

-- Tabela nova herda privilegios amplos do schema public -- inclusive TRUNCATE
-- para authenticated, e RLS nao cobre TRUNCATE. Fecha explicitamente: a leitura
-- da tela passa pela funcao SECURITY DEFINER, nunca pela tabela.
alter table public.carteira_academico_perfil_snapshot enable row level security;
revoke all on table public.carteira_academico_perfil_snapshot from public, anon, authenticated;
grant select, insert, update, delete on table public.carteira_academico_perfil_snapshot to service_role;

-- ------------------------------------------------------- 2. recalculo (escrita)
create or replace function public.carteira_academico_perfil_recalcular(p_recorte text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  r            record;
  v_payload    jsonb;
  v_confere    jsonb;
  v_t0         timestamptz;
  v_fonte      timestamptz;
  v_feitos     jsonb := '[]'::jsonb;
begin
  -- Escrita: so service_role (cron, rotina) ou a gestao pela tela.
  if not (coalesce(auth.role(),'') = 'service_role'
          or auth.jwt() is null
          or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  for r in
    select * from (values ('2024','2024',null::text),
                          ('2025','2025',null::text),
                          ('2026/1','2026','1')) v(recorte, ano, semestre)
     where p_recorte is null or v.recorte = p_recorte
  loop
    v_t0 := clock_timestamp();
    v_payload := public.carteira_academico_perfil(r.ano, r.semestre);

    -- ASSERCAO DE EQUIVALENCIA: segunda chamada da funcao viva tem de devolver o
    -- mesmo total e as mesmas categorias. Se diferir, a base mudou no meio e o
    -- snapshot seria uma mistura de dois instantes -- aborta em vez de gravar.
    v_confere := public.carteira_academico_perfil(r.ano, r.semestre);
    if (v_payload->>'total_alunos') is distinct from (v_confere->>'total_alunos')
       or (v_payload->'importacao'->'situacoes') is distinct from (v_confere->'importacao'->'situacoes') then
      raise exception 'recorte % mudou entre duas leituras seguidas; snapshot nao gravado', r.recorte;
    end if;

    if coalesce((v_payload->>'total_alunos')::int, 0) = 0 then
      raise exception 'recorte % devolveu zero alunos; snapshot nao gravado', r.recorte;
    end if;

    select max(al.academico_atualizado_em) into v_fonte
      from public.carteira_academico_universo(r.ano, r.semestre) u
      join public.alunos al on al.id = u.aluno_id;

    insert into public.carteira_academico_perfil_snapshot
      (recorte, ano, semestre, payload, total_alunos, categorias, fonte_atualizada_em, gerado_em, duracao_ms)
    values
      (r.recorte, r.ano, r.semestre, v_payload,
       (v_payload->>'total_alunos')::int,
       jsonb_array_length(coalesce(v_payload->'importacao'->'situacoes','[]'::jsonb)),
       v_fonte, now(),
       round(extract(epoch from (clock_timestamp()-v_t0))*1000)::int)
    on conflict (recorte) do update
      set payload = excluded.payload, ano = excluded.ano, semestre = excluded.semestre,
          total_alunos = excluded.total_alunos, categorias = excluded.categorias,
          fonte_atualizada_em = excluded.fonte_atualizada_em,
          gerado_em = excluded.gerado_em, duracao_ms = excluded.duracao_ms;

    v_feitos := v_feitos || jsonb_build_object(
      'recorte', r.recorte, 'alunos', (v_payload->>'total_alunos')::int,
      'categorias', jsonb_array_length(coalesce(v_payload->'importacao'->'situacoes','[]'::jsonb)),
      'ms', round(extract(epoch from (clock_timestamp()-v_t0))*1000)::int);
  end loop;

  return jsonb_build_object('gerado_em', now(), 'recortes', v_feitos);
end;
$function$;

revoke all on function public.carteira_academico_perfil_recalcular(text) from public, anon;
grant execute on function public.carteira_academico_perfil_recalcular(text) to authenticated, service_role;

-- -------------------------------------------- 3. sincronizacao pela fonte
-- Recalcula SO o recorte cuja fonte academica mudou desde a ultima fotografia,
-- mais o que nunca foi tirado. E isto que atende "atualizar quando a importacao
-- for atualizada" sem refazer os tres toda hora.
create or replace function public.carteira_academico_perfil_sincronizar()
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  r          record;
  v_fonte    timestamptz;
  v_mexidos  jsonb := '[]'::jsonb;
begin
  if not (coalesce(auth.role(),'') = 'service_role' or auth.jwt() is null
          or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  for r in
    select * from (values ('2024','2024',null::text),
                          ('2025','2025',null::text),
                          ('2026/1','2026','1')) v(recorte, ano, semestre)
  loop
    select max(al.academico_atualizado_em) into v_fonte
      from public.carteira_academico_universo(r.ano, r.semestre) u
      join public.alunos al on al.id = u.aluno_id;

    if not exists (select 1 from public.carteira_academico_perfil_snapshot s
                    where s.recorte = r.recorte
                      and s.fonte_atualizada_em is not distinct from v_fonte) then
      perform public.carteira_academico_perfil_recalcular(r.recorte);
      v_mexidos := v_mexidos || to_jsonb(r.recorte);
    end if;
  end loop;

  return jsonb_build_object('verificado_em', now(), 'recalculados', v_mexidos);
end;
$function$;

revoke all on function public.carteira_academico_perfil_sincronizar() from public, anon;
grant execute on function public.carteira_academico_perfil_sincronizar() to authenticated, service_role;

-- ----------------------------------------------------- 4. leitura (a tela)
create or replace function public.carteira_academico_perfil_ler(p_ano text, p_semestre text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_recorte text;
  v_out     jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  v_recorte := case when p_ano = '2026' then p_ano || '/' || coalesce(p_semestre,'1') else p_ano end;

  select s.payload
         || jsonb_build_object('snapshot', jsonb_build_object(
              'gerado_em', s.gerado_em,
              'fonte_atualizada_em', s.fonte_atualizada_em,
              'duracao_ms', s.duracao_ms))
    into v_out
    from public.carteira_academico_perfil_snapshot s
   where s.recorte = v_recorte;

  -- Sem fotografia a tela precisa DIZER isso, nunca cair em lista vazia -- que e
  -- indistinguivel de "nao ha categorias" e foi exatamente como o bloco sumiu.
  return coalesce(v_out, jsonb_build_object('sem_snapshot', true, 'recorte', v_recorte));
end;
$function$;

revoke all on function public.carteira_academico_perfil_ler(text, text) from public, anon;
grant execute on function public.carteira_academico_perfil_ler(text, text) to authenticated, service_role;

-- --------------------------------------------------- 5. primeira fotografia
select public.carteira_academico_perfil_recalcular();

-- ------------------------------------------------------------- 6. a rotina
-- Diaria, cedo, depois da janela de importacao. Recalcula so quem mudou.
select cron.schedule('carteira_academico_perfil_sincronizar', '25 6 * * *',
                     $cron$select public.carteira_academico_perfil_sincronizar();$cron$)
 where not exists (select 1 from cron.job where jobname = 'carteira_academico_perfil_sincronizar');
