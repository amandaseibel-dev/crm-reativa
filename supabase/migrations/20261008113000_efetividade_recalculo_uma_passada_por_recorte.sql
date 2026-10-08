-- EFETIVIDADE -- o recalculo passa a derivar o universo pesado UMA vez por
-- recorte, e a lista individual de pendencias volta a ser lida AO VIVO.
--
-- ===========================================================================
-- O QUE QUEBROU EM PRODUCAO, MEDIDO EM 08/10/2026
-- ===========================================================================
-- A camada de leitura foi aplicada as 11:15. A primeira fotografia nunca saiu:
--   * dentro da propria migration ....... estourou e REVERTEU a migration
--   * `recalcular('2024')` manual ....... statement_timeout (teto de 2 min)
--   * dreno do cron, 11:20:00->11:22:00 . statement_timeout, `status: failed`
-- O pg_cron deste projeto roda com o MESMO teto de 2 min, entao o dreno ia
-- falhar a cada 5 minutos indefinidamente, queimando ~2 min de consulta pesada
-- por tentativa. Os dois crons foram desagendados as 11:26 para parar a carga.
--
-- A CAUSA. O `insert` que populava `carteira_pendencias_item_snapshot` chamava
-- `carteira_pendencias_itens` uma vez POR MOTIVO, via `cross join lateral`, e
-- cada chamada re-derivava do zero o agregado de 400.693 linhas de
-- `prime_titulo_semestre`. Somando a chamada de `carteira_pendencias_por_motivo`
-- que o mesmo statement fazia para listar os motivos, davam 3 a 4 passadas
-- pesadas num statement so -- e isso por recorte.
--
-- ===========================================================================
-- A CORRECAO, EM DUAS PARTES
-- ===========================================================================
-- 1. UMA PASSADA POR RECORTE. O recalculo passa a chamar as TRES funcoes
--    oficiais exatamente uma vez cada, por recorte, e guardar o retorno. A
--    populacao do snapshot de itens SAI: ela era a unica coisa que multiplicava
--    passadas.
--
-- 2. A LISTA INDIVIDUAL VOLTA A SER AO VIVO. `carteira_pendencias_itens` nao e
--    mais fotografada, e `carteira_pendencias_itens_ler` passa a delegar para
--    ela. Alem de resolver o custo, isso e o comportamento CERTO para a Fila
--    Unica: ela trata caso a caso, e trabalhar sobre fotografia significaria
--    oferecer para tratamento um caso que talvez ja esteja resolvido.
--    A ASSINATURA DE RETORNO NAO MUDA -- as mesmas 17 colunas, na mesma ordem,
--    com `gerado_em` passando a ser o instante da leitura. O front nao muda.
--
-- 3. TETO INTERNO. `set statement_timeout to '240s'` na funcao de recalculo. O
--    teto de 8s e do papel da sessao e o de 2 min e do canal/cron; este SET vale
--    enquanto a funcao roda e e o que permite a reconstrucao inteira terminar.
--
-- ===========================================================================
-- O QUE ESTA MIGRATION NAO FAZ
-- ===========================================================================
-- NAO toca filtro, valor ou regua. Em particular a REGUA HISTORICA OFICIAL de
-- 2024/2025 em `carteira_em_aberto_por_status_academico` fica exatamente como
-- esta: `portador = 195`, exclusao de m166 sem acordo ativo, de confirmacao
-- pendente, de caso cancelado/juridico, de liquidado na Prime apos vencimento+30
-- e de aluno coberto por pagamentos desde 01/07/2026, com alunos por
-- count(distinct cpf), titulos por count(*) e valor por sum(saldo). Nada disso e
-- recompilado aqui.
--
-- NAO toca `carteira_safra_situacoes`, `carteira_2026_1_classificar`,
-- `carteira_em_aberto_por_status_academico`, `carteira_pendencias_por_motivo`,
-- `carteira_pendencias_itens`, `carteira_saldo_historico_*`,
-- `carteira_academico_perfil_*`, `carteira_2026_2_*`, o fluxo `EM_CONFIRMACAO`,
-- as RPCs da Conferencia Prime, os 4 gatilhos de invalidacao,
-- `carteira_efetividade_invalidar`, `_solicitar_atualizacao`,
-- `_recalcular_pendentes` nem `carteira_efetividade_ler`.
--
-- `carteira_pendencias_item_snapshot` fica no schema, VAZIA e sem leitor nem
-- escritor. Nao a derrubo aqui porque derrubar tabela e mudanca de estrutura
-- fora do escopo desta correcao; fica registrada como divida para uma frente
-- propria.
--
-- Reversivel: supabase/rollbacks/20261008113000_*.rollback.sql

