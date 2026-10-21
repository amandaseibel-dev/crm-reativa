-- ROLLBACK de 20261020230350_assumir_caso_livre_teto_oficial_e_tres_carteiras.sql
--
-- SO DDL, SO uma funcao. Nenhuma tabela, nenhum gatilho, nenhum agendamento,
-- nenhum dado -- nao ha dado a restaurar. O corpo abaixo e o que estava em
-- producao em 20/10/2026, `pg_get_functiondef` palavra por palavra,
-- md5(prosrc) = ae50c7d6476ddb0059211d20dd15889e.
--
-- ATENCAO: este rollback REINTRODUZ os dois defeitos medidos.
--   1. O teto volta a ser 500 literal sobre a base errada (~1.000 casos por
--      operador em 20/10): "Assumir atendimento" volta a falhar para todos os
--      sete operadores.
--   2. As tres carteiras de livre assuncao voltam a ser inassumiveis -- 595
--      casos (371 Carteira Geral + 118 gestao + 106 Olga) voltam a responder
--      "Este caso ja foi assumido por outro operador".
-- Nada precisa ser desagendado para reverter: o estado anterior e o de hoje.
--
-- Reverter em bloco, por CREATE OR REPLACE, e nao por patch ancorado reverso:
-- os seis patches sao encadeados, e desfazer um a um deixaria a funcao em
-- estado intermediario se um deles falhasse.
--
-- NAO TOCADO por esta migration e portanto sem reversao:
--   caso_protegido_redistribuicao, caso_encerrado_operacional,
--   caso_aguarda_confirmacao_financeira, saldo_titulos_aberto,
--   caso_em_giro_fidelizacao, calibragem_teto_operador,
--   internal.operador_pode_receber_caso, internal.carteira_geral_email,
--   trg_impor_teto_operador, trg_repor_caso_operador, os gatilhos de `casos`,
--   `acordos` e a titularidade financeira.

CREATE OR REPLACE FUNCTION public.assumir_caso_livre(p_caso_id uuid)
 RETURNS TABLE(sucesso boolean, mensagem text, caso_liberado uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal'
AS $function$
declare
  v_email text; v_nome text; v_upper text; v_new record; v_new_saldo numeric; v_count int;
  v_rel record; v_liberado uuid := null;
begin
  v_email := lower(coalesce(auth.jwt() ->> 'email',''));
  if v_email = '' then return query select false,'Usuario nao identificado. Faca login novamente.',null::uuid; return; end if;
  v_nome := public.nome_operador_por_email(v_email);
  if v_nome is null then return query select false,'Operador nao ativo ou nao identificado.',null::uuid; return; end if;
  if not internal.operador_pode_receber_caso(v_email) then return query select false,'Sua carteira esta fechada para casos novos. Fale com a gestao.',null::uuid; return; end if;
  v_upper := upper(v_nome);
  select c.*, public.saldo_titulos_aberto(c.cpf_limpo) AS _saldo into v_new
    from public.casos c where c.id = p_caso_id for update;
  if not found then return query select false,'Caso nao encontrado.',null::uuid; return; end if;
  if coalesce(v_new.operador_email,'') <> '' then
    if public.caso_em_giro_fidelizacao(v_new.giro_fidelizacao_ate) then
      return query select false,'Este caso está fidelizado pelo giro de carteira até 26/10/2026.',null::uuid; return;
    end if;
    if v_new.giro_fidelizacao_ate is null then
      return query select false,'Este caso ja foi assumido por outro operador.',null::uuid; return;
    end if;
    -- Caso de giro com a fidelizacao ja vencida: segue adiante e troca o dono.
  end if;
  if public.caso_protegido_redistribuicao(v_new.cpf_limpo,v_new.status_acionamento,v_new.nao_acionar,v_new.status_financeiro,v_new.valor_pago,v_new.quitado_em,v_new.valor_quitado)
     or public.caso_encerrado_operacional(v_new.cpf_limpo,v_new.status_atual,v_new.status_acionamento,v_new.status_financeiro,v_new.status_jornada)
     or coalesce(v_new._saldo,0) <= 0 then
    return query select false,'Caso nao elegivel (protegido, encerrado ou sem saldo).',null::uuid; return;
  end if;
  v_new_saldo := v_new._saldo;
  v_count := (select count(*) from public.casos where operador_email = v_email
                 and not public.caso_aguarda_confirmacao_financeira(aluno_id));
  if v_count >= 500 then
    select c.id into v_rel from public.casos c
    where c.operador_email = v_email and c.ultima_tabulacao_em is null
      and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
      and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)
    order by abs(public.saldo_titulos_aberto(c.cpf_limpo) - v_new_saldo) asc, c.caso_atualizado_em desc nulls last
    limit 1 for update skip locked;
    if v_rel.id is null then
      return query select false,'Carteira cheia (500) e nenhum caso livre para trocar. Assuncao nao realizada.',null::uuid; return;
    end if;
    v_liberado := v_rel.id;
    update public.casos set operador_email=null, operador_nome=null, operador=null where id = v_liberado;
    insert into public.historico_operadores_alunos (chave_unificacao,nome_aluno,cpf_referencia,acao,operador_anterior_nome,operador_anterior_email,observacao,criado_em)
    select chave_unificacao,nome,cpf,'LIBERACAO_TROCA_ASSUMIR',v_nome,v_email,'Liberado por troca ao assumir caso '||p_caso_id::text||'.',now()
    from public.casos where id = v_liberado;
  end if;
  update public.casos set operador_email=v_email, operador_nome=v_nome, operador=v_upper,
    caso_atualizado_por=v_email, caso_atualizado_em=now()
  where id = p_caso_id;
  insert into public.historico_operadores_alunos (chave_unificacao,nome_aluno,cpf_referencia,acao,operador_nome,operador_email,observacao,criado_em)
  select chave_unificacao,nome,cpf,'ASSUMIR_ATENDIMENTO',v_nome,v_email,
    'Assumido caso livre. assumido_por='||v_email||' assumido_em='||now()::text||'. Fidelizacao inicia apenas apos acionamento valido.', now()
  from public.casos where id = p_caso_id;
  if (select count(*) from public.casos where operador_email = v_email
                 and not public.caso_aguarda_confirmacao_financeira(aluno_id)) > 500 then
    raise exception 'ROLLBACK: operador ficaria com mais de 500 casos.';
  end if;
  return query select true, 'Atendimento assumido. Acione dentro do prazo operacional para iniciar a fidelizacao de 10 dias.', v_liberado;
end;
$function$;
