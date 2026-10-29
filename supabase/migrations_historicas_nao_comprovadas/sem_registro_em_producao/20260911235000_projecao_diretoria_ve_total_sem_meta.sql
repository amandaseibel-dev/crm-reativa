-- ============================================================================
-- PROJEÇÃO HORA A HORA — a Diretoria passa a ver o total da operação
-- ----------------------------------------------------------------------------
-- PROBLEMA (medido em PROD 11/09/2026): abrir a rota para o perfil `diretoria`
-- não bastava. `projecao_snapshot_ler` só devolvia payload em dois casos —
-- gestão (Amanda/Fernanda) recebia a FILIAL, operador da equipe recebia o
-- próprio. Angela e Gustavo não são nem um nem outro, então `dados` voltava
-- null e a tela exibia "Os dados ainda não foram atualizados pela gestão",
-- que é falso: o snapshot existe, eles é que não tinham direito a ele.
--
-- REGRA DA AMANDA: "deixa só a visualização, não ter acesso a meta — apenas o
-- dashboard e ano vs ano", "visão geral hora a hora".
--
-- POR QUE ALLOWLIST E NÃO LISTA DE EXCLUSÃO: o payload da filial é montado por
-- outra função (projecao_calcular_filial) e ganha campos com o tempo. Com lista
-- de exclusão, todo campo novo vazaria por omissão. Com allowlist, campo novo
-- só chega à diretoria quando alguém escrever o nome dele aqui, de propósito.
--
-- FICA DE FORA, de propósito: meta_honorario, meta_recuperacao, percentual_meta
-- e percentual_meta_filial, valor_restante_meta, media_diaria_necessaria,
-- config_metas, percentual_projecao_filial (é "% da meta"), ranking_equipe e
-- maior_pagamento_individual (desempenho nominal por operador) e qualquer campo
-- de comissão. Nada disso sai do banco para esse perfil.
--
-- `e_gestao` continua FALSO para a diretoria — é ele que segura, no front e no
-- backend, o botão de atualizar, a aba Por Operador, a importação e o painel de
-- configuração de metas. O flag novo `e_diretoria` diz só: "pode ver o
-- consolidado da empresa".
--
-- Provado em PROD com JWT simulado: Gustavo recebe honorário/recuperado da
-- empresa e o histórico dia a dia, com e_gestao=false e zero campos de
-- meta/ranking/comissão; Amanda continua recebendo o payload completo com meta
-- e a lista dos 9 operadores.
--
-- Só leitura. Reversível: reaplicar a versão anterior da função.
-- ============================================================================
create or replace function public.projecao_snapshot_ler(p_mes text)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_email text := lower(auth.email());
  v_e_gestao boolean := v_email in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br');
  v_e_diretoria boolean := coalesce(public.usuario_e_diretoria(), false);
  v_filial public.projecao_snapshot%rowtype;
  v_own public.projecao_snapshot%rowtype;
  v_ops jsonb; v_sem jsonb; v_dir jsonb;
  -- O que a diretoria pode ver do consolidado. ALLOWLIST: nada fora daqui sai.
  v_campos_diretoria text[] := ARRAY[
    'mes_referencia',
    'acumulado_mes_filial','recuperado_reativa_mes',
    'recuperado_hoje_filial','recuperado_reativa_hoje',
    'honorario_mes_filial','honorario_hoje_filial','honorario_hoje',
    'qtd_pagamentos_hoje_filial',
    'dias_uteis_passados','dias_uteis_restantes','dias_uteis_total_mes',
    'projecao_honorario_filial',
    'historico_dia_a_dia'];
  v_equipe text[] := ARRAY[
    'cobranca03@aelbra.com.br','cobranca05@aelbra.com.br','cobranca06@aelbra.com.br',
    'cobranca08@aelbra.com.br','cobranca10@aelbra.com.br','cobranca11@aelbra.com.br',
    'cobranca13@aelbra.com.br','cobranca12@aelbra.com.br','cobranca07@aelbra.com.br'];