-- ===========================================================================
-- 1. O RECALCULO -- uma passada por recorte, com teto interno
-- ===========================================================================
create or replace function public.carteira_efetividade_recalcular(p_recorte text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
-- Ver o cabecalho: sem isto a reconstrucao e cortada no meio pelo teto da
-- sessao (8s no papel `authenticated`) ou do cron (2 min), e a fotografia nunca
-- sai. 240s da folga de ~4x sobre a passada medida mais lenta.
set statement_timeout to '240s'
as $function$
declare
  r         record;
  v_t0      timestamptz;
  v_payload jsonb;
  v_ms      integer;
  v_feitos  jsonb := '[]'::jsonb;
  v_tecnico boolean := (current_setting('request.jwt.claims', true) is null)
                        or coalesce(auth.role(),'') = 'service_role';
begin
  -- Escrita: so a rotina (service_role / sem JWT) ou a gestao. Inalterado.
  if not v_tecnico and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  -- Dois recalculos ao mesmo tempo gastariam o dobro do banco para gravar a
  -- mesma coisa. O segundo desiste e DIZ que desistiu, em vez de enfileirar --
  -- importante porque o dreno roda de 5 em 5 min e uma passada pode levar mais
  -- de 5 min num dia ruim.
  if not pg_try_advisory_xact_lock(hashtext('carteira_efetividade_recalcular')) then
    return jsonb_build_object('ja_em_andamento', true, 'verificado_em', now());
  end if;

  for r in
    select * from (values ('2024','2024',null::text),
                          ('2025','2025',null::text),
                          ('2026/1','2026','1')) v(recorte, ano, semestre)
     where p_recorte is null or v.recorte = p_recorte
  loop
    -- ---------------------------------------------------- bloco seis_linhas
    v_t0 := clock_timestamp();
    v_payload := public.carteira_safra_situacoes(r.ano, r.semestre);
    v_ms := round(extract(epoch from (clock_timestamp() - v_t0)) * 1000);
    if coalesce((v_payload->'conferencia'->>'fecha')::boolean, false)
       and coalesce((v_payload->'situacoes'->'entrou'->>'valor')::numeric, 0) > 0 then
      insert into public.carteira_efetividade_snapshot (bloco, recorte, payload, gerado_em, duracao_ms)
      values ('seis_linhas', r.recorte, v_payload, now(), v_ms)
      on conflict (bloco, recorte) do update
        set payload = excluded.payload, gerado_em = excluded.gerado_em,
            duracao_ms = excluded.duracao_ms;
      v_feitos := v_feitos || jsonb_build_object('bloco','seis_linhas','recorte',r.recorte,'ms',v_ms);
    else
      v_feitos := v_feitos || jsonb_build_object('bloco','seis_linhas','recorte',r.recorte,
                                                 'ms',v_ms,'descartado','conferencia nao fechou');
    end if;

    -- -------------------------------------------- bloco composicao_academica
    v_t0 := clock_timestamp();
    v_payload := public.carteira_em_aberto_por_status_academico(r.ano, r.semestre);
    v_ms := round(extract(epoch from (clock_timestamp() - v_t0)) * 1000);
    if coalesce((v_payload->'conferencia'->>'fecha')::boolean, false)
       and coalesce((v_payload->'total'->>'valor')::numeric, 0) > 0 then
      insert into public.carteira_efetividade_snapshot (bloco, recorte, payload, gerado_em, duracao_ms)
      values ('composicao_academica', r.recorte, v_payload, now(), v_ms)
      on conflict (bloco, recorte) do update
        set payload = excluded.payload, gerado_em = excluded.gerado_em,
            duracao_ms = excluded.duracao_ms;
      v_feitos := v_feitos || jsonb_build_object('bloco','composicao_academica','recorte',r.recorte,'ms',v_ms);
    else
      v_feitos := v_feitos || jsonb_build_object('bloco','composicao_academica','recorte',r.recorte,
                                                 'ms',v_ms,'descartado','conferencia nao fechou');
    end if;

    -- ------------------------------------------ bloco pendencias_por_motivo
    v_t0 := clock_timestamp();
    v_payload := public.carteira_pendencias_por_motivo(r.ano, r.semestre);
    v_ms := round(extract(epoch from (clock_timestamp() - v_t0)) * 1000);
    -- Pendencia zero e resultado legitimo, entao a guarda aqui e so a
    -- conferencia -- exigir total > 0 esconderia o caso bom.
    if coalesce((v_payload->'conferencia'->>'fecha')::boolean, false) then
      insert into public.carteira_efetividade_snapshot (bloco, recorte, payload, gerado_em, duracao_ms)
      values ('pendencias_por_motivo', r.recorte, v_payload, now(), v_ms)
      on conflict (bloco, recorte) do update
        set payload = excluded.payload, gerado_em = excluded.gerado_em,
            duracao_ms = excluded.duracao_ms;
      v_feitos := v_feitos || jsonb_build_object('bloco','pendencias_por_motivo','recorte',r.recorte,'ms',v_ms);
    else
      v_feitos := v_feitos || jsonb_build_object('bloco','pendencias_por_motivo','recorte',r.recorte,
                                                 'ms',v_ms,'descartado','conferencia nao fechou');
    end if;

    -- A LISTA INDIVIDUAL NAO E MAIS FOTOGRAFADA. Era aqui que o recalculo
    -- multiplicava passadas pesadas (uma por motivo). Ela e lida ao vivo por
    -- `carteira_pendencias_itens_ler`.
  end loop;

  return jsonb_build_object('gerado_em', now(), 'blocos', v_feitos);
end;
$function$;

comment on function public.carteira_efetividade_recalcular(text) is
  'Reconstroi a camada de leitura da Efetividade chamando as MESMAS funcoes vivas, UMA '
  'vez cada por recorte. Nao fotografa mais a lista individual de pendencias -- era ela '
  'que multiplicava passadas pesadas e fazia a reconstrucao estourar o teto de 2 min do '
  'cron (medido em 08/10/2026). Tem teto interno de 240s e lock consultivo contra '
  'recalculo concorrente. Fotografia que nao fecha a conferencia e descartada, nunca '
  'grava sobre uma boa.';

revoke all on function public.carteira_efetividade_recalcular(text) from public, anon;
grant execute on function public.carteira_efetividade_recalcular(text) to authenticated, service_role;


-- ===========================================================================
-- 2. A LISTA INDIVIDUAL VOLTA A SER LIDA AO VIVO
-- ===========================================================================
-- MESMA assinatura de retorno de antes (17 colunas, mesma ordem e mesmos tipos),
-- para o front nao mudar: a Fila Unica continua chamando
-- `carteira_pendencias_itens_ler` e paginando por `total_no_motivo`. O que muda
-- e a fonte: delega para `carteira_pendencias_itens`, ao vivo, em vez de ler a
-- tabela de fotografia.
--
-- `gerado_em` passa a ser o instante da leitura -- e o que a Fila Unica precisa
-- dizer: a lista e de agora, nao de uma foto antiga.
--
-- O TETO DE 500 POR CHAMADA permanece, e e o de `carteira_pendencias_itens`.
-- `total_no_motivo` vem do bloco agregado (`carteira_pendencias_por_motivo`) e
-- nao de um `count(*) over ()` sobre a pagina, porque a pagina e limitada: contar
-- sobre ela daria o tamanho da pagina, nao do motivo.
create or replace function public.carteira_pendencias_itens_ler(
  p_motivo   text,
  p_ano      text,
  p_semestre text default null,
  p_limite   integer default 50,
  p_offset   integer default 0
)
returns table (
  aluno_id          uuid,
  aluno_nome        text,
  cpf               text,
  titulo_id         uuid,
  documento         text,
  vencimento        date,
  safra             text,
  valor             numeric,
  motivo            text,
  motivo_rotulo     text,
  situacao_titulo   text,
  evidencia         text,
  responsavel_email text,
  desde             timestamptz,
  acao              text,
  gerado_em         timestamptz,
  total_no_motivo   bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_total bigint;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  -- O total do motivo sai do bloco agregado, que ja esta fotografado -- leitura
  -- por chave primaria, barata. Sem fotografia ainda, devolve nulo e a fila
  -- pagina pelo tamanho da pagina.
  select (m->>'titulos')::bigint into v_total
    from public.carteira_efetividade_snapshot s,
         lateral jsonb_array_elements(coalesce(s.payload->'motivos','[]'::jsonb)) m
   where s.bloco = 'pendencias_por_motivo'
     and s.recorte = case when p_ano = '2026'
                          then p_ano || '/' || coalesce(p_semestre,'1') else p_ano end
     and m->>'chave' = p_motivo;

  return query
  select i.aluno_id, i.aluno_nome, i.cpf, i.titulo_id, i.documento, i.vencimento, i.safra,
         i.valor, i.motivo, i.motivo_rotulo, i.situacao_titulo, i.evidencia,
         i.responsavel_email, i.desde, i.acao,
         now()::timestamptz as gerado_em,
         v_total as total_no_motivo
    from public.carteira_pendencias_itens(p_motivo, p_ano, p_semestre, p_limite, p_offset) i;
end;
$function$;

comment on function public.carteira_pendencias_itens_ler(text, text, text, integer, integer) is
  'Lista individual das pendencias, AO VIVO: delega para carteira_pendencias_itens. A '
  'Fila Unica trata caso a caso, e trabalhar sobre fotografia ofereceria para tratamento '
  'um caso que talvez ja esteja resolvido. Mesma assinatura de retorno de quando lia '
  'fotografia, para o front nao mudar; `gerado_em` e o instante da leitura e '
  '`total_no_motivo` vem do bloco agregado, nao da pagina.';

revoke all on function public.carteira_pendencias_itens_ler(text, text, text, integer, integer) from public, anon;
grant execute on function public.carteira_pendencias_itens_ler(text, text, text, integer, integer) to authenticated, service_role;
