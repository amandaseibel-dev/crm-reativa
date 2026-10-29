-- =============================================================================
-- projecao_snapshot_pagamentos_ler passa a retornar tambem as SOMAS do filtro
-- (soma_pago, soma_honorario, qtd_total) alem da pagina -> permite ao modal
-- exibir "Valores conferem/Divergencia" comparando com o ponto do grafico,
-- sem precisar baixar todas as paginas. Escopo/seguranca inalterados.
-- =============================================================================
create or replace function public.projecao_snapshot_pagamentos_ler(
  p_mes text, p_dia date, p_operador_email text, p_limit int default 50, p_offset int default 0)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_email text := lower(auth.email());
  v_e_gestao boolean := v_email in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br');
  v_equipe text[] := ARRAY[
    'cobranca03@aelbra.com.br','cobranca05@aelbra.com.br','cobranca06@aelbra.com.br',
    'cobranca08@aelbra.com.br','cobranca10@aelbra.com.br','cobranca11@aelbra.com.br',
    'cobranca13@aelbra.com.br','cobranca12@aelbra.com.br','cobranca07@aelbra.com.br'];
  v_alvo text;
  v_lim int := least(greatest(coalesce(p_limit,50),1),200);
  v_off int := greatest(coalesce(p_offset,0),0);
  v_total int; v_itens jsonb; v_pago numeric; v_hon numeric;
begin
  if coalesce(auth.role(),'') <> 'service_role' and public.perfil_do_usuario_atual() is null then
    raise exception 'Acesso negado: requer usuario autenticado e cadastro ativo.' using errcode = '42501';
  end if;

  if v_e_gestao then
    v_alvo := lower(coalesce(p_operador_email,''));
    if v_alvo = 'sem_operador' then v_alvo := 'SEM_OPERADOR'; end if;
    if not (v_alvo = any(v_equipe) or v_alvo = 'SEM_OPERADOR') then
      raise exception 'Operador invalido para detalhe.' using errcode = '22023';
    end if;
  else
    if not (v_email = any(v_equipe)) then
      raise exception 'Sem acesso ao detalhe de pagamentos.' using errcode = '42501';
    end if;
    v_alvo := v_email;
  end if;

  select count(*), coalesce(round(sum(valor_pago),2),0), coalesce(round(sum(valor_honorario),2),0)
    into v_total, v_pago, v_hon
  from public.projecao_snapshot_pagamentos
   where mes_referencia=p_mes and operador_email=v_alvo and (p_dia is null or data_pagamento=p_dia);

  select coalesce(jsonb_agg(t order by t.data_pagamento, t.pagamento_id), '[]'::jsonb) into v_itens
  from (
    select pagamento_id, data_pagamento, aluno_nome, valor_pago, valor_honorario,
           importacao_id, operador_email, operador_ajustado_manualmente
    from public.projecao_snapshot_pagamentos
    where mes_referencia=p_mes and operador_email=v_alvo and (p_dia is null or data_pagamento=p_dia)
    order by data_pagamento, pagamento_id
    limit v_lim offset v_off
  ) t;

  return jsonb_build_object(
    'mes_referencia', p_mes, 'operador_email', v_alvo, 'data_pagamento', p_dia,
    'total', v_total, 'soma_pago', v_pago, 'soma_honorario', v_hon,
    'limit', v_lim, 'offset', v_off, 'itens', v_itens);
end;
$function$;

revoke all on function public.projecao_snapshot_pagamentos_ler(text,date,text,int,int) from public, anon;
grant execute on function public.projecao_snapshot_pagamentos_ler(text,date,text,int,int) to authenticated, service_role;