begin
  if coalesce(auth.role(),'') <> 'service_role' and public.perfil_do_usuario_atual() is null then
    raise exception 'Acesso negado: requer usuario autenticado e cadastro ativo.' using errcode = '42501';
  end if;

  select * into v_filial from public.projecao_snapshot where escopo='FILIAL' and mes_referencia=p_mes and operador_email='';
  if not found then
    return jsonb_build_object('status','vazio','mes_referencia',p_mes,'e_gestao',v_e_gestao,
      'e_diretoria', v_e_diretoria,
      'dados',null,'operadores','[]'::jsonb,'sem_operador',null,
      'atualizado_em',null,'atualizado_por',null,'duracao_ms',null,'erro_resumo',null);
  end if;

  if v_e_gestao then
    select coalesce(jsonb_agg(jsonb_build_object(
              'operador_email', operador_email,
              'operador_nome', payload->>'operador_nome',
              'honorario_mes', (payload->>'honorario_mes')::numeric,
              'faixa_atual', payload->>'faixa_atual',
              'comissao_estimada_individual', (payload->>'comissao_estimada_individual')::numeric,
              'projecao', (payload->>'projecao_honorario_individual')::numeric,
              'percentual_projecao', (payload->>'percentual_projecao_individual')::numeric,
              'payload', payload
            ) order by (payload->>'honorario_mes')::numeric desc), '[]'::jsonb)
      into v_ops
    from public.projecao_snapshot
    where escopo='OPERADOR' and mes_referencia=p_mes and operador_email = any(v_equipe);

    select payload into v_sem from public.projecao_snapshot
     where escopo='OPERADOR' and mes_referencia=p_mes and operador_email='SEM_OPERADOR';

    return jsonb_build_object(
      'status', v_filial.status, 'mes_referencia', p_mes,
      'atualizado_em', v_filial.atualizado_em, 'atualizado_por', v_filial.atualizado_por,
      'duracao_ms', v_filial.duracao_ms, 'erro_resumo', v_filial.erro_resumo,
      'e_gestao', true, 'e_diretoria', v_e_diretoria,
      'dados', v_filial.payload, 'operadores', v_ops, 'sem_operador', v_sem);
  end if;

  -- DIRETORIA: consolidado da empresa, so os campos da allowlist. Sem meta,
  -- sem ranking, sem nada nominal de operador. e_gestao segue falso.
  if v_e_diretoria then
    select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_dir
      from jsonb_each(v_filial.payload) e(k, v)
     where k = any(v_campos_diretoria);

    return jsonb_build_object(
      'status', v_filial.status, 'mes_referencia', p_mes,
      'atualizado_em', v_filial.atualizado_em, 'atualizado_por', v_filial.atualizado_por,
      'duracao_ms', v_filial.duracao_ms, 'erro_resumo', v_filial.erro_resumo,
      'e_gestao', false, 'e_diretoria', true,
      'dados', v_dir, 'operadores', '[]'::jsonb, 'sem_operador', null);
  end if;

  select * into v_own from public.projecao_snapshot
   where escopo='OPERADOR' and mes_referencia=p_mes and operador_email = v_email and operador_email = any(v_equipe);

  return jsonb_build_object(
    'status', v_filial.status, 'mes_referencia', p_mes,
    'atualizado_em', v_filial.atualizado_em, 'atualizado_por', v_filial.atualizado_por,
    'duracao_ms', v_filial.duracao_ms, 'erro_resumo', v_filial.erro_resumo,
    'e_gestao', false, 'e_diretoria', false,
    'dados', case when found then v_own.payload else null end,
    'operadores', '[]'::jsonb, 'sem_operador', null);
end;
$function$;

-- A allowlist tem que segurar: se um campo de meta/ranking/comissão chegar à
-- diretoria, esta migration falha em vez de vazar em silêncio.
do $$
declare g jsonb; a jsonb; proibido text;
begin
  perform set_config('request.jwt.claims',
    '{"email":"gustavo.ene@aelbra.com.br","role":"authenticated"}', true);
  g := public.projecao_snapshot_ler(to_char(current_date, 'YYYY-MM'));

  if coalesce(g->>'e_diretoria','') <> 'true' then raise exception 'diretoria nao reconhecida'; end if;
  if coalesce(g->>'e_gestao','') <> 'false' then raise exception 'diretoria com e_gestao verdadeiro'; end if;
  if g->'dados' is null or g->'dados' = 'null'::jsonb then raise exception 'diretoria sem dados'; end if;
  if jsonb_array_length(g->'operadores') <> 0 then raise exception 'diretoria recebeu operadores'; end if;

  select string_agg(k, ', ') into proibido
    from jsonb_object_keys(g->'dados') k
   where k like '%meta%' or k like '%ranking%' or k like '%comissao%' or k like '%individual%';
  if proibido is not null then raise exception 'vazou para a diretoria: %', proibido; end if;

  perform set_config('request.jwt.claims',
    '{"email":"amanda.seibel@aelbra.com.br","role":"authenticated"}', true);
  a := public.projecao_snapshot_ler(to_char(current_date, 'YYYY-MM'));
  if coalesce(a->>'e_gestao','') <> 'true' then raise exception 'a gestao perdeu e_gestao'; end if;
  if (a->'dados'->>'meta_honorario') is null then raise exception 'a gestao perdeu a meta'; end if;
  if jsonb_array_length(a->'operadores') = 0 then raise exception 'a gestao perdeu os operadores'; end if;
end $$;
