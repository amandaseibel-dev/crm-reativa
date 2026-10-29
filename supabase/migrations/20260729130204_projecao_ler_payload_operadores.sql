-- =============================================================================
-- Gestao (Amanda/Fernanda): a lista "operadores" do snapshot_ler passa a incluir
-- o PAYLOAD completo de cada um dos 9 -> permite renderizar a MESMA visao
-- individual (hero + evolucao diaria + faixa/proxima faixa) de qualquer operador
-- sem round-trip extra e sem consultar public.pagamentos.
-- Nao-gestao inalterado (so o proprio). SEM_OPERADOR segue em bloco separado.
-- =============================================================================
create or replace function public.projecao_snapshot_ler(p_mes text)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_email text := lower(auth.email());
  v_e_gestao boolean := v_email in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br');
  v_filial public.projecao_snapshot%rowtype;
  v_own public.projecao_snapshot%rowtype;
  v_ops jsonb; v_sem jsonb;
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
      'e_gestao', true, 'dados', v_filial.payload, 'operadores', v_ops, 'sem_operador', v_sem);
  end if;

  select * into v_own from public.projecao_snapshot
   where escopo='OPERADOR' and mes_referencia=p_mes and operador_email = v_email and operador_email = any(v_equipe);

  return jsonb_build_object(
    'status', v_filial.status, 'mes_referencia', p_mes,
    'atualizado_em', v_filial.atualizado_em, 'atualizado_por', v_filial.atualizado_por,
    'duracao_ms', v_filial.duracao_ms, 'erro_resumo', v_filial.erro_resumo,
    'e_gestao', false,
    'dados', case when found then v_own.payload else null end,
    'operadores', '[]'::jsonb, 'sem_operador', null);
end;
$function$;

revoke all on function public.projecao_snapshot_ler(text) from public, anon;
grant execute on function public.projecao_snapshot_ler(text) to authenticated, service_role;
