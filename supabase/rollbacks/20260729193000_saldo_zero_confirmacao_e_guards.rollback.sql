-- Rollback de 20260729193000_saldo_zero_confirmacao_e_guards.sql
-- Restaura as funcoes ao estado anterior e remove os objetos novos.
BEGIN;

-- Restaura sistema_assumir_atendimento (sem guard de saldo)
CREATE OR REPLACE FUNCTION public.sistema_assumir_atendimento(p_aluno_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'internal'
AS $function$
declare v_email text; v_nome text; v_ant text;
begin
  v_email := lower(coalesce(auth.jwt()->>'email','')); if v_email='' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;
  v_nome := internal.nome_operador_ativo(v_email); if v_nome is null then return jsonb_build_object('ok',false,'erro','NAO_E_OPERADOR_ATIVO'); end if;
  select responsavel_atual_email into v_ant from public.alunos where id=p_aluno_id;
  if v_ant is not null and lower(v_ant)<>v_email then return jsonb_build_object('ok',false,'erro','JA_TEM_RESPONSAVEL'); end if;
  perform internal.set_resp_aluno(p_aluno_id, v_email, v_nome, 'ASSUMIU_ATENDIMENTO', 'Operador assumiu o atendimento. Origem: assumir_atendimento.', v_email, v_nome);
  return jsonb_build_object('ok',true,'aluno_id',p_aluno_id);
end;$function$;

-- Restaura sistema_assumir_receptivo (sem guard de saldo)
CREATE OR REPLACE FUNCTION public.sistema_assumir_receptivo(p_aluno_id uuid, p_status text, p_observacao text, p_data_retorno date DEFAULT NULL::date, p_hora_retorno text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'internal'
AS $function$
declare v_email text; v_nome text;
begin
  v_email := lower(coalesce(auth.jwt()->>'email','')); if v_email='' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;
  v_nome := internal.nome_operador_ativo(v_email); if v_nome is null then return jsonb_build_object('ok',false,'erro','NAO_E_OPERADOR_ATIVO'); end if;
  if coalesce(btrim(p_observacao),'')='' then return jsonb_build_object('ok',false,'erro','OBSERVACAO_OBRIGATORIA'); end if;
  update public.alunos set operador_nome=v_nome, operador_email=v_email, operador=v_nome,
      status_jornada=p_status, status_atual=p_status, status_acionamento=p_status,
      data_retorno=p_data_retorno, hora_retorno=p_hora_retorno, observacao=p_observacao,
      origem='Base receptiva', tipo_base='RECEPTIVA', atualizado_em=now() where id=p_aluno_id;
  perform internal.set_resp_aluno(p_aluno_id, v_email, v_nome, 'ASSUMIU_ATENDIMENTO', 'Assumiu pela Base Receptiva. Origem: assumir_receptivo.', v_email, v_nome);
  return jsonb_build_object('ok',true,'aluno_id',p_aluno_id);
end;$function$;

-- Restaura assumir_atendimento_aluno (sem guard de saldo)
CREATE OR REPLACE FUNCTION public.assumir_atendimento_aluno(p_chave_unificacao text, p_observacao text DEFAULT NULL::text)
 RETURNS TABLE(sucesso boolean, mensagem text) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_email text; v_nome text; v_aluno record; v_pode_reatribuir boolean; v_nome_aluno text; v_cpf text;
begin
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if v_email is null or v_email = '' then return query select false, 'Usuário não identificado. Faça login novamente.'; return; end if;
  v_nome := public.nome_operador_por_email(v_email);
  v_pode_reatribuir := public.pode_reatribuir_atendimento(v_email);
  select * into v_aluno from alunos_unificados where chave_unificacao = p_chave_unificacao limit 1;
  if not found then return query select false, 'Aluno não encontrado.'; return; end if;
  v_nome_aluno := coalesce(to_jsonb(v_aluno)->>'nome_aluno', to_jsonb(v_aluno)->>'nome_referencia', to_jsonb(v_aluno)->>'nome', 'ALUNO SEM NOME');
  v_cpf := coalesce(to_jsonb(v_aluno)->>'cpf_referencia', to_jsonb(v_aluno)->>'cpf', to_jsonb(v_aluno)->>'cpf_mascarado', '-');
  if coalesce(v_aluno.operador_email, '') <> '' and lower(v_aluno.operador_email) <> v_email and not v_pode_reatribuir then
    return query select false, 'Este atendimento já está com ' || coalesce(v_aluno.operador_nome, v_aluno.operador_email) || '.'; return;
  end if;
  update alunos_unificados set operador_nome=v_nome, operador_email=v_email, ultimo_operador_nome=v_nome, ultimo_operador_email=v_email,
    atendimento_assumido_em=now(), ultima_interacao_em=now(), status_atendimento='ASSUMIDO', observacao_operacional=coalesce(p_observacao, observacao_operacional)
  where chave_unificacao = p_chave_unificacao;
  insert into historico_operadores_alunos (aluno_id, chave_unificacao, nome_aluno, cpf_referencia, acao, operador_nome, operador_email, operador_anterior_nome, operador_anterior_email, status_jornada_anterior, status_jornada_novo, data_retorno_anterior, data_retorno_nova, observacao)
  values (null, v_aluno.chave_unificacao, v_nome_aluno, v_cpf,
    case when coalesce(v_aluno.operador_email, '') = '' then 'ASSUMIU_ATENDIMENTO' when lower(coalesce(v_aluno.operador_email, '')) = v_email then 'CONFIRMOU_ATENDIMENTO' else 'REATRIBUIU_ATENDIMENTO' end,
    v_nome, v_email, v_aluno.operador_nome, v_aluno.operador_email, v_aluno.status_jornada, v_aluno.status_jornada, v_aluno.data_retorno, v_aluno.data_retorno, coalesce(p_observacao, 'Atendimento assumido pelo operador.'));
  return query select true, 'Atendimento assumido por ' || v_nome || '.';
end;$function$;

-- Restaura minha_media_vs_equipe (contagem crua)
CREATE OR REPLACE FUNCTION public.minha_media_vs_equipe()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_email text := coalesce(auth.jwt()->>'email',''); v_minha_media numeric; v_media_geral numeric;
BEGIN
  SELECT round(avg(coalesce(total_em_aberto,0))::numeric,2) INTO v_minha_media FROM public.casos WHERE operador_email = v_email;
  SELECT round(avg(coalesce(total_em_aberto,0))::numeric,2) INTO v_media_geral FROM public.casos WHERE operador_email IS NOT NULL AND operador_email <> 'amanda.seibel@aelbra.com.br';
  RETURN jsonb_build_object('minha_media', COALESCE(v_minha_media, 0), 'media_geral', COALESCE(v_media_geral, 0), 'abaixo_da_media', COALESCE(v_minha_media, 0) < COALESCE(v_media_geral, 0) * 0.85);
END;$function$;

-- Restaura assumir_caso_livre_aluno (contagem crua dos 500)
CREATE OR REPLACE FUNCTION public.assumir_caso_livre_aluno(p_aluno_id uuid)
 RETURNS TABLE(sucesso boolean, mensagem text, caso_assumido uuid, caso_liberado uuid)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_email text; v_nome text; v_upper text;
  v_new record; v_new_saldo numeric; v_new_faixa int; v_count int; v_rel record;
begin
  v_email := lower(coalesce(auth.jwt() ->> 'email','')); if v_email='' then return query select false,'Usuario nao identificado.',null::uuid,null::uuid; return; end if;
  v_nome := public.nome_operador_por_email(v_email); if v_nome is null then return query select false,'Operador nao ativo.',null::uuid,null::uuid; return; end if;
  v_upper := upper(v_nome);
  select c.*, public.saldo_titulos_aberto(c.cpf_limpo) AS _s into v_new from public.casos c
  where c.aluno_id = p_aluno_id and c.operador_email is null
    and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
    and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)
    and public.saldo_titulos_aberto(c.cpf_limpo) > 0
  order by public.saldo_titulos_aberto(c.cpf_limpo) desc limit 1;
  if not found then
    if exists (select 1 from public.casos c where c.aluno_id=p_aluno_id and coalesce(c.operador_email,'')<>'') then
      return query select false,'Este caso ja foi assumido por outro operador.',null::uuid,null::uuid; return; end if;
    return query select false,'Nenhum caso livre elegivel para este aluno.',null::uuid,null::uuid; return;
  end if;
  v_new_saldo := v_new._s;
  v_new_faixa := case when v_new_saldo>10000 then 1 when v_new_saldo>5000 then 2 when v_new_saldo>3000 then 3 else 4 end;
  v_count := (select count(*) from public.casos where operador_email = v_email);
  if v_count >= 500 then
    select c.id, c.aluno_id, c.cpf_limpo into v_rel from public.casos c
    where c.operador_email = v_email and c.ultima_tabulacao_em is null
      and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
      and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)
    order by (case when (case when public.saldo_titulos_aberto(c.cpf_limpo)>10000 then 1 when public.saldo_titulos_aberto(c.cpf_limpo)>5000 then 2 when public.saldo_titulos_aberto(c.cpf_limpo)>3000 then 3 else 4 end)=v_new_faixa then 0 else 1 end) asc,
             abs(public.saldo_titulos_aberto(c.cpf_limpo)-v_new_saldo) asc, c.caso_atualizado_em desc nulls last limit 1;
    if v_rel.id is null then return query select false,'Carteira cheia (500) e nenhum caso livre para trocar. Assuncao nao realizada.',null::uuid,null::uuid; return; end if;
    update public.casos set operador_email=null, operador_nome=null, operador=null, data_retorno=null, data_retorno_nova=null, hora_retorno=null, proxima_acao_automatica=null where id = v_rel.id;
    update public.operador_agenda set status='CANCELADO_LIBERACAO', atualizado_em=now() where operador_email = v_email and aluno_id = v_rel.aluno_id and coalesce(status,'') not in ('CONCLUIDO','CANCELADO','CANCELADO_LIBERACAO');
    insert into public.historico_operadores_alunos (chave_unificacao,nome_aluno,cpf_referencia,acao,operador_anterior_nome,operador_anterior_email,observacao,criado_em)
    select chave_unificacao,nome,cpf,'LIBERACAO_TROCA_ASSUMIR',v_nome,v_email,'Liberado por troca ao assumir aluno '||p_aluno_id::text||'; agendamento de retorno cancelado. Origem: ASSUMIR_ATENDIMENTO.',now() from public.casos where id = v_rel.id;
  end if;
  update public.casos set operador_email=v_email, operador_nome=v_nome, operador=v_upper, caso_atualizado_por=v_email, caso_atualizado_em=now() where id = v_new.id;
  insert into public.historico_operadores_alunos (chave_unificacao,nome_aluno,cpf_referencia,acao,operador_nome,operador_email,observacao,criado_em)
  select chave_unificacao,nome,cpf,'ASSUMIR_ATENDIMENTO',v_nome,v_email,
    case when v_count>=500 then 'Assumido com troca (liberado '||v_rel.id::text||'). Fidelizacao 10 dias. Origem: ASSUMIR_ATENDIMENTO.' else 'Assumido caso livre. Fidelizacao 10 dias. Origem: ASSUMIR_ATENDIMENTO.' end, now()
  from public.casos where id = v_new.id;
  if (select count(*) from public.casos where operador_email = v_email) > 500 then raise exception 'ROLLBACK: operador ficaria com mais de 500 casos.'; end if;
  return query select true, case when v_count>=500 then 'Atendimento assumido (troca): liberado 1 caso e cancelado seu retorno; mantidos 500.' else 'Atendimento assumido.' end,
    v_new.id, (case when v_count>=500 then v_rel.id else null::uuid end);
end;$function$;

DROP FUNCTION IF EXISTS public.contar_carteira_ativa(text);
DROP FUNCTION IF EXISTS internal.encaminhar_saldo_zerado_confirmacao(uuid);
DROP INDEX IF EXISTS public.uq_solic_saldo_zerado_aberto;

COMMIT;
